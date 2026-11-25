/**
 * Human-in-the-loop timing and routing (D44 phase 3), around the interrupt machinery in
 * `interrupts.ts`:
 *
 * - **Timing** (`askTiming`): an ask's deadline is the agent's `meta.hitl.timeout`, capped at
 *   `AGENT_INTERRUPT_TIMEOUT` (the Workflow's own wait); its reminder is `meta.hitl.remindAfter`
 *   after it was raised. The sweeper sends the ONE reminder (`sendDueReminders`) and settles
 *   expired parks (`expireParkedRun` in `runs.ts`), which is where `onTimeout` applies.
 * - **Routing** (`recipientsFor`, `canAnswerAsk`, `assignedToSql`): an ask that names
 *   `assignees` goes to them — users, and the members of visibility groups — and they may see its
 *   run and answer it. An owner or admin may always answer too, so an ask whose assignees have all
 *   left is never stuck. An ask with no assignees follows the agent's `approvers`, as before.
 *
 * `onTimeout: 'reject'` answers an expired ask as a REJECTION (`cancelled`, a note saying nobody
 * answered) and wakes the run, exactly as if a person had said no. Never approve-by-default.
 */
import type { AgentHitl } from '@rocketflare/shared/ai/agents'
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import {
  type AgentRunInterruptRow,
  agentRunInterrupts,
  groupMembers,
  tenantUsers,
} from '../../../db/schema'
import { notifyMany } from '../notifications'
import type { Realtime } from '../realtime'
import { ASK_NOTIFICATION_TYPE, parseDurationMs } from './interrupts'

/** The note an ask rejected by its deadline carries — what the agent and the timeline read. */
export const TIMEOUT_REJECTION_NOTE = 'Nobody answered before the deadline'

/** When an ask raised `now` expires and when its assignees are reminded. */
export function askTiming(
  cfg: Pick<AppConfig, 'AGENT_INTERRUPT_TIMEOUT'>,
  hitl: AgentHitl | undefined,
  now = new Date()
): { expiresAt: Date | null; remindAt: Date | null } {
  const ceiling = parseDurationMs(cfg.AGENT_INTERRUPT_TIMEOUT)
  const own = hitl?.timeout ? parseDurationMs(hitl.timeout) : null
  const timeout = own !== null && ceiling !== null ? Math.min(own, ceiling) : (own ?? ceiling)
  const remind = hitl?.remindAfter ? parseDurationMs(hitl.remindAfter) : null
  const expiresAt = timeout === null ? null : new Date(now.getTime() + timeout)
  // A reminder due after the deadline would remind nobody of anything.
  const remindAt =
    remind === null || (timeout !== null && remind >= timeout)
      ? null
      : new Date(now.getTime() + remind)
  return { expiresAt, remindAt }
}

function hasAssignees(ask: Pick<AgentRunInterruptRow, 'assigneeUserIds' | 'assigneeGroupIds'>) {
  return ask.assigneeUserIds.length > 0 || ask.assigneeGroupIds.length > 0
}

/** The members of the ask's groups who belong to the tenant, plus its named users who do. */
async function assigneeIds(db: Database, ask: AgentRunInterruptRow): Promise<string[]> {
  const fromGroups = ask.assigneeGroupIds.length
    ? await db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.tenantId, ask.tenantId),
            inArray(groupMembers.groupId, ask.assigneeGroupIds)
          )
        )
    : []
  const candidates = [...new Set([...ask.assigneeUserIds, ...fromGroups.map(r => r.userId)])]
  if (candidates.length === 0) return []
  // A named user who is not (or no longer) a member of the tenant is told nothing about it.
  const members = await db
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.tenantId, ask.tenantId), inArray(tenantUsers.userId, candidates)))
  return members.map(m => m.userId)
}

async function tenantAdmins(db: Database, tenantId: string): Promise<string[]> {
  const admins = await db
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.tenantId, tenantId), sql`${tenantUsers.role} IN ('owner', 'admin')`))
  return admins.map(a => a.userId)
}

/**
 * Who is told about an ask: its assignees when it names any (falling back to the tenant's admins
 * when none of them is still a member), else the requester under `approvers: 'requester'`, else
 * the admins. **A parked run nobody is told about is a hung agent**, so no branch returns nobody
 * while the tenant has an admin.
 */
export async function recipientsFor(
  db: Database,
  run: { tenantId: string; requestedByUserId: string | null },
  approvers: 'requester' | 'admin',
  ask: AgentRunInterruptRow
): Promise<string[]> {
  if (hasAssignees(ask)) {
    const assigned = await assigneeIds(db, ask)
    return assigned.length > 0 ? assigned : tenantAdmins(db, run.tenantId)
  }
  if (approvers === 'requester' && run.requestedByUserId) return [run.requestedByUserId]
  return tenantAdmins(db, run.tenantId)
}

/** Tell the people who can answer that a run is waiting on them (`reminder` for the second time). */
export async function notifyApprovers(
  db: Database,
  run: { tenantId: string; id: string; requestedByUserId: string | null },
  agentTitle: string,
  approvers: 'requester' | 'admin',
  ask: AgentRunInterruptRow,
  realtime: Realtime | undefined,
  options: { reminder?: boolean } = {}
): Promise<void> {
  const recipients = await recipientsFor(db, run, approvers, ask)
  await notifyMany(
    db,
    recipients,
    {
      tenantId: run.tenantId,
      type: ASK_NOTIFICATION_TYPE,
      title: options.reminder
        ? `Reminder: ${agentTitle} is still waiting for your decision`
        : `${agentTitle} needs your decision`,
      body: ask.message,
      // The run id is what the bell deep-links to: the question is answered on the run page, in
      // front of the timeline that explains why it is being asked.
      data: { runId: run.id, interruptId: ask.id, ...(options.reminder && { reminder: true }) },
    },
    realtime
  )
}

/**
 * May this caller answer this ask? An assigned ask: an assignee, or an owner/admin. Otherwise the
 * agent's own rule (`fallback`, the route's `canAnswer`).
 */
export async function canAnswerAsk(
  db: Database,
  user: { id: string; isAdminLevel: boolean },
  ask: AgentRunInterruptRow,
  fallback: () => boolean
): Promise<boolean> {
  if (!hasAssignees(ask)) return fallback()
  if (user.isAdminLevel) return true
  return (await assigneeIds(db, ask)).includes(user.id)
}

/**
 * SQL: the interrupt row is assigned to `userId` — named, or through a group they are in. What
 * the inbox and run visibility OR into their member predicate.
 */
export function assignedToSql(tenantId: string, userId: string): SQL {
  return sql`(${userId}::uuid = ANY(${agentRunInterrupts.assigneeUserIds}) OR ${agentRunInterrupts.assigneeGroupIds} && ARRAY(SELECT ${groupMembers.groupId} FROM ${groupMembers} WHERE ${groupMembers.tenantId} = ${tenantId} AND ${groupMembers.userId} = ${userId}))`
}

/** `true` when some ask of this run is assigned to `userId` — they may then see the run. */
export async function runAssignedTo(
  db: Database,
  tenantId: string,
  runId: string,
  userId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: agentRunInterrupts.id })
    .from(agentRunInterrupts)
    .where(
      and(
        eq(agentRunInterrupts.tenantId, tenantId),
        eq(agentRunInterrupts.runId, runId),
        assignedToSql(tenantId, userId)
      )
    )
    .limit(1)
  return row !== undefined
}

/** Mark the reminder sent — compare-and-set, so two sweeps never remind twice. */
export async function claimReminder(db: Database, ask: AgentRunInterruptRow): Promise<boolean> {
  const [row] = await db
    .update(agentRunInterrupts)
    .set({ remindedAt: new Date() })
    .where(
      and(
        eq(agentRunInterrupts.id, ask.id),
        eq(agentRunInterrupts.tenantId, ask.tenantId),
        eq(agentRunInterrupts.status, 'pending'),
        sql`${agentRunInterrupts.remindedAt} IS NULL`
      )
    )
    .returning({ id: agentRunInterrupts.id })
  return row !== undefined
}

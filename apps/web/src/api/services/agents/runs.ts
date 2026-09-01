/**
 * `agent_runs` lifecycle service (D7 — the pg-boss → Workflows handoff, 09 §4.5 / 05 §1.3):
 *   enqueueRun  — validate input → insert `queued` (the partial unique index rejects a second
 *                 active run for the agent → return the existing one, `deduplicated`) →
 *                 `AGENT_RUN_WORKFLOW.create({ id: runId })` → store `instanceId`. No binding →
 *                 `AgentRunsNotConfiguredError` (503) BEFORE any write.
 *   claimRun    — `UPDATE … SET running, attempt+1 WHERE status IN (queued,running) RETURNING`:
 *                 the row is the idempotency gate; a retried step re-claims, a settled row is a no-op.
 *   requestCancel — queued → `cancelled` outright; running → `cancelRequestedAt` (the run polls).
 *   reconcileRun — on read: an active row whose instance is `not_found|errored|terminated|complete`
 *                 is stale → settle it. `not_found` is an ANSWER, not an error; no binding → no-op.
 *   appendEvent — durable progress row + `entity.changed { entity: 'agent-run' }` nudge (D8).
 * Every query carries the tenant predicate; `runId` alone is never trusted.
 */
import type {
  AgentKey,
  AgentRun,
  AgentRunEvent,
  AgentRunEventType,
} from '@rocketflare/shared/ai/agents'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type AgentRunEventRow,
  type AgentRunRow,
  agentRunEvents,
  agentRuns,
} from '../../../db/schema'
import { ServiceUnavailableError, ValidationError } from '../../utils/core/errors'
import { nudge, type Realtime, realtimeEvent } from '../realtime'
import { getAgent } from './registry'

/** `{ runId, tenantId }` — everything else is re-read from the row (a retry must not trust a message). */
export interface AgentRunParams {
  runId: string
  tenantId: string
}

/** The slice of the `Workflow` binding the service uses; the test `RecordingWorkflow` satisfies it. */
export interface AgentRunWorkflowBinding {
  create(options: { id: string; params: AgentRunParams }): Promise<{ id: string }>
  get(id: string): Promise<{
    status(): Promise<{ status: string; error?: { name: string; message: string } }>
  }>
}

export interface AgentRunsEnv {
  AGENT_RUN_WORKFLOW?: AgentRunWorkflowBinding
}

/** 503 `agent_runs_not_configured`: the Workflow binding is missing from the toml. */
export class AgentRunsNotConfiguredError extends ServiceUnavailableError {
  constructor() {
    super(
      'Agent runs are not configured: add [[workflows]] binding = "AGENT_RUN_WORKFLOW" to apps/web/wrangler*.toml and run `pnpm types`',
      ERROR_CODES.agentRunsNotConfigured
    )
    this.name = 'AgentRunsNotConfiguredError'
  }
}

/** Thrown inside a run when `cancelRequestedAt` is set. A TYPE, so no message can reclassify it. */
export class AgentCancelledError extends Error {
  constructor() {
    super('Agent run cancelled')
    this.name = 'AgentCancelledError'
  }
}

export function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentKey: row.agentKey,
    status: row.status,
    input: row.input,
    output: row.output ?? null,
    error: row.error,
    requestedByUserId: row.requestedByUserId,
    instanceId: row.instanceId,
    attempt: row.attempt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    cancelRequestedAt: row.cancelRequestedAt,
    createdAt: row.createdAt,
  }
}

export function toAgentRunEvent(row: AgentRunEventRow): AgentRunEvent {
  return { id: row.id, runId: row.runId, seq: row.seq, type: row.type, data: row.data, at: row.at }
}

const ACTIVE = ['queued', 'running'] as const

/** Postgres `unique_violation` anywhere in drizzle's cause chain. */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

export async function getRun(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentRunRow | null> {
  const row = await db.query.agentRuns.findFirst({
    where: and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)),
  })
  return row ?? null
}

/** The active run for an exclusive agent, if any. */
export async function findActiveRun(
  db: Database,
  tenantId: string,
  agentKey: AgentKey
): Promise<AgentRunRow | null> {
  const row = await db.query.agentRuns.findFirst({
    where: and(
      eq(agentRuns.tenantId, tenantId),
      eq(agentRuns.agentKey, agentKey),
      inArray(agentRuns.status, [...ACTIVE])
    ),
  })
  return row ?? null
}

export interface EnqueueRunInput {
  tenantId: string
  agentKey: AgentKey
  input: unknown
  userId: string | null
  realtime?: Realtime
}

export interface EnqueueRunResult {
  run: AgentRunRow
  /** An active run already existed for this exclusive agent; `run` is THAT run. */
  deduplicated: boolean
}

/**
 * Validate → insert `queued` → create the Workflow instance (id = run id) → store `instanceId`.
 * A `create()` failure marks the row `failed` (visible, releases the exclusive slot) and rethrows.
 */
export async function enqueueRun(
  db: Database,
  env: AgentRunsEnv,
  input: EnqueueRunInput
): Promise<EnqueueRunResult> {
  const workflow = env.AGENT_RUN_WORKFLOW
  if (!workflow) throw new AgentRunsNotConfiguredError()
  const agent = getAgent(input.agentKey)
  const parsed = agent.meta.inputSchema.safeParse(input.input)
  if (!parsed.success) throw new ValidationError(parsed.error.issues, 'Invalid agent input')

  let row: AgentRunRow | undefined
  try {
    ;[row] = await db
      .insert(agentRuns)
      .values({
        tenantId: input.tenantId,
        agentKey: input.agentKey,
        status: 'queued',
        input: parsed.data,
        requestedByUserId: input.userId,
      })
      .returning()
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const existing = await findActiveRun(db, input.tenantId, input.agentKey)
    if (!existing) throw err // the slot freed between the insert and the read — a retry will win
    return { run: existing, deduplicated: true }
  }
  if (!row) throw new Error('agent_runs: insert returned no row')

  try {
    const instance = await workflow.create({
      id: row.id,
      params: { runId: row.id, tenantId: input.tenantId },
    })
    const [updated] = await db
      .update(agentRuns)
      .set({ instanceId: instance.id })
      .where(and(eq(agentRuns.id, row.id), eq(agentRuns.tenantId, input.tenantId)))
      .returning()
    row = updated ?? row
  } catch (err) {
    await failRun(db, input.tenantId, row.id, `Could not start the workflow: ${errorMessage(err)}`)
    throw err
  }
  nudgeRun(input.realtime, input.tenantId, row.id)
  return { run: row, deduplicated: false }
}

/**
 * The claim: queued|running → running, `attempt + 1`, `startedAt` kept from the first claim.
 * Returns the row, or null when it is already terminal (cancelled while queued, or settled by an
 * earlier attempt) — the caller skips.
 */
export async function claimRun(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentRunRow | null> {
  const [row] = await db
    .update(agentRuns)
    .set({
      status: 'running',
      startedAt: sql`coalesce(${agentRuns.startedAt}, now())`,
      attempt: sql`${agentRuns.attempt} + 1`,
    })
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.tenantId, tenantId),
        inArray(agentRuns.status, [...ACTIVE])
      )
    )
    .returning()
  return row ?? null
}

/**
 * Terminal transitions only ever apply to an ACTIVE row — a settled run is never rewritten. Every
 * lifecycle timestamp is the DATABASE clock (`now()`), like `startedAt` in `claimRun`: a Workflow
 * isolate's `Date` can sit behind Postgres, and `finishedAt < startedAt` is not a row we want.
 */
async function settle(
  db: Database,
  tenantId: string,
  runId: string,
  patch: Partial<Pick<AgentRunRow, 'status' | 'output' | 'error'>>
): Promise<AgentRunRow | null> {
  const [row] = await db
    .update(agentRuns)
    .set({ ...patch, finishedAt: sql`now()` })
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.tenantId, tenantId),
        inArray(agentRuns.status, [...ACTIVE])
      )
    )
    .returning()
  return row ?? null
}

export function finishRun(db: Database, tenantId: string, runId: string, output: unknown) {
  return settle(db, tenantId, runId, { status: 'succeeded', output, error: null })
}

export function failRun(db: Database, tenantId: string, runId: string, error: string) {
  return settle(db, tenantId, runId, { status: 'failed', error: error.slice(0, 2000) })
}

export function cancelRun(db: Database, tenantId: string, runId: string) {
  return settle(db, tenantId, runId, { status: 'cancelled', error: null })
}

/**
 * Ask a run to stop. Queued → `cancelled` at once (the claim then finds nothing). Running → set
 * the flag; the run's `checkCancelled()` sees it between turns (a step in flight finishes).
 * Terminal → unchanged. Returns the row as it now is, or null if unknown in this tenant.
 */
export async function requestCancel(
  db: Database,
  tenantId: string,
  runId: string,
  realtime?: Realtime
): Promise<AgentRunRow | null> {
  const row = await getRun(db, tenantId, runId)
  if (!row) return null
  if (row.status === 'queued') {
    const [updated] = await db
      .update(agentRuns)
      .set({ status: 'cancelled', cancelRequestedAt: sql`now()`, finishedAt: sql`now()` })
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.tenantId, tenantId),
          eq(agentRuns.status, 'queued')
        )
      )
      .returning()
    nudgeRun(realtime, tenantId, runId)
    return updated ?? getRun(db, tenantId, runId)
  }
  if (row.status === 'running' && !row.cancelRequestedAt) {
    const [updated] = await db
      .update(agentRuns)
      .set({ cancelRequestedAt: sql`now()` })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)))
      .returning()
    nudgeRun(realtime, tenantId, runId)
    return updated ?? row
  }
  return row
}

/** `true` when a cancel was requested for the run — the poll a run makes between turns. */
export async function isCancelRequested(
  db: Database,
  tenantId: string,
  runId: string
): Promise<boolean> {
  const row = await db.query.agentRuns.findFirst({
    columns: { cancelRequestedAt: true, status: true },
    where: and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)),
  })
  return !row || row.cancelRequestedAt !== null || row.status === 'cancelled'
}

/** `instance.not_found` and friends — a definite "nothing is running", not a lookup failure. */
export function isMissingInstanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not_found|not found|does not exist|no such instance/i.test(message)
}

/**
 * Reconcile an ACTIVE row against the Workflow runtime on read. The row is truth for anything the
 * runtime still owns; when the runtime says the instance is gone or finished while the row says
 * active, the row is stale (a crash between steps, a terminated instance) and is settled here.
 * No binding, no instance id, or an unreachable runtime → the row is returned untouched.
 */
export async function reconcileRun(
  db: Database,
  env: AgentRunsEnv,
  run: AgentRunRow
): Promise<AgentRunRow> {
  if (run.status !== 'queued' && run.status !== 'running') return run
  if (!env.AGENT_RUN_WORKFLOW || !run.instanceId) return run
  let status: Awaited<ReturnType<Awaited<ReturnType<AgentRunWorkflowBinding['get']>>['status']>>
  try {
    status = await (await env.AGENT_RUN_WORKFLOW.get(run.instanceId)).status()
  } catch (err) {
    if (!isMissingInstanceError(err)) return run
    return (await failRun(db, run.tenantId, run.id, 'Workflow instance not found')) ?? run
  }
  switch (status.status) {
    case 'errored':
    case 'terminated': {
      const reason = status.error?.message ?? `Workflow instance ${status.status}`
      return (await failRun(db, run.tenantId, run.id, reason)) ?? run
    }
    case 'complete':
      return (await finishRun(db, run.tenantId, run.id, run.output ?? null)) ?? run
    default:
      return run
  }
}

// ---- Events ---------------------------------------------------------------------------------------

/** The realtime nudge every run mutation ends with. The client re-queries; the payload is an id. */
export function nudgeRun(realtime: Realtime | undefined, tenantId: string, runId: string): void {
  nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity: 'agent-run', id: runId }))
}

/** `max(seq)` for a run — the writer continues numbering from here across attempts. */
export async function lastEventSeq(db: Database, tenantId: string, runId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${agentRunEvents.seq})` })
    .from(agentRunEvents)
    .where(and(eq(agentRunEvents.tenantId, tenantId), eq(agentRunEvents.runId, runId)))
  return Number(row?.max ?? 0)
}

export async function appendEvent(
  db: Database,
  input: {
    tenantId: string
    runId: string
    seq: number
    type: AgentRunEventType
    data: unknown
    realtime?: Realtime
  }
): Promise<AgentRunEventRow> {
  const [row] = await db
    .insert(agentRunEvents)
    .values({
      tenantId: input.tenantId,
      runId: input.runId,
      seq: input.seq,
      type: input.type,
      data: input.data ?? {},
    })
    .returning()
  if (!row) throw new Error('agent_run_events: insert returned no row')
  nudgeRun(input.realtime, input.tenantId, input.runId)
  return row
}

export async function listEvents(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentRunEventRow[]> {
  return db
    .select()
    .from(agentRunEvents)
    .where(and(eq(agentRunEvents.tenantId, tenantId), eq(agentRunEvents.runId, runId)))
    .orderBy(asc(agentRunEvents.seq))
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

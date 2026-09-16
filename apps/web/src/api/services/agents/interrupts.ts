/**
 * `agent_run_interrupts` — the questions an agent run asks a person, and the answers (issue #17).
 *
 * Four properties here are load-bearing, and every one of them is a database constraint rather
 * than a convention:
 *
 * - **`requestInterrupt` is create-or-read on `(run_id, key)`.** A retried or resumed `execute`
 *   step re-enters the agent's `run()` from the TOP and asks again; the unique index is what makes
 *   the second ask find the first ask's ANSWER instead of opening a question nobody will ever see.
 *   It is the same shape as `runOnce`, for the same reason.
 * - **`resolveInterrupt` is ONE compare-and-set on `status = 'pending'`.** That is what makes "two
 *   people answer at once → one 200, one 409, one side effect" true. A read-then-write would give
 *   two 200s and two answers.
 * - **A rejection is `status = 'cancelled'`, never an `approved` boolean** — AG-UI's own
 *   `ResumeEntry` vocabulary. What a rejection MEANS is `rejectionFor(spec)`, resolved in one place.
 * - **`reason` is only ever written by `aguiReasonFor`.** It is a stored column, and two call sites
 *   computing it is two call sites to disagree.
 *
 * `expireParkedRun` is not here but in `runs.ts`, beside `reconcileRun`: it settles a run, and a
 * module that both answers questions and settles runs would close an import cycle with the module
 * that owns the lifecycle.
 */
import type { AgentInterruptSpec, AgentInterruptStatus } from '@rocketflare/shared/ai/interrupts'
import {
  type AgentRunInterrupt,
  aguiReasonFor,
  interruptPayloadSchema,
  rejectionFor,
} from '@rocketflare/shared/ai/interrupts'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type AgentRunInterruptRow, agentRunInterrupts } from '../../../db/schema'
import { type ToolApproval, toolInputSchema } from '../ai/kit'

/** What an agent hands `ctx.interrupt`, and what the runtime turns into a row. */
export interface RequestInterruptInput {
  tenantId: string
  runId: string
  /** Stable across attempts — half of `UNIQUE (run_id, key)`, which IS the idempotency. */
  key: string
  spec: AgentInterruptSpec
  toolCallId?: string | null
  expiresAt?: Date | null
}

export function toAgentRunInterrupt(row: AgentRunInterruptRow): AgentRunInterrupt {
  return {
    id: row.id,
    tenantId: row.tenantId,
    runId: row.runId,
    key: row.key,
    kind: row.kind,
    reason: row.reason,
    message: row.message,
    toolCallId: row.toolCallId,
    responseSchema: row.responseSchema ?? null,
    spec: row.spec,
    status: row.status,
    payload: row.payload ?? null,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt,
    resolvedByUserId: row.resolvedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * The JSON Schema a client with no kit code validates its answer against. Derived from the same
 * `interruptPayloadSchema(spec)` the route enforces, so the published contract and the 400 cannot
 * disagree — and derived rather than stored by hand, because a hand-written copy of a validator is
 * a second validator.
 */
function responseSchemaFor(spec: AgentInterruptSpec): Record<string, unknown> | null {
  try {
    return toolInputSchema(interruptPayloadSchema(spec))
  } catch {
    // A schema shape `zod-to-json-schema` cannot render is a missing convenience, never a failed
    // ask: the kit's own UI validates with the zod schema, and the column is nullable for this.
    return null
  }
}

/**
 * Create the ask, or return the one this run already made under that key — the idempotency (T2).
 * Never updates an existing row: a re-entered attempt must find the ANSWER, not overwrite the
 * question somebody is in the middle of reading.
 */
export async function requestInterrupt(
  db: Database,
  input: RequestInterruptInput
): Promise<AgentRunInterruptRow> {
  const toolCallId = input.toolCallId ?? null
  const [inserted] = await db
    .insert(agentRunInterrupts)
    .values({
      tenantId: input.tenantId,
      runId: input.runId,
      key: input.key,
      kind: input.spec.kind,
      reason: aguiReasonFor(input.spec.kind, toolCallId),
      message: input.spec.message,
      toolCallId,
      responseSchema: responseSchemaFor(input.spec),
      spec: input.spec,
      status: 'pending',
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoNothing({ target: [agentRunInterrupts.runId, agentRunInterrupts.key] })
    .returning()
  if (inserted) return inserted
  const existing = await findInterruptByKey(db, input.tenantId, input.runId, input.key)
  if (!existing) throw new Error(`agent_run_interrupts: ${input.key} neither inserted nor found`)
  return existing
}

export async function findInterruptByKey(
  db: Database,
  tenantId: string,
  runId: string,
  key: string
): Promise<AgentRunInterruptRow | null> {
  const row = await db.query.agentRunInterrupts.findFirst({
    where: and(
      eq(agentRunInterrupts.tenantId, tenantId),
      eq(agentRunInterrupts.runId, runId),
      eq(agentRunInterrupts.key, key)
    ),
  })
  return row ?? null
}

export async function getInterrupt(
  db: Database,
  tenantId: string,
  runId: string,
  interruptId: string
): Promise<AgentRunInterruptRow | null> {
  const row = await db.query.agentRunInterrupts.findFirst({
    where: and(
      eq(agentRunInterrupts.tenantId, tenantId),
      eq(agentRunInterrupts.runId, runId),
      eq(agentRunInterrupts.id, interruptId)
    ),
  })
  return row ?? null
}

/** Every ask this run has made, oldest first; narrowed to one status when asked. */
export function listInterrupts(
  db: Database,
  tenantId: string,
  runId: string,
  status?: AgentInterruptStatus
): Promise<AgentRunInterruptRow[]> {
  return db
    .select()
    .from(agentRunInterrupts)
    .where(
      and(
        eq(agentRunInterrupts.tenantId, tenantId),
        eq(agentRunInterrupts.runId, runId),
        status ? eq(agentRunInterrupts.status, status) : undefined
      )
    )
    .orderBy(asc(agentRunInterrupts.createdAt))
}

export interface ResolveInterruptInput {
  tenantId: string
  runId: string
  interruptId: string
  /** AG-UI's `ResumeEntry.status`: `resolved` = answered, `cancelled` = declined. */
  status: 'resolved' | 'cancelled'
  payload?: unknown
  resolvedByUserId: string | null
}

/**
 * Answer an ask — ONE statement, compare-and-set on `pending`. `null` means somebody else got
 * there first (or it expired), which the route turns into 409 `interrupt_not_pending`.
 */
export async function resolveInterrupt(
  db: Database,
  input: ResolveInterruptInput
): Promise<AgentRunInterruptRow | null> {
  const [row] = await db
    .update(agentRunInterrupts)
    .set({
      status: input.status,
      payload: input.payload ?? null,
      resolvedAt: new Date(),
      resolvedByUserId: input.resolvedByUserId,
    })
    .where(
      and(
        eq(agentRunInterrupts.id, input.interruptId),
        eq(agentRunInterrupts.tenantId, input.tenantId),
        eq(agentRunInterrupts.runId, input.runId),
        eq(agentRunInterrupts.status, 'pending')
      )
    )
    .returning()
  return row ?? null
}

/**
 * Every still-pending ask of a run → `expired`. Called when the run settles underneath them (a
 * cancel, a timeout): a question whose run is over must never sit in somebody's inbox.
 */
export async function expireInterrupts(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentRunInterruptRow[]> {
  return db
    .update(agentRunInterrupts)
    .set({ status: 'expired' })
    .where(
      and(
        eq(agentRunInterrupts.tenantId, tenantId),
        eq(agentRunInterrupts.runId, runId),
        eq(agentRunInterrupts.status, 'pending')
      )
    )
    .returning()
}

/**
 * The answers to this run's gated TOOL calls, keyed by the model's `toolCallId` — what
 * `runToolLoop` consumes as `approvals`. Only settled rows appear: a pending ask is not an answer,
 * and a run whose gate is still open parks again rather than guessing.
 *
 * `expired` is read as a decline, deliberately. The alternative — ignoring it — parks the run on a
 * question that can never be answered, which is the one outcome worse than a refusal.
 */
export async function approvalsForRun(
  db: Database,
  tenantId: string,
  runId: string
): Promise<Map<string, ToolApproval>> {
  const rows = await db
    .select()
    .from(agentRunInterrupts)
    .where(
      and(
        eq(agentRunInterrupts.tenantId, tenantId),
        eq(agentRunInterrupts.runId, runId),
        inArray(agentRunInterrupts.status, ['resolved', 'cancelled', 'expired'])
      )
    )
    .orderBy(asc(agentRunInterrupts.createdAt))
  const approvals = new Map<string, ToolApproval>()
  for (const row of rows) {
    if (!row.toolCallId) continue
    const payload = (row.payload ?? {}) as { note?: string; editedInput?: unknown }
    approvals.set(row.toolCallId, {
      interruptId: row.id,
      status: row.status === 'resolved' ? 'resolved' : 'cancelled',
      ...(payload.editedInput !== undefined ? { input: payload.editedInput } : {}),
      ...(payload.note ? { note: payload.note } : {}),
      onReject: rejectionFor(row.spec),
    })
  }
  return approvals
}

// ---- Expiry -------------------------------------------------------------------------------------

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  second: 1_000,
  sec: 1_000,
  minute: 60_000,
  min: 60_000,
  hour: 3_600_000,
  hr: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
}

/**
 * A Cloudflare Workflows duration (`"168 hours"`, `"3 days"`, or plain milliseconds) in
 * milliseconds, or **null when it does not parse**.
 *
 * Null is a real answer, not a failure: the same string is handed to `step.waitForEvent`, which is
 * the authority on it, and a value this parser does not recognise must not stop a run parking. It
 * only costs the row its `expiresAt`, and `expireParkedRun` then leaves that park to the Workflow
 * timeout — the exact behaviour before expiry existed.
 */
export function parseDurationMs(value: string): number | null {
  const trimmed = value.trim().toLowerCase()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(trimmed)
  if (!match?.[1] || !match[2]) return null
  const unit = match[2].replace(/s$/, '')
  const factor = DURATION_UNITS[unit]
  return factor ? Math.round(Number(match[1]) * factor) : null
}

/** When an ask raised now would expire, from `AGENT_INTERRUPT_TIMEOUT`. Null = no deadline. */
export function interruptExpiryFrom(timeout: string, now = new Date()): Date | null {
  const ms = parseDurationMs(timeout)
  return ms === null ? null : new Date(now.getTime() + ms)
}

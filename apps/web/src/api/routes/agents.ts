/**
 * `/api/agents` (D7): the registry and its runs. `POST /runs` is the handoff — validate → insert
 * `queued` → create the Workflow instance → 202 with the row (the route never runs the agent). An
 * exclusive agent with an active run answers THAT run with `deduplicated: true` (409
 * `agent_run_active` only with `?strict=1`). `GET /runs/:id` returns the row + its durable events
 * after `reconcileRun` (a stale active row whose instance is gone is settled on read — `not_found`
 * is an answer). Members see and cancel their OWN runs; admin+ (`isAdminLevel`) every run in the
 * tenant. Every query carries the tenant predicate from the auth context.
 */
import {
  type AgentRun,
  type AgentRunWithEvents,
  agentRunListQuerySchema,
  createAgentRunRequestSchema,
  isRunActive,
} from '@rocketflare/shared/ai/agents'
import type { AgentRunAguiResponse } from '@rocketflare/shared/ai/agui'
import type { AgentApprovers, InterruptInboxItem } from '@rocketflare/shared/ai/interrupts'
import {
  createSteeringNoteRequestSchema,
  interruptInboxQuerySchema,
  interruptPayloadSchema,
  interruptRejectionPayloadSchema,
  resolveInterruptRequestSchema,
} from '@rocketflare/shared/ai/interrupts'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { type AgentRunRow, agentRunInterrupts, agentRuns } from '../../db/schema'
import { guardPermission, isAdminLevel } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import { projectRunToAgui } from '../services/agents/agui-projection'
import { listArtifacts, toAgentArtifact } from '../services/agents/artifacts'
import {
  checkEditedToolInput,
  getInterrupt,
  listInterrupts,
  resolveInterrupt,
  toAgentRunInterrupt,
} from '../services/agents/interrupts'
import { AGENTS, isAgentKey, listAgentInfo } from '../services/agents/registry'
import { streamRunAgui } from '../services/agents/run-stream'
import {
  appendEventAtomic,
  enqueueRun,
  expireParkedRun,
  getRun,
  listEvents,
  nudgeInterrupts,
  nudgeOrRestartInstance,
  nudgeRun,
  reconcileRun,
  requestCancel,
  resumeRun,
  toAgentRun,
  toAgentRunEvent,
} from '../services/agents/runs'
import type { AppContext, AuthContext } from '../types'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/core/errors'
import { pageWindow, paginated } from '../utils/routes/pagination'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const agentsRouter = createRouter()

/** A member may only see runs they requested; admin+ see the tenant's. Others' runs are 404. */
function visible(auth: AuthContext, run: AgentRunRow): boolean {
  return isAdminLevel(auth) || run.requestedByUserId === auth.user.id
}

/** The agent's approver policy, defaulting for a row whose key is no longer registered. */
function approversFor(agentKey: string): AgentApprovers {
  return (isAgentKey(agentKey) ? AGENTS[agentKey].meta.approvers : undefined) ?? 'requester'
}

/**
 * Who may ANSWER this run's asks. **No new CASL action and no new subject** (issue #17): it is the
 * `update AgentRun` the route already guards, plus the agent's own `approvers` policy.
 *
 * `'requester'` is deliberately the same predicate as {@link visible} — "whoever may cancel this
 * run may answer it" — so there is one mental model rather than two. `'admin'` is the opt-in for
 * agents that touch money, customers or deletion; a member then still SEES their own run's ask in
 * the inbox and gets a 403 on answering, which is correct and renders read-only.
 *
 * An app that wants approvals on its own axis adds its OWN subject; `CORE_SUBJECTS` is extensible.
 */
function canAnswer(auth: AuthContext, run: AgentRunRow): boolean {
  return approversFor(run.agentKey) === 'admin' ? isAdminLevel(auth) : visible(auth, run)
}

/**
 * The read path for one run: tenant-scoped, ownership-checked, then reconciled against the
 * runtime. `expireParkedRun` sits beside `reconcileRun` because they answer the same question for
 * the two halves of "active" — `reconcileRun` settles a `queued`/`running` row whose instance is
 * gone, and `expireParkedRun` settles an `awaiting_input` row whose asks have all passed their
 * deadline (T6). Without it a park whose instance died holds the exclusive slot forever.
 */
async function loadRun(c: AppContext, runId: string): Promise<AgentRunRow> {
  const { db, tenantId, auth, realtime } = withAuthAndDb(c)
  const row = await getRun(db, tenantId, runId)
  if (!row || !visible(auth, row)) throw new NotFoundError('Agent run not found')
  return expireParkedRun(db, await reconcileRun(db, c.env, row), realtime)
}

// ---- GET /api/agents ------------------------------------------------------------------------------

agentsRouter.get('/', async c => {
  withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  return c.json({ items: listAgentInfo() })
})

// ---- GET /api/agents/runs -------------------------------------------------------------------------

agentsRouter.get('/runs', validate('query', agentRunListQuerySchema), async c => {
  const { db, tenantId, user, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const query = c.req.valid('query')
  const { limit, offset } = pageWindow(query)
  const where = and(
    eq(agentRuns.tenantId, tenantId),
    isAdminLevel(auth) ? undefined : eq(agentRuns.requestedByUserId, user.id),
    query.agentKey ? eq(agentRuns.agentKey, query.agentKey) : undefined,
    query.status ? eq(agentRuns.status, query.status) : undefined
  )
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(agentRuns)
      .where(where)
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(agentRuns).where(where),
  ])
  return c.json(paginated(rows.map(toAgentRun), total?.n ?? 0, query))
})

// ---- POST /api/agents/runs ------------------------------------------------------------------------

agentsRouter.post('/runs', validate('json', createAgentRunRequestSchema), async c => {
  const { db, tenantId, user, defer, realtime } = withAuthAndDb(c)
  guardPermission(c, 'create', 'AgentRun')
  const { agentKey, input } = c.req.valid('json')
  const strict = c.req.query('strict') === '1'
  const { run, deduplicated } = await enqueueRun(db, c.env, {
    tenantId,
    agentKey,
    input,
    userId: user.id,
    realtime,
  })
  if (deduplicated && strict) {
    throw new ConflictError(
      `A ${agentKey} run is already queued or running for this organisation`,
      ERROR_CODES.agentRunActive,
      { runId: run.id }
    )
  }
  if (!deduplicated) {
    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: 'agent_run.requested',
        subjectType: 'AgentRun',
        subjectId: run.id,
        metadata: { agentKey },
      })
    )
  }
  return c.json({ ...toAgentRun(run), deduplicated }, 202)
})

// ---- GET /api/agents/runs/:id ---------------------------------------------------------------------

agentsRouter.get('/runs/:id', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const run = await loadRun(c, uuidParam(c, 'id'))
  // `?events=0` is the bare row: one indexed read instead of the whole log, for a client that is
  // tailing the events over the stream and only wants the row the nudge refreshes.
  if (c.req.query('events') === '0') {
    const bare: AgentRun = toAgentRun(run)
    return c.json(bare)
  }
  const [events, interrupts, artifacts] = await Promise.all([
    listEvents(db, tenantId, run.id),
    listInterrupts(db, tenantId, run.id),
    listArtifacts(db, tenantId, run.id),
  ])
  const body: AgentRunWithEvents = {
    ...toAgentRun(run),
    events: events.map(toAgentRunEvent),
    interrupts: interrupts.map(toAgentRunInterrupt),
    artifacts: artifacts.map(toAgentArtifact),
  }
  return c.json(body)
})

// ---- GET /api/agents/runs/:id/agui ----------------------------------------------------------------

/**
 * The same run as `GET /runs/:id`, projected into AG-UI (D7). Plain JSON, not a stream: a run
 * executes in a Workflow, in a different isolate from any request, so live streaming is a feature
 * rather than a mapping — the WS nudge plus the poll already gives sub-second updates.
 */
agentsRouter.get('/runs/:id/agui', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const run = await loadRun(c, uuidParam(c, 'id'))
  const [events, interrupts, artifacts] = await Promise.all([
    listEvents(db, tenantId, run.id),
    listInterrupts(db, tenantId, run.id),
    listArtifacts(db, tenantId, run.id),
  ])
  const body: AgentRunAguiResponse = {
    events: projectRunToAgui(toAgentRun(run), events.map(toAgentRunEvent), {
      interrupts: interrupts.map(toAgentRunInterrupt),
      artifacts: artifacts.map(toAgentArtifact),
    }),
    // The cursor a client hands `?afterSeq=` to tail from here. AG-UI events carry no sequence of
    // their own, so without it every reconnect replays the whole run.
    lastSeq: events.at(-1)?.seq ?? 0,
  }
  return c.json(body)
})

// ---- GET /api/agents/runs/:id/agui/stream ---------------------------------------------------------

/**
 * The same projection, live (issue #7). GET rather than POST on purpose: `csrf.ts` passes GET, and
 * a third-party AG-UI client can then open it with a bare `EventSource` — which is the only reason
 * `Last-Event-ID` is honoured at all. **`?afterSeq=` wins when both are present**: the kit's own
 * client is explicit, and a stale browser value must never override it.
 *
 * Everything that can fail is JSON and happens HERE, above `streamRunAgui` — the ability, the uuid,
 * the 404 for a run this caller cannot see, `reconcileRun` (via `loadRun`, **exactly once, never in
 * the loop**: it is a Workflow subrequest per call) and a garbage cursor. After the first frame the
 * only thing left to say is nothing at all (decision 6).
 */
agentsRouter.get('/runs/:id/agui/stream', async c => {
  withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const run = await loadRun(c, uuidParam(c, 'id'))
  return streamRunAgui(c, run, resolveStreamCursor(c))
})

/**
 * The resume cursor. An explicit `?afterSeq=` that is not a non-negative integer is a **400** — the
 * client meant something and got it wrong, and silently rewinding it to 0 would replay a long run
 * as if nothing had happened. A malformed `Last-Event-ID` is merely ignored: the browser sets that
 * one, a value from an older build is not the caller's mistake, and a full replay is always correct.
 */
function resolveStreamCursor(c: AppContext): number {
  const explicit = c.req.query('afterSeq')
  if (explicit !== undefined) {
    const value = Number(explicit)
    if (!Number.isInteger(value) || value < 0) {
      throw new ValidationError(
        [{ path: ['afterSeq'], message: 'afterSeq must be a non-negative integer' }],
        'Invalid cursor'
      )
    }
    return value
  }
  const header = Number(c.req.header('Last-Event-ID'))
  return Number.isInteger(header) && header >= 0 ? header : 0
}

// ---- POST /api/agents/runs/:id/cancel -------------------------------------------------------------

agentsRouter.post('/runs/:id/cancel', async c => {
  const { db, tenantId, user, auth, defer, realtime } = withAuthAndDb(c)
  guardPermission(c, 'update', 'AgentRun')
  const id = uuidParam(c, 'id')
  const row = await getRun(db, tenantId, id)
  if (!row || !visible(auth, row)) throw new NotFoundError('Agent run not found')
  const run = (await requestCancel(db, tenantId, id, realtime, c.env)) ?? row
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: run.status === 'cancelled' ? 'agent_run.cancelled' : 'agent_run.cancel_requested',
      subjectType: 'AgentRun',
      subjectId: run.id,
      metadata: { agentKey: run.agentKey, status: run.status },
    })
  )
  return c.json(toAgentRun(run))
})

// ---- POST /api/agents/runs/:id/interrupts/:interruptId ---------------------------------------------

/**
 * Answer one of a run's asks (issue #17). **Eight steps, and each is a precondition for the next**
 * — the order is the design, not an accident of writing:
 *
 *  1. the run must exist and be visible → 404 (another tenant's, or another member's, never exists)
 *  2. the caller must be an approver for THIS agent → 403
 *  3. the ask must exist on that run → 404
 *  4. the answer must validate against the ask's own schema → 400 with the zod issues
 *  5. `resolveInterrupt` is ONE compare-and-set on `pending` → null is 409 `interrupt_not_pending`,
 *     which is what makes "two people answer at once" one 200, one 409 and ONE side effect
 *  6. the timeline gets an `interrupt.resolved` row (`appendEventAtomic`: a steering note may be
 *     racing a step's emitter for `seq`)
 *  7. **only when nothing is still pending**, `resumeRun` and then wake the instance. A turn with
 *     three gated calls parks ONCE and needs all three answers; resuming early re-enters the loop
 *     with unanswered asks
 *  8. activity + nudge + 200
 *
 * Step 7 is also where **the answer IS the transition** (decision 2, T4) lives: `resumeRun` flips
 * `awaiting_input → running` BEFORE `nudgeOrRestartInstance`, which is the only reason a restarted
 * instance's `claim` step — whose predicate is the narrow `queued|running` — finds anything at all.
 *
 * The route still never runs an agent: this is a row write and a nudge to a Workflow.
 */
agentsRouter.post(
  '/runs/:id/interrupts/:interruptId',
  validate('json', resolveInterruptRequestSchema),
  async c => {
    const { db, tenantId, user, auth, defer, realtime } = withAuthAndDb(c)
    guardPermission(c, 'update', 'AgentRun')
    const runId = uuidParam(c, 'id')
    const interruptId = uuidParam(c, 'interruptId')

    const run = await getRun(db, tenantId, runId)
    if (!run || !visible(auth, run)) throw new NotFoundError('Agent run not found')
    if (!canAnswer(auth, run)) {
      throw new ForbiddenError('Only an administrator may answer this agent')
    }
    const interrupt = await getInterrupt(db, tenantId, runId, interruptId)
    if (!interrupt) throw new NotFoundError('Interrupt not found')

    const body = c.req.valid('json')
    const payload = validateAnswer(interrupt.spec, body.status, body.payload)

    const resolved = await resolveInterrupt(db, {
      tenantId,
      runId,
      interruptId,
      status: body.status,
      payload,
      resolvedByUserId: user.id,
    })
    if (!resolved) {
      throw new ConflictError(
        'That question has already been answered',
        ERROR_CODES.interruptNotPending,
        { interruptId }
      )
    }

    await appendEventAtomic(db, {
      tenantId,
      runId,
      type: 'interrupt.resolved',
      data: {
        interruptId: resolved.id,
        key: resolved.key,
        kind: resolved.kind,
        status: resolved.status,
        resolvedByUserId: user.id,
      },
      realtime,
    })

    const stillPending = await listInterrupts(db, tenantId, runId, 'pending')
    if (stillPending.length === 0) {
      const resumedRow = await resumeRun(db, tenantId, runId)
      // Null means the row was not parked — the answer beat the park, or the run was cancelled
      // underneath it. Either way there is no instance of ours to wake: the execute step that is
      // still running will read this answer as a row, which is the whole point of decision 3.
      if (resumedRow) await nudgeOrRestartInstance(db, c.env, resumedRow, { interruptId })
    }

    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: 'agent_run.interrupt_resolved',
        subjectType: 'AgentRun',
        subjectId: runId,
        metadata: { agentKey: run.agentKey, kind: resolved.kind, status: resolved.status },
      })
    )
    nudgeRun(realtime, tenantId, runId)
    nudgeInterrupts(realtime, tenantId, runId)
    return c.json(toAgentRunInterrupt(resolved))
  }
)

/**
 * Step 4, in one place. A `resolved` answer validates against `interruptPayloadSchema(spec)` — the
 * SAME function the UI validates its draft with, so a 400 here is never a surprise — and a
 * `cancelled` one carries a note and nothing else.
 *
 * The `editedInput` branch is the sharp one: `interruptPayloadSchema` already refuses an edit the
 * ask did not offer (`tool.allowEdits`), and this then re-checks the edited arguments against the
 * tool's STORED schema. *A client that can edit tool arguments is a client that can call anything*,
 * so the check is not optional — and `runHandler` validates once more with the tool's real zod
 * schema before the handler runs, which is the layer this one is defence in depth for.
 */
function validateAnswer(
  spec: Parameters<typeof interruptPayloadSchema>[0],
  status: 'resolved' | 'cancelled',
  raw: unknown
): unknown {
  const schema =
    status === 'resolved' ? interruptPayloadSchema(spec) : interruptRejectionPayloadSchema
  const parsed = schema.safeParse(raw ?? {})
  if (!parsed.success) throw new ValidationError(parsed.error.issues, 'Invalid answer')
  const payload = parsed.data as { editedInput?: unknown }
  if (status === 'resolved' && payload.editedInput !== undefined) {
    const issues = checkEditedToolInput(spec, payload.editedInput)
    if (issues.length > 0) throw new ValidationError(issues, 'Invalid edited tool input')
  }
  return parsed.data
}

// ---- POST /api/agents/runs/:id/steering ------------------------------------------------------------

/**
 * Send a note to a run in flight (issue #17, decision 4). It is an `agent_run_events` row rather
 * than a table because a note is immutable, positional and per-run — exactly what an append-only
 * log is for — and the runtime's once-only delivery cursor is the existing `agent_run_effects`
 * ledger, so there is nothing else to store.
 *
 * `appendEventAtomic` rather than `appendEvent`: this is the ONE writer that races a Workflow
 * step's in-memory `seq` counter, and the loser of that race would be a silently dropped row.
 *
 * Allowed while `queued` (the note lands before turn one) and while `awaiting_input` (a note plus
 * an answer is a normal pair); a settled run is 409 — there is nobody left to read it.
 */
agentsRouter.post(
  '/runs/:id/steering',
  validate('json', createSteeringNoteRequestSchema),
  async c => {
    const { db, tenantId, user, auth, realtime } = withAuthAndDb(c)
    guardPermission(c, 'update', 'AgentRun')
    const runId = uuidParam(c, 'id')
    const run = await getRun(db, tenantId, runId)
    if (!run || !visible(auth, run)) throw new NotFoundError('Agent run not found')
    if (!isRunActive(run.status)) {
      throw new ConflictError('That run has finished, so it cannot be steered', undefined, {
        status: run.status,
      })
    }
    const row = await appendEventAtomic(db, {
      tenantId,
      runId,
      type: 'steering',
      data: {
        text: c.req.valid('json').text,
        authorUserId: user.id,
        ...(user.name ? { authorName: user.name } : {}),
      },
      realtime,
    })
    return c.json(toAgentRunEvent(row), 201)
  }
)

// ---- GET /api/agents/interrupts --------------------------------------------------------------------

/**
 * The inbox: every ask in this tenant the caller can SEE, newest first. A member sees the asks of
 * runs they requested, admin+ every run's — the same predicate as the runs list, because "can I
 * see this run" and "can I see its questions" must never be two rules.
 *
 * `canAnswer` travels per item rather than filtering the list: a member under `approvers: 'admin'`
 * is supposed to see that their run is waiting on somebody, and the UI renders it read-only.
 */
agentsRouter.get('/interrupts', validate('query', interruptInboxQuerySchema), async c => {
  const { db, tenantId, user, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const query = c.req.valid('query')
  const { limit, offset } = pageWindow(query)
  const runsWhere = and(
    eq(agentRuns.tenantId, tenantId),
    isAdminLevel(auth) ? undefined : eq(agentRuns.requestedByUserId, user.id)
  )
  const where = and(
    eq(agentRunInterrupts.tenantId, tenantId),
    eq(agentRunInterrupts.status, query.status),
    inArray(
      agentRunInterrupts.runId,
      db.select({ id: agentRuns.id }).from(agentRuns).where(runsWhere)
    )
  )
  const [rows, [total]] = await Promise.all([
    db
      .select({ interrupt: agentRunInterrupts, run: agentRuns })
      .from(agentRunInterrupts)
      .innerJoin(agentRuns, eq(agentRuns.id, agentRunInterrupts.runId))
      .where(where)
      .orderBy(desc(agentRunInterrupts.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(agentRunInterrupts).where(where),
  ])
  const items: InterruptInboxItem[] = rows.map(({ interrupt, run }) => ({
    ...toAgentRunInterrupt(interrupt),
    run: {
      id: run.id,
      agentKey: run.agentKey,
      status: run.status,
      requestedByUserId: run.requestedByUserId,
      createdAt: run.createdAt,
    },
    canAnswer: canAnswer(auth, run),
  }))
  return c.json(paginated(items, total?.n ?? 0, query))
})

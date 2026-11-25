/**
 * `/api/agents`: the registry and its runs. `POST /runs` is the handoff — validate → insert
 * `queued` → create the Workflow instance → 202 with the row (the route never runs the agent). An
 * exclusive agent with an active run answers THAT run with `deduplicated: true` (409
 * `agent_run_active` only with `?strict=1`). `POST /runs/batch` is the same handoff for up to
 * 100 inputs of one NON-exclusive agent (400 `agent_exclusive` otherwise), with per-input errors;
 * both answer 429 `agent_runs_limit` over `AGENT_MAX_ACTIVE_RUNS_PER_TENANT` and 429
 * `ai_budget_exceeded` once the tenant's agent spend today reaches its cap.
 *
 * `GET /runs/:id` returns the row, its durable events, its asks and its artifacts — **in that
 * order, and the order is the contract**: read the log, then `settleOnRead` (a stale active row
 * whose instance is gone is settled here — `not_found` is an answer; a run that emitted an event
 * inside `RECONCILE_LIVENESS_MS` is alive by definition and the binding is not touched), then read
 * the interrupts. Reading the asks BEFORE the settle returns a `pending` ask beside a `cancelled`
 * run, which is a screen nobody can act on.
 *
 * Beyond the run itself: `GET /runs/:id/agui` projects it to AG-UI, `GET /runs/:id/agui/stream` is
 * the live read-stream, `POST /runs/:id/interrupts/:interruptId` is the answer
 * (`update AgentRun` plus the agent's `approvers` policy; a compare-and-set on `pending` is
 * what makes one 200 and one 409 `interrupt_not_pending` true when two people answer at once),
 * `POST /runs/:id/steering` adds a note to a live run, and `GET /api/agents/interrupts` is the
 * tenant-wide inbox. Members see, cancel and steer their OWN runs; admin+ (`isAdminLevel`) every
 * run in the tenant. Every query carries the tenant predicate from the auth context.
 */
import type { AgentRunTimeline } from '@rocketflare/shared/ai/agent-timeline'
import {
  type AgentRun,
  type AgentRunListItem,
  type AgentRunWithEvents,
  type AgentStatsResponse,
  agentRunListQuerySchema,
  agentStatsQuerySchema,
  type BindableAgentListResponse,
  bindableAgentListQuerySchema,
  type CreateAgentRunBatchResponse,
  createAgentRunBatchRequestSchema,
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
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import type { Database } from '../../db/client'
import { type AgentRunRow, agentRunInterrupts, agentRuns, users } from '../../db/schema'
import { guardPermission, isAdminLevel } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import { projectRunToAgui } from '../services/agents/agui-projection'
import { listArtifacts, toAgentArtifact } from '../services/agents/artifacts'
import { listDecisions } from '../services/agents/decisions'
import { assignedToSql, canAnswerAsk, runAssignedTo } from '../services/agents/hitl'
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
  enqueueRunBatch,
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
import { agentStats } from '../services/agents/stats'
import { runTimeline } from '../services/agents/timeline'
import { bindableAgents } from '../services/agents/triggers'
import { runSpend } from '../services/ai/usage'
import { isEventName } from '../services/events/registry'
import type { AppContext, AuthContext } from '../types'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../utils/core/errors'
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
 * Who may ANSWER this run's asks. **No new CASL action and no new subject**: it is the
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
 * The read path for one run in one call: tenant-scoped, ownership-checked, then reconciled — for a
 * caller with no events in hand to prove the run is alive. A caller that HAS them uses the two
 * halves directly and hands {@link settleOnRead} the newest event's timestamp.
 */
async function loadRun(c: AppContext, runId: string): Promise<AgentRunRow> {
  return settleOnRead(c, await requireRun(c, runId))
}

/**
 * Tenant-scoped lookup plus the ownership check: another member's run is the same 404 as none.
 * READ access also reaches an assignee of one of the run's asks — they were asked to decide, and
 * the run's timeline is what explains the question. Cancel and steer stay with {@link visible}.
 */
async function requireRun(c: AppContext, runId: string): Promise<AgentRunRow> {
  const { db, tenantId, auth, user } = withAuthAndDb(c)
  const row = await getRun(db, tenantId, runId)
  if (!row) throw new NotFoundError('Agent run not found')
  if (!visible(auth, row) && !(await runAssignedTo(db, tenantId, row.id, user.id))) {
    throw new NotFoundError('Agent run not found')
  }
  return row
}

/**
 * The second half of the read path: settle a stale active row against the runtime.
 * `expireParkedRun` sits beside `reconcileRun` because they answer the same question for the two
 * halves of "active" — `reconcileRun` settles a `queued`/`running` row whose instance is gone, and
 * `expireParkedRun` settles an `awaiting_input` row whose asks have all passed their deadline.
 * Without it a park whose instance died holds the exclusive slot forever.
 *
 * `lastEventAt` is passed by every caller that has the run's events in hand, and it is why this is
 * split out of {@link loadRun} at all. `reconcileRun` costs a Workflow `instance.status()`
 * subrequest per call, and the run page re-reads a run on EVERY new `seq` the live stream reports
 * — several a second on a bursty run, per viewer. A run that wrote a durable event two seconds ago
 * is alive by definition, so the newest event's timestamp answers the question for free and the
 * binding is never touched. A caller with no events passes nothing and reconciles as it always did.
 */
async function settleOnRead(
  c: AppContext,
  row: AgentRunRow,
  options?: { lastEventAt?: Date | null }
): Promise<AgentRunRow> {
  const { db, realtime } = withAuthAndDb(c)
  return expireParkedRun(
    db,
    await reconcileRun(db, c.env, row, options),
    realtime,
    new Date(),
    c.env
  )
}

// ---- GET /api/agents ------------------------------------------------------------------------------

agentsRouter.get('/', async c => {
  withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  return c.json({ items: listAgentInfo() })
})

// ---- GET /api/agents/bindable?event= ------------------------------------------------------------

/**
 * D42: the agents that opt in (`bindable`) to being started by one plugin event — the list behind
 * an editor's "On submit, start" picker. Guarded like `GET /` (the registry is code, the same for
 * every tenant). An undeclared event is a 400 `event_unknown`, so a typo in a plugin's UI is loud
 * rather than an empty picker. Listing an agent here grants nothing: the start re-checks it.
 */
agentsRouter.get('/bindable', validate('query', bindableAgentListQuerySchema), async c => {
  withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const { event } = c.req.valid('query')
  if (!isEventName(event)) {
    throw new BadRequestError(`Unknown event: ${event}`, ERROR_CODES.eventUnknown, { event })
  }
  return c.json({ items: bindableAgents(event) } satisfies BindableAgentListResponse)
})

// ---- GET /api/agents/runs -------------------------------------------------------------------------

// ---- GET /api/agents/stats -----------------------------------------------------------------------

/**
 * Per-agent runs, outcomes, tokens, cost and mean duration over `?days=` (default 30), plus each
 * agent's newest run — the agents page's one request. Scoped like the runs list: a member's own
 * runs, admin+ every run (`services/agents/stats.ts`).
 */
agentsRouter.get('/stats', validate('query', agentStatsQuerySchema), async c => {
  const { db, tenantId, user, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const { days } = c.req.valid('query')
  const body: AgentStatsResponse = await agentStats(
    db,
    { tenantId, ...(isAdminLevel(auth) ? {} : { requestedByUserId: user.id }) },
    days
  )
  return c.json(body)
})

agentsRouter.get('/runs', validate('query', agentRunListQuerySchema), async c => {
  const { db, tenantId, user, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const query = c.req.valid('query')
  const { limit, offset } = pageWindow(query)
  const where = and(
    eq(agentRuns.tenantId, tenantId),
    isAdminLevel(auth) ? undefined : eq(agentRuns.requestedByUserId, user.id),
    query.agentKey ? eq(agentRuns.agentKey, query.agentKey) : undefined,
    query.status ? eq(agentRuns.status, query.status) : undefined,
    query.batchId ? eq(agentRuns.batchId, query.batchId) : undefined,
    // A child is reached through its parent: the list holds top-level runs unless asked for one
    // run's children.
    query.parentRunId
      ? eq(agentRuns.parentRunId, query.parentRunId)
      : isNull(agentRuns.parentRunId),
    query.since ? gte(agentRuns.createdAt, query.since) : undefined,
    query.until ? lt(agentRuns.createdAt, query.until) : undefined,
    query.agentVersion ? eq(agentRuns.agentVersion, query.agentVersion) : undefined
  )
  const [rows, [total]] = await Promise.all([
    // The requester's NAME rides along so the list never shows a user id. The join is through a
    // row already filtered to this tenant, so it names only people who started a run here.
    db
      .select({ run: agentRuns, requesterName: users.name })
      .from(agentRuns)
      .leftJoin(users, eq(users.id, agentRuns.requestedByUserId))
      .where(where)
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(agentRuns).where(where),
  ])
  const items: AgentRunListItem[] = rows.map(({ run, requesterName }) => ({
    ...toAgentRun(run),
    requestedBy:
      run.requestedByUserId && requesterName !== null
        ? { id: run.requestedByUserId, name: requesterName }
        : null,
  }))
  return c.json(paginated(items, total?.n ?? 0, query))
})

// ---- POST /api/agents/runs ------------------------------------------------------------------------

agentsRouter.post('/runs', validate('json', createAgentRunRequestSchema), async c => {
  const { db, cfg, tenantId, user, auth, defer, realtime } = withAuthAndDb(c)
  guardPermission(c, 'create', 'AgentRun')
  const { agentKey, input } = c.req.valid('json')
  const strict = c.req.query('strict') === '1'
  const { run, deduplicated } = await enqueueRun(db, cfg, c.env, {
    tenantId,
    agentKey,
    input,
    userId: user.id,
    inputFromRequester: true,
    realtime,
  })
  if (deduplicated && !visible(auth, run)) {
    // Another member holds the exclusive slot: it is busy, and which run that is stays theirs.
    throw new ConflictError(
      `A ${agentKey} run is already queued or running for this organisation`,
      ERROR_CODES.agentRunActive
    )
  }
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

// ---- POST /api/agents/runs/batch ------------------------------------------------------------------

/**
 * Up to `AGENT_RUN_BATCH_MAX` runs of one non-exclusive agent. 202 even when some inputs
 * failed — the items say which, by index — because the rest are already running and a 4xx would
 * read as "nothing happened". A whole-batch refusal (exclusive agent, cap, budget) is still a 4xx
 * and writes nothing. One activity row for the batch, not one per run.
 */
agentsRouter.post('/runs/batch', validate('json', createAgentRunBatchRequestSchema), async c => {
  const { db, cfg, tenantId, user, defer, realtime } = withAuthAndDb(c)
  guardPermission(c, 'create', 'AgentRun')
  const { agentKey, inputs } = c.req.valid('json')
  const { batchId, items } = await enqueueRunBatch(db, cfg, c.env, {
    tenantId,
    agentKey,
    inputs,
    userId: user.id,
    inputFromRequester: true,
    realtime,
  })
  const created = items.filter(item => item.error === null).length
  if (created > 0) {
    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: 'agent_run.batch_requested',
        subjectType: 'AgentRun',
        subjectId: batchId,
        metadata: { agentKey, batchId, created, failed: items.length - created },
      })
    )
  }
  const body: CreateAgentRunBatchResponse = {
    batchId,
    agentKey,
    created,
    failed: items.length - created,
    items: items.map(item => ({
      index: item.index,
      run: item.row ? toAgentRun(item.row) : null,
      error: item.error,
    })),
  }
  return c.json(body, 202)
})

// ---- GET /api/agents/runs/:id ---------------------------------------------------------------------

agentsRouter.get('/runs/:id', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const row = await requireRun(c, uuidParam(c, 'id'))
  // `?events=0` is the bare row: one indexed read instead of the whole log, for a client that is
  // tailing the events over the stream and only wants the row the nudge refreshes. It has no
  // events to prove liveness with, so it reconciles unconditionally.
  if (c.req.query('events') === '0') {
    const bare: AgentRun = toAgentRun(await settleOnRead(c, row))
    return c.json(bare)
  }
  // The log is read BEFORE the settle, because its newest row's timestamp is what buys the Workflow
  // subrequest away; nothing is lost by that, since settling a run writes no event. The asks are
  // read AFTER it, because `expireParkedRun` is exactly the thing that rewrites them.
  const events = await listEvents(db, tenantId, row.id)
  const run = await settleOnRead(c, row, { lastEventAt: events.at(-1)?.at ?? null })
  const [interrupts, artifacts, decisions, usage, requester] = await Promise.all([
    listInterrupts(db, tenantId, run.id),
    listArtifacts(db, tenantId, run.id),
    listDecisions(db, tenantId, run.id),
    runSpend(db, tenantId, run.id),
    // Named through the run, which is already this tenant's and visible to the caller.
    run.requestedByUserId
      ? db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, run.requestedByUserId))
          .then(found => found[0] ?? null)
      : Promise.resolve(null),
  ])
  const body: AgentRunWithEvents = {
    ...toAgentRun(run),
    requestedBy: requester,
    events: events.map(toAgentRunEvent),
    interrupts: interrupts.map(toAgentRunInterrupt),
    artifacts: artifacts.map(toAgentArtifact),
    decisions,
    usage,
  }
  return c.json(body)
})

// ---- GET /api/agents/runs/:id/timeline ------------------------------------------------------------

/**
 * The inspector: every record of the run merged by time, its versions, and its spend against its
 * budget (`runTimeline`). Read-only — it does not settle a lost run, so it shows the row as it is.
 */
agentsRouter.get('/runs/:id/timeline', async c => {
  const { db } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const row = await requireRun(c, uuidParam(c, 'id'))
  const body: AgentRunTimeline = await runTimeline(db, c.get('config'), row)
  return c.json(body)
})

// ---- GET /api/agents/runs/:id/agui ----------------------------------------------------------------

/**
 * The same run as `GET /runs/:id`, projected into AG-UI. Plain JSON, not a stream: a run
 * executes in a Workflow, in a different isolate from any request, so live streaming is a feature
 * rather than a mapping — the WS nudge plus the poll already gives sub-second updates.
 */
agentsRouter.get('/runs/:id/agui', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const row = await requireRun(c, uuidParam(c, 'id'))
  // Log first (it proves liveness), settle, then the asks — `expireParkedRun` rewrites those.
  const events = await listEvents(db, tenantId, row.id)
  const run = await settleOnRead(c, row, { lastEventAt: events.at(-1)?.at ?? null })
  const [interrupts, artifacts] = await Promise.all([
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
 * The same projection, live. GET rather than POST on purpose: `csrf.ts` passes GET, and
 * a third-party AG-UI client can then open it with a bare `EventSource` — which is the only reason
 * `Last-Event-ID` is honoured at all. **`?afterSeq=` wins when both are present**: the app's own
 * client is explicit, and a stale browser value must never override it.
 *
 * Everything that can fail is JSON and happens HERE, above `streamRunAgui` — the ability, the uuid,
 * the 404 for a run this caller cannot see, `reconcileRun` (via `loadRun`, **exactly once, never in
 * the loop**: it is a Workflow subrequest per call) and a garbage cursor. After the first frame the
 * only thing left to say is nothing at all.
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
 * Answer one of a run's asks. **Eight steps, and each is a precondition for the next**
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
 * Step 7 is also where **the answer IS the transition** lives: `resumeRun` flips
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
    const interrupt = run ? await getInterrupt(db, tenantId, runId, interruptId) : null
    // An assignee of THIS ask may see the run though it is not theirs; anyone else needs the run.
    const assigned = interrupt !== null && (await runAssignedTo(db, tenantId, runId, user.id))
    if (!run || (!visible(auth, run) && !assigned)) throw new NotFoundError('Agent run not found')
    if (!interrupt) throw new NotFoundError('Interrupt not found')
    const may = await canAnswerAsk(
      db,
      { id: user.id, isAdminLevel: isAdminLevel(auth) },
      interrupt,
      () => canAnswer(auth, run)
    )
    if (!may) {
      throw new ForbiddenError(
        interrupt.assigneeUserIds.length || interrupt.assigneeGroupIds.length
          ? 'This question is assigned to somebody else'
          : 'Only an administrator may answer this agent'
      )
    }

    const body = c.req.valid('json')
    const payload = validateAnswer(interrupt.spec, body.status, body.payload)

    const resolved = await resolveInterrupt(db, {
      tenantId,
      runId,
      interruptId,
      status: body.status,
      payload,
      resolvedByUserId: user.id,
      realtime,
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
      // still running will read this answer as a row, which is the whole point.
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
 * Send a note to a run in flight. It is an `agent_run_events` row rather
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
/**
 * SQL: the ask is ADDRESSED to this reader — the same people `recipientsFor` notifies. Assigned:
 * the reader is an assignee. Otherwise the agent's `approvers`: `'admin'` (and a run nobody
 * requested) → the organisation's owners and admins by MEMBERSHIP role, so a support visitor or a
 * platform admin is not counted as asked; `'requester'` → whoever started the run.
 */
function addressedTo(db: Database, auth: AuthContext, tenantId: string, userId: string): SQL {
  const isTenantAdmin = auth.tenantUser?.role === 'owner' || auth.tenantUser?.role === 'admin'
  // Plain strings: the column's type is the registry's key union, and the filter narrows nothing.
  const adminKeys: string[] = Object.keys(AGENTS).filter(key => approversFor(key) === 'admin')
  const agentKey = sql<string>`${agentRuns.agentKey}`
  const unassigned = sql`cardinality(${agentRunInterrupts.assigneeUserIds}) = 0 AND cardinality(${agentRunInterrupts.assigneeGroupIds}) = 0`
  const byAgentRule = and(
    eq(agentRuns.tenantId, tenantId),
    isTenantAdmin
      ? or(
          adminKeys.length ? inArray(agentKey, adminKeys) : undefined,
          isNull(agentRuns.requestedByUserId),
          eq(agentRuns.requestedByUserId, userId)
        )
      : and(
          eq(agentRuns.requestedByUserId, userId),
          adminKeys.length ? notInArray(agentKey, adminKeys) : undefined
        )
  )
  return or(
    assignedToSql(tenantId, userId),
    and(
      unassigned,
      inArray(
        agentRunInterrupts.runId,
        db.select({ id: agentRuns.id }).from(agentRuns).where(byAgentRule)
      )
    )
  ) as SQL
}

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
    // The asks of runs the caller may see, and — for a member — every ask assigned to them.
    or(
      inArray(
        agentRunInterrupts.runId,
        db.select({ id: agentRuns.id }).from(agentRuns).where(runsWhere)
      ),
      isAdminLevel(auth) ? undefined : assignedToSql(tenantId, user.id)
    ),
    query.mine ? addressedTo(db, auth, tenantId, user.id) : undefined
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
  // Which of these assigned asks are the caller's: one query, not one per row.
  const assignedRows = rows.filter(
    ({ interrupt }) => interrupt.assigneeUserIds.length || interrupt.assigneeGroupIds.length
  )
  const assignedIds = new Set(
    assignedRows.length
      ? (
          await db
            .select({ id: agentRunInterrupts.id })
            .from(agentRunInterrupts)
            .where(
              and(
                eq(agentRunInterrupts.tenantId, tenantId),
                inArray(
                  agentRunInterrupts.id,
                  assignedRows.map(r => r.interrupt.id)
                ),
                assignedToSql(tenantId, user.id)
              )
            )
        ).map(r => r.id)
      : []
  )
  const items: InterruptInboxItem[] = rows.map(({ interrupt, run }) => ({
    ...toAgentRunInterrupt(interrupt),
    run: {
      id: run.id,
      agentKey: run.agentKey,
      status: run.status,
      requestedByUserId: run.requestedByUserId,
      createdAt: run.createdAt,
    },
    canAnswer:
      interrupt.assigneeUserIds.length || interrupt.assigneeGroupIds.length
        ? isAdminLevel(auth) || assignedIds.has(interrupt.id)
        : canAnswer(auth, run),
  }))
  return c.json(paginated(items, total?.n ?? 0, query))
})

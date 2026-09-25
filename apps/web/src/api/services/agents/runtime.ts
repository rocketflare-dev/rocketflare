/**
 * The agent runtime — the bodies of the three Workflow steps (D7, D16, D17), kept as plain functions
 * over `(db, cfg, env, logger, params)` so tests drive them against Postgres with no platform:
 *   claimStep   — `claimRun` (row is the gate) + a `status: running` event. `false` = nothing to do.
 *   executeRun  — resolve the client for `meta.promptKey` (per-agent model assignment applies),
 *                 `withAgentTrace` + `traceChatClient`, build the `AgentContext`, run the agent,
 *                 validate the output, `finishRun`. Errors are CLASSIFIED: a cancel → `cancelled`;
 *                 a retryable fault (`AiError` unavailable/rate_limit, database unavailable) is
 *                 rethrown so the step retries — but only while `attempt <= EXECUTE_RETRIES`, so the
 *                 last attempt settles the row `failed` instead of escaping; anything else (bad
 *                 credentials, invalid request, a malformed tool answer, agent bugs) → `failed` at
 *                 once — a retry cannot fix it.
 *   finishStep  — two arms, then one last nudge, returning the terminal `{ runId, status }`: a
 *                 `queued|running` row after execute (the step threw past its retries) is marked
 *                 failed; an `awaiting_input` row at the END OF THE WORKFLOW is a park nothing can
 *                 wake any more, and settles `cancelled` with `error` NULL (T7).
 * Progress events are awaited (a Workflow step has no `waitUntil`) and never fail the run.
 *
 * A retry re-enters `executeRun` from the top, so two pieces of `ctx` exist to make that cheap and
 * safe: `ctx.checkpoint` (the tool loop resumes from `agent_runs.checkpoint` rather than replaying
 * every turn) and `ctx.once` (work with a side effect runs once per run, not once per attempt).
 * Carrying the checkpoint's `usage` forward cannot double-bill: the only retryable faults are an
 * `AiError` unavailable/rate_limit or a DB outage, both of which strike INSIDE the loop, before an
 * agent ledgers anything — so those tokens were never recorded, and resuming recovers spend the
 * kit used to lose rather than counting it twice.
 */
import type { AgentRunStatus } from '@rocketflare/shared/ai/agents'
import type { AgentSteeringNote } from '@rocketflare/shared/ai/interrupts'
import { rejectionFor, steeringNoteDataSchema } from '@rocketflare/shared/ai/interrupts'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AgentRunInterruptRow, agentRunEvents, tenants, tenantUsers } from '../../../db/schema'
import { databaseSpanStore } from '../../observability/span-store'
import { rootSpanIdForRun, traceIdForRun } from '../../observability/trace-ids'
import { traceChatClient, tracerFor, withAgentTrace } from '../../observability/tracing'
import { classifyInfrastructureError } from '../../utils/core/errors'
import type { Logger } from '../../utils/core/logger'
import { accessScopeForUser } from '../access'
import { AiError, describeAiError, redactSecrets } from '../ai/errors'
import {
  InterruptDeclinedError,
  InterruptRequested,
  StructuredOutputError,
  type ToolApproval,
} from '../ai/kit'
import { resolveChat } from '../ai/resolve'
import type { AiEnv } from '../ai/types'
import { notifyMany } from '../notifications'
import { resolvePrompt } from '../prompts'
import type { HubEnv, Realtime } from '../realtime'
import { toAgentArtifact, upsertArtifact } from './artifacts'
import {
  approvalsForRun,
  expireInterrupts,
  interruptExpiryFrom,
  requestInterrupt,
} from './interrupts'
import type { AgentContext, AgentEvent, AgentRunEnv } from './registry'
import { getAgent } from './registry'
import {
  AgentCancelledError,
  type AgentRunParams,
  appendEvent,
  cancelRun,
  claimEffect,
  claimRun,
  errorMessage,
  failRun,
  finishRun,
  getRun,
  isCancelRequested,
  lastEventSeq,
  loadCheckpoint,
  nudgeRun,
  parkRun,
  runOnce,
  saveCheckpoint,
} from './runs'
import { buildAgentTools } from './tools'

/** `step.do('execute', { retries: { limit } })` — the runtime counts attempts against the same number. */
export const EXECUTE_RETRIES = 2

/** Everything the runtime reads from the Worker env: hub (nudges), AI binding, queue (ingest). */
export type RuntimeEnv = HubEnv & AiEnv & AgentRunEnv

export interface ExecuteOutcome {
  runId: string
  /**
   * `'awaiting_input'` is a real {@link AgentRunStatus}, not a second vocabulary word like
   * `'interrupted'`: the Workflow loop branches on it to decide whether to `waitForEvent`, and one
   * word that means one thing everywhere is what keeps the row and the outcome in step.
   */
  status: AgentRunStatus | 'skipped'
  error?: string
  /** Set only with `status: 'awaiting_input'` — the asks a person now owes an answer to. */
  interruptIds?: string[]
}

/**
 * A `Realtime` for a Workflow step: nudges are collected and awaited by `settle()` at the end of
 * the step (everything in a step is awaited; there is no `waitUntil`). A failed nudge is logged.
 */
export function createStepRealtime(env: HubEnv, logger: Logger) {
  const pending: Promise<unknown>[] = []
  const realtime: Realtime = {
    env,
    defer: fn => {
      pending.push(fn().catch(err => logger.warn({ err }, 'agent-run: nudge failed')))
    },
  }
  return { realtime, settle: async () => void (await Promise.allSettled(pending.splice(0))) }
}

/** Per-run event writer: continues `seq` from the last stored event; never throws. */
export async function createEmitter(
  db: Database,
  params: AgentRunParams,
  realtime: Realtime,
  logger: Logger
) {
  let seq = await lastEventSeq(db, params.tenantId, params.runId)
  return async (event: AgentEvent): Promise<void> => {
    seq += 1
    try {
      await appendEvent(db, { ...params, seq, type: event.type, data: event.data, realtime })
    } catch (err) {
      logger.warn({ err, seq, type: event.type }, 'agent-run: could not record progress event')
    }
  }
}

/** Step 1: claim the row. `false` when the run was cancelled while queued (or already settled). */
export async function claimStep(
  db: Database,
  env: RuntimeEnv,
  logger: Logger,
  params: AgentRunParams
): Promise<boolean> {
  const row = await claimRun(db, params.tenantId, params.runId)
  if (!row) {
    logger.info(params, 'agent-run: nothing to claim (settled before start)')
    return false
  }
  const { realtime, settle } = createStepRealtime(env, logger)
  const emit = await createEmitter(db, params, realtime, logger)
  await emit({ type: 'status', data: { status: 'running', attempt: row.attempt } })
  await settle()
  return true
}

/** A fault a retry can plausibly fix: the provider was unreachable/overloaded or the DB was down. */
export function isRetryableRunError(err: unknown): boolean {
  if (err instanceof AiError) return err.code === 'unavailable' || err.code === 'rate_limit'
  if (err instanceof StructuredOutputError || err instanceof AgentCancelledError) return false
  // Neither interrupt type is a fault, and retrying either one re-asks a person who has already
  // been asked — or, worse, one who has already said no. They are handled by their own catch arms
  // above this classification; answering `true` here would let a step retry overtake them.
  if (err instanceof InterruptRequested || err instanceof InterruptDeclinedError) return false
  return classifyInfrastructureError(err) === 'database_unavailable'
}

/** The sentence stored on the row / event — provider bodies redacted, never a stack. */
export function describeRunError(err: unknown): string {
  if (err instanceof AiError) return describeAiError(err)
  return redactSecrets(errorMessage(err)).slice(0, 500)
}

/**
 * Steering notes this run has not been handed yet, in the order they were sent, marked delivered as
 * they are read. The cursor is the EXISTING `agent_run_effects` ledger keyed `steering:<eventId>`,
 * which is why steering needs no table of its own (decision 4): the note is an `agent_run_events`
 * row, and "has it been delivered?" is a decision, not a result — `claimEffect`, not `runOnce`.
 *
 * A note whose `data` no longer parses is CLAIMED and skipped rather than retried forever.
 */
export async function takeSteeringNotes(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentSteeringNote[]> {
  const rows = await db
    .select()
    .from(agentRunEvents)
    .where(
      and(
        eq(agentRunEvents.tenantId, tenantId),
        eq(agentRunEvents.runId, runId),
        eq(agentRunEvents.type, 'steering')
      )
    )
    .orderBy(asc(agentRunEvents.seq))
  const notes: AgentSteeringNote[] = []
  for (const row of rows) {
    if (!(await claimEffect(db, tenantId, runId, `steering:${row.id}`))) continue
    const parsed = steeringNoteDataSchema.safeParse(row.data)
    if (!parsed.success) continue
    notes.push({ ...parsed.data, eventId: row.id, at: row.at })
  }
  return notes
}

/**
 * Tell the people who can answer that a run is waiting on them. Inside the `execute` step and
 * AWAITED — a Workflow step has no `waitUntil`.
 *
 * A run with no requester ("system") falls back to the tenant's admins, as does an agent that
 * declares `approvers: 'admin'`. **A parked run nobody is told about is a hung agent**, so there is
 * no branch here that notifies nobody.
 */
async function notifyApprovers(
  db: Database,
  run: { tenantId: string; id: string; requestedByUserId: string | null },
  agentTitle: string,
  approvers: 'requester' | 'admin',
  interrupt: AgentRunInterruptRow,
  realtime: Realtime
): Promise<void> {
  let recipients: string[] = []
  if (approvers === 'requester' && run.requestedByUserId) {
    recipients = [run.requestedByUserId]
  } else {
    const admins = await db
      .select({ userId: tenantUsers.userId })
      .from(tenantUsers)
      .where(
        and(eq(tenantUsers.tenantId, run.tenantId), sql`${tenantUsers.role} IN ('owner', 'admin')`)
      )
    recipients = admins.map(a => a.userId)
  }
  await notifyMany(
    db,
    recipients,
    {
      tenantId: run.tenantId,
      type: 'agent_run_awaiting_input',
      title: `${agentTitle} needs your decision`,
      body: interrupt.message,
      // The run id is what the bell deep-links to: the question is answered on the run page, in
      // front of the timeline that explains why it is being asked.
      data: { runId: run.id, interruptId: interrupt.id },
    },
    realtime
  )
}

/** Step 2: run the agent. Returns the terminal outcome, or throws ONLY to request a step retry. */
export async function executeRun(
  db: Database,
  cfg: AppConfig,
  env: RuntimeEnv,
  logger: Logger,
  params: AgentRunParams,
  /** The Workflow round (`execute#N`) — names this step's span. */
  options: { round?: number } = {}
): Promise<ExecuteOutcome> {
  const { tenantId, runId } = params
  const run = await getRun(db, tenantId, runId)
  if (!run) throw new Error(`agent-run: ${runId} not found in tenant`)
  if (run.status !== 'running') {
    return { runId, status: run.status === 'queued' ? 'skipped' : run.status }
  }
  const agent = getAgent(run.agentKey)
  const { realtime, settle } = createStepRealtime(env, logger)
  const emit = await createEmitter(db, params, realtime, logger)
  // D32: flushed in `finally`, while this step's client is still open — no `waitUntil` in a step.
  const tracer = tracerFor(cfg, { logger, store: databaseSpanStore(db) })
  const checkCancelled = async () => {
    if (await isCancelRequested(db, tenantId, runId)) throw new AgentCancelledError()
  }

  try {
    await checkCancelled()
    const input = agent.meta.inputSchema.parse(run.input)
    const resolved = await resolveChat(db, cfg, env, tenantId, { promptKey: agent.meta.promptKey })
    const toolScope = await accessScopeForUser(db, tenantId, run.requestedByUserId)
    // Answers to this run's gated tool calls, read ONCE per attempt and handed to the agent as
    // `ctx.approvals`. The agent never queries for them, so there is one set of approval rules.
    const approvals: ReadonlyMap<string, ToolApproval> = await approvalsForRun(db, tenantId, runId)
    const interruptExpiresAt = interruptExpiryFrom(cfg.AGENT_INTERRUPT_TIMEOUT)
    const tenant = await db.query.tenants.findFirst({
      columns: { name: true },
      where: eq(tenants.id, tenantId),
    })
    const output = await withAgentTrace(
      agent.meta.key,
      {
        tracer,
        tenantId,
        userId: run.requestedByUserId ?? undefined,
        runId,
        tags: ['agent', agent.meta.key],
        metadata: { attempt: run.attempt, model: resolved.model },
        input,
        // D32: every step of the run joins ONE trace derived from the run id; this span is the
        // step, a child of the root `finishStep` records once the run has settled.
        traceId: traceIdForRun(runId),
        parentSpanId: rootSpanIdForRun(runId),
        spanName: `execute#${options.round ?? 0}`,
        kind: 'span',
      },
      async trace => {
        const client = traceChatClient(
          resolved.client,
          trace,
          { provider: resolved.provider },
          tracer
        )
        const ctx: AgentContext = {
          db,
          cfg,
          env,
          logger: logger.child({ runId, agentKey: agent.meta.key }),
          tracer,
          tenantId,
          runId,
          userId: run.requestedByUserId,
          input,
          emit,
          checkCancelled,
          chat: { client, model: resolved.model, maxOutputTokens: resolved.maxOutputTokens },
          // D29: built here, at EXECUTE time, from the run's requester — current membership, not
          // a snapshot taken when the run was enqueued. No requester ("system") reads tenant-wide
          // documents only, never an owner's restricted ones.
          tools: await buildAgentTools({ db, cfg, env, scope: toolScope }),
          checkpoint: {
            load: () => loadCheckpoint(db, tenantId, runId),
            save: cp => saveCheckpoint(db, tenantId, runId, cp),
          },
          once: (key, fn) => runOnce(db, tenantId, runId, key, fn),
          approvals,
          interrupt: async ask => {
            // Create-or-read on `(run_id, key)`: the SECOND time this line runs — a resumed or
            // retried attempt re-entering `run()` from the top — it finds the answer (T2).
            const row = await requestInterrupt(db, {
              tenantId,
              runId,
              key: ask.key,
              spec: ask.spec,
              toolCallId: ask.toolCallId ?? null,
              expiresAt: interruptExpiresAt,
            })
            if (row.status === 'pending') {
              throw new InterruptRequested([
                {
                  key: row.key,
                  spec: row.spec,
                  ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
                },
              ])
            }
            if (row.status === 'resolved') {
              return {
                interruptId: row.id,
                status: 'resolved',
                payload: row.payload ?? null,
                resolvedByUserId: row.resolvedByUserId,
              }
            }
            // `cancelled` and `expired` take the same path: nobody is going to answer this, and
            // what that MEANS is the ask's own rejection semantics. `cancel_run` stops the run;
            // everything else hands the refusal back so the agent can try another route.
            if (rejectionFor(row.spec) === 'cancel_run') {
              const payload = (row.payload ?? {}) as { note?: string }
              throw new InterruptDeclinedError(row.id, payload.note)
            }
            return {
              interruptId: row.id,
              status: 'cancelled',
              payload: row.payload ?? null,
              resolvedByUserId: row.resolvedByUserId,
            }
          },
          steering: () => takeSteeringNotes(db, tenantId, runId),
          artifact: async input => {
            const row = await upsertArtifact(db, tenantId, runId, input)
            await emit({
              type: 'artifact',
              data: { artifactId: row.id, key: row.key, kind: row.kind, title: row.title },
            })
            return toAgentArtifact(row)
          },
          prompt: vars =>
            resolvePrompt(db, tenantId, agent.meta.promptKey as 'summarize-text', {
              appName: cfg.APP_NAME,
              tenantName: tenant?.name ?? '',
              ...vars,
            }),
          step: (key, label, status, detail) =>
            emit({ type: 'step', data: { key, label, status, ...(detail ? { detail } : {}) } }),
        }
        return agent.meta.outputSchema.parse(await agent.run(ctx))
      }
    )
    const settled = await finishRun(db, tenantId, runId, output)
    // The row may have been cancelled from outside during the final write; report what it says.
    const status: AgentRunStatus = settled?.status ?? 'cancelled'
    await emit({ type: 'status', data: { status } })
    return { runId, status }
  } catch (err) {
    if (err instanceof AgentCancelledError) {
      await cancelRun(db, tenantId, runId)
      await expireInterrupts(db, tenantId, runId)
      await emit({ type: 'status', data: { status: 'cancelled' } })
      return { runId, status: 'cancelled' }
    }
    // Park (issue #17). **The order below is the safety property**: a row with no parked run
    // simply re-asks on the next attempt, while a parked run with no row is a hang — nothing for
    // anybody to answer and a seven-day `waitForEvent` to sit through. So the rows go first.
    if (err instanceof InterruptRequested) {
      const rows = []
      for (const request of err.requests) {
        rows.push(
          await requestInterrupt(db, {
            tenantId,
            runId,
            key: request.key,
            spec: request.spec,
            toolCallId: request.toolCallId ?? null,
            expiresAt: interruptExpiryFrom(cfg.AGENT_INTERRUPT_TIMEOUT),
          })
        )
      }
      // NOT `settle()`: `finishedAt` stays NULL and the checkpoint survives, which is what makes
      // the resumed attempt cheap (T7).
      const parked = await parkRun(db, tenantId, runId)
      if (!parked) {
        // Settled underneath us — cancelled from outside while the gate was being raised. The row
        // is the truth: expire the questions nobody will answer and report what it says.
        await expireInterrupts(db, tenantId, runId)
        const current = await getRun(db, tenantId, runId)
        return { runId, status: current?.status ?? 'cancelled' }
      }
      const agentTitle = agent.meta.title
      const approverPolicy = agent.meta.approvers ?? 'requester'
      for (const row of rows) {
        await emit({
          type: 'interrupt',
          data: {
            interruptId: row.id,
            key: row.key,
            kind: row.kind,
            message: row.message,
            toolCallId: row.toolCallId,
            expiresAt: row.expiresAt,
          },
        })
        // A re-entered `execute` re-raises the same ask; `claimEffect` is what stops it also
        // re-notifying everybody who was told the first time.
        if (await claimEffect(db, tenantId, runId, `notify:${row.id}`)) {
          try {
            await notifyApprovers(db, run, agentTitle, approverPolicy, row, realtime)
          } catch (notifyErr) {
            logger.warn({ err: notifyErr }, 'agent-run: could not notify approvers')
          }
        }
      }
      await emit({ type: 'status', data: { status: 'awaiting_input' } })
      return { runId, status: 'awaiting_input', interruptIds: rows.map(row => row.id) }
    }
    if (err instanceof InterruptDeclinedError) {
      // A refusal is a STATUS, not a message: `agent_runs.error` stays NULL and the reason lives
      // on the event row, so the UI never renders "this run failed because a person said no".
      await cancelRun(db, tenantId, runId)
      await expireInterrupts(db, tenantId, runId)
      await emit({ type: 'status', data: { status: 'cancelled', reason: 'rejected' } })
      return { runId, status: 'cancelled' }
    }
    const message = describeRunError(err)
    // A structured-output failure carries the zod issues: the one thing a person needs to see.
    const details = err instanceof StructuredOutputError ? err.issues : undefined
    if (isRetryableRunError(err) && run.attempt <= EXECUTE_RETRIES) {
      logger.warn({ err, attempt: run.attempt }, 'agent-run: retryable failure, step will retry')
      await emit({ type: 'error', data: { message, attempt: run.attempt, willRetry: true } })
      await settle()
      throw err
    }
    logger.warn({ err, details, attempt: run.attempt }, 'agent-run: failed')
    await failRun(db, tenantId, runId, message)
    await emit({
      type: 'error',
      data: { message, attempt: run.attempt, willRetry: false, ...(details ? { details } : {}) },
    })
    await emit({ type: 'status', data: { status: 'failed' } })
    return { runId, status: 'failed', error: message }
  } finally {
    await settle()
    await tracer.flush()
  }
}

/**
 * The last step: settle anything the loop left unsettled, and nudge one last time.
 *
 * **Two arms, and the difference between them is T7.** The backstop predicate stays
 * `queued | running` — widening it to `ACTIVE_RUN_STATUSES` would turn every legitimately
 * parked run into a `failed` row. A row that is `awaiting_input` when the WORKFLOW IS ENDING is a
 * different fact: the instance that would have woken it is finishing, so nobody can ever resume it.
 * That is the expiry arm — `cancelled` with **`error` NULL**, because a cancel is a status, not a
 * message, and the reason goes on a `status` event row where the UI can render it as one. The one
 * exception is a park the loop ABANDONED (`MAX_INTERRUPT_ROUNDS`), which arrives with
 * `outcome.status === 'failed'`: a runaway agent is a bug and belongs in the failed bucket with a
 * sentence explaining itself. It is the OUTCOME that says so, never the row.
 *
 * Called twice on the expiry path (once as `expire#N`, once as `finish`) and idempotent: the second
 * call finds a settled row and only nudges.
 */
export async function finishStep(
  db: Database,
  env: RuntimeEnv,
  logger: Logger,
  params: AgentRunParams,
  outcome?: ExecuteOutcome,
  /**
   * D32: given ONLY by the workflow's final `finish` step, which records the run's root span
   * (`invoke_agent <key>`) — the expiry arm calls this too, and one root per run is the point.
   */
  trace?: { cfg: AppConfig }
): Promise<ExecuteOutcome> {
  const { tenantId, runId } = params
  const { realtime, settle } = createStepRealtime(env, logger)
  let row = await getRun(db, tenantId, runId)
  // The workflow is ENDING. A row still parked at this point can never be woken — the instance
  // that would have heard the answer is finishing — so the open asks go either way.
  if (row?.status === 'awaiting_input') await expireInterrupts(db, tenantId, runId)
  // The one case where a parked row is a FAILURE rather than an expiry: the loop gave up on an
  // agent that kept asking (`MAX_INTERRUPT_ROUNDS`) and said so in the outcome. It is the outcome
  // that decides, never the row's status — widening the predicate below is T7.
  const abandoned = row?.status === 'awaiting_input' && outcome?.status === 'failed'
  // T7: NOT `ACTIVE_RUN_STATUSES`. A parked run is not a failure, and this list must never grow.
  if (row && (row.status === 'queued' || row.status === 'running' || abandoned)) {
    const message =
      outcome?.error ?? 'The agent run did not complete (execute step exhausted its retries)'
    row = (await failRun(db, tenantId, runId, message)) ?? row
    const emit = await createEmitter(db, params, realtime, logger)
    await emit({ type: 'error', data: { message, willRetry: false } })
    await emit({ type: 'status', data: { status: 'failed' } })
  } else if (row && row.status === 'awaiting_input') {
    row = (await cancelRun(db, tenantId, runId)) ?? row
    const emit = await createEmitter(db, params, realtime, logger)
    await emit({ type: 'status', data: { status: 'cancelled', reason: 'expired' } })
  }
  nudgeRun(realtime, tenantId, runId)
  await settle()
  if (trace && row) await recordRunRoot(db, trace.cfg, logger, row)
  return {
    runId,
    status: row?.status ?? outcome?.status ?? 'failed',
    error: row?.error ?? undefined,
  }
}

/**
 * The run's root span (D32): `invoke_agent <key>` from the first claim to now, with the run's
 * input and output, an error status when it failed, and the settled status as an attribute. Its id
 * is derived from the run id, so the `execute#N` spans every earlier step recorded — each in its
 * own Worker invocation — already point at it. Never throws: a trace is not worth a failed step.
 */
export async function recordRunRoot(
  db: Database,
  cfg: AppConfig,
  logger: Logger,
  run: {
    id: string
    tenantId: string
    agentKey: string
    status: AgentRunStatus
    input: unknown
    output: unknown
    error: string | null
    requestedByUserId: string | null
    startedAt: Date | null
    createdAt: Date
    attempt: number
  }
): Promise<void> {
  try {
    const tracer = tracerFor(cfg, { logger, store: databaseSpanStore(db) })
    if (!tracer.enabled) return
    const root = tracer.startTrace({
      name: run.agentKey,
      tenantId: run.tenantId,
      userId: run.requestedByUserId ?? undefined,
      runId: run.id,
      tags: ['agent', run.agentKey],
      metadata: { status: run.status, attempts: run.attempt },
      input: run.input,
      traceId: traceIdForRun(run.id),
      spanId: rootSpanIdForRun(run.id),
      startTime: run.startedAt ?? run.createdAt,
    })
    root.end(
      run.status === 'failed'
        ? { error: run.error ?? 'The agent run failed' }
        : { output: run.output ?? undefined }
    )
    await tracer.flush()
  } catch (err) {
    logger.warn({ err, runId: run.id }, 'agent-run: could not record the trace root')
  }
}

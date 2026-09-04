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
 *   finishStep  — backstop: an ACTIVE row after execute (the step threw past its retries) is marked
 *                 failed; then one last nudge. Returns the terminal `{ runId, status }`.
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
import { eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { tenants } from '../../../db/schema'
import { traceChatClient, tracerFor, withAgentTrace } from '../../observability/tracing'
import { classifyInfrastructureError } from '../../utils/core/errors'
import type { Logger } from '../../utils/core/logger'
import { AiError, describeAiError, redactSecrets } from '../ai/errors'
import { StructuredOutputError } from '../ai/kit'
import { resolveChat } from '../ai/resolve'
import type { AiEnv } from '../ai/types'
import { resolvePrompt } from '../prompts'
import type { HubEnv, Realtime } from '../realtime'
import type { AgentContext, AgentEvent, AgentRunEnv } from './registry'
import { getAgent } from './registry'
import {
  AgentCancelledError,
  type AgentRunParams,
  appendEvent,
  cancelRun,
  claimRun,
  errorMessage,
  failRun,
  finishRun,
  getRun,
  isCancelRequested,
  lastEventSeq,
  loadCheckpoint,
  nudgeRun,
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
  status: AgentRunStatus | 'skipped'
  error?: string
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
  return classifyInfrastructureError(err) === 'database_unavailable'
}

/** The sentence stored on the row / event — provider bodies redacted, never a stack. */
export function describeRunError(err: unknown): string {
  if (err instanceof AiError) return describeAiError(err)
  return redactSecrets(errorMessage(err)).slice(0, 500)
}

/** Step 2: run the agent. Returns the terminal outcome, or throws ONLY to request a step retry. */
export async function executeRun(
  db: Database,
  cfg: AppConfig,
  env: RuntimeEnv,
  logger: Logger,
  params: AgentRunParams
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
  const tracer = tracerFor(cfg, { logger })
  const checkCancelled = async () => {
    if (await isCancelRequested(db, tenantId, runId)) throw new AgentCancelledError()
  }

  try {
    await checkCancelled()
    const input = agent.meta.inputSchema.parse(run.input)
    const resolved = await resolveChat(db, cfg, env, tenantId, { promptKey: agent.meta.promptKey })
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
        sessionId: runId,
        tags: ['agent', agent.meta.key],
        metadata: { runId, attempt: run.attempt, model: resolved.model },
        input,
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
          tools: buildAgentTools({ db, cfg, env, tenantId }),
          checkpoint: {
            load: () => loadCheckpoint(db, tenantId, runId),
            save: cp => saveCheckpoint(db, tenantId, runId, cp),
          },
          once: (key, fn) => runOnce(db, tenantId, runId, key, fn),
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
      await emit({ type: 'status', data: { status: 'cancelled' } })
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

/** Step 3: settle anything still active (execute escaped its retries) and nudge one last time. */
export async function finishStep(
  db: Database,
  env: RuntimeEnv,
  logger: Logger,
  params: AgentRunParams,
  outcome?: ExecuteOutcome
): Promise<ExecuteOutcome> {
  const { tenantId, runId } = params
  const { realtime, settle } = createStepRealtime(env, logger)
  let row = await getRun(db, tenantId, runId)
  if (row && (row.status === 'queued' || row.status === 'running')) {
    const message =
      outcome?.error ?? 'The agent run did not complete (execute step exhausted its retries)'
    row = (await failRun(db, tenantId, runId, message)) ?? row
    const emit = await createEmitter(db, params, realtime, logger)
    await emit({ type: 'error', data: { message, willRetry: false } })
    await emit({ type: 'status', data: { status: 'failed' } })
  }
  nudgeRun(realtime, tenantId, runId)
  await settle()
  return {
    runId,
    status: row?.status ?? outcome?.status ?? 'failed',
    error: row?.error ?? undefined,
  }
}

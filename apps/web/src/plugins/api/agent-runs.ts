/**
 * `startAgentRun` — how a plugin starts an agent run from somewhere with no HTTP request:
 * a queue job, a cron task, an inbound email, a public webhook.
 *
 * It is the route's own handoff (`POST /api/agents/runs` → `enqueueRun`), not a second one, so
 * everything the route enforces applies here too: the input is validated against the agent's
 * `inputSchema` (400), an exclusive agent answers its active run, the tenant's active-run cap is a
 * 429 `agent_runs_limit` and its daily spend a 429 `ai_budget_exceeded`, a missing
 * `AGENT_RUN_WORKFLOW` binding is a 503 `agent_runs_not_configured` before any write, and the run
 * goes onto the Workflow. The caller never runs the agent. In a job those errors are throws, which
 * means retry with backoff — usually what a cap or a budget wants.
 *
 * **Pass an `idempotencyKey` from a job.** A queue delivers at least once, so the same message can
 * run twice; with a key the run id is derived from (tenant, agent, key), and the second delivery
 * gets the first one's run back (`deduplicated: true`) instead of starting another. Make the key
 * name the WORK — `receipt:<documentId>` — not the message, so a re-enqueued job is caught too.
 *
 * This module names `services/agents/**`, which lives inside the deletable `feature-agents`
 * surface — the same dependency `./ai` carries. `.rocketflare.json` lists the method in that
 * surface's `registries[]`, so an app that deletes the agent runtime deletes `startAgentRun` with it.
 *
 * The runtime is reached through a FUNCTION-SCOPE `await import(...)`, for the reason `./http`'s
 * visibility methods give: `services/agents/registry` composes the agent table by reading the
 * plugin barrel, every plugin imports this module through `@/plugins/api`, and a static import
 * here would close that cycle — `serverPlugins` read before the barrel has finished evaluating.
 */

import type { AgentKey, AgentRunStatus, BindableAgent } from '@rocketflare/shared/ai/agents'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { recordActivity } from '../../api/services/activity'
import type { EventName } from '../../api/services/events/registry'
import type { AgentEventBinding, AgentEventTrigger } from '../../api/services/events/types'
import { BadRequestError } from '../../api/utils/core/errors'
import { createStepRealtimeFor } from './realtime-step'
import type { PluginContext } from './types'

export interface StartAgentRunInput {
  /** A core agent's key or one an installed plugin declared in its `SharedPlugin.agentKeys`. */
  agentKey: AgentKey
  /** The organisation the run belongs to — from the job's payload, never ambient. */
  tenantId: string
  /** Validated against the agent's `inputSchema` here, and again before `run()`. */
  input: unknown
  /**
   * At most one run EVER per (tenant, agent, key): a second call returns the first call's run,
   * whatever its status. Name the work (`receipt:<documentId>`), not the delivery.
   */
  idempotencyKey?: string
  /**
   * At most one ACTIVE run per (tenant, agent, key) — the exclusive slot, narrowed. A new run may
   * start once the previous one settles, which `idempotencyKey` never allows.
   */
  concurrencyKey?: string
  /**
   * The user the run is on behalf of — `agent_runs.requested_by_user_id`, and the requester whose
   * CURRENT access the run's tools are scoped to. Omitted, the run is system-triggered (`null`)
   * and the built-in knowledge tools read tenant-visible documents only.
   */
  triggeredBy?: string | null
}

export interface StartedAgentRun {
  runId: string
  /** `queued` for a new run; whatever the existing run's status is when `deduplicated`. */
  status: AgentRunStatus
  /**
   * The run already existed — the same `idempotencyKey`, or an active run holding the exclusive
   * slot — and `runId` is THAT run. Nothing new was started.
   */
  deduplicated: boolean
}

export type StartAgentRun = (input: StartAgentRunInput) => Promise<StartedAgentRun>

/**
 * Build `startAgentRun` for one background context. A started run is nudged to the tenant's open
 * tabs (awaited — there is no `waitUntil` to hang it on) and leaves an `agent_run.requested`
 * activity row, as the route does (a failure to write it is logged, never thrown); a deduplicated
 * one does neither.
 */
export function agentRunStarter({ db, config, env, logger }: PluginContext): StartAgentRun {
  return async input => {
    const [{ isAgentKey }, { enqueueRun }] = await Promise.all([
      import('../../api/services/agents/registry'),
      import('../../api/services/agents/runs'),
    ])
    if (!isAgentKey(input.agentKey)) {
      throw new BadRequestError(
        `Unknown agent: ${String(input.agentKey)}`,
        ERROR_CODES.validationFailed,
        { agentKey: input.agentKey }
      )
    }
    const step = createStepRealtimeFor(env)
    const userId = input.triggeredBy ?? null
    const { run, deduplicated } = await enqueueRun(db, config, env, {
      tenantId: input.tenantId,
      agentKey: input.agentKey,
      input: input.input,
      userId,
      realtime: step.realtime,
      ...(input.concurrencyKey !== undefined && { concurrencyKey: input.concurrencyKey }),
      ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
    })
    await step.settle()
    if (!deduplicated) {
      // Logged, never thrown: the run has started, and a throw here would make a job retry —
      // which, without an `idempotencyKey`, starts it a second time.
      await recordActivity(db, {
        tenantId: input.tenantId,
        userId,
        type: 'agent_run.requested',
        subjectType: 'AgentRun',
        subjectId: run.id,
        metadata: { agentKey: input.agentKey, via: 'plugin' },
      }).catch(err =>
        logger.warn({ err, runId: run.id }, 'startAgentRun: could not record the activity row')
      )
    }
    return { runId: run.id, status: run.status, deduplicated }
  }
}

// ---- Agents started by plugin events (D42) -----------------------------------------------------

/**
 * Declare an AUTOMATIC start in an agent definition: `triggers: [eventTrigger('sites.form.submitted',
 * { where: p => p.formName === 'contact', input: p => ({ text: p.fields.message }) })]`. Every
 * matching event starts one run, idempotent per (event, agent), through the same gates as the
 * route. Typed by the event's declared payload; the agent's `inputSchema` validates what `input`
 * returns (an invalid one is logged and acknowledged — the delivery does not retry it).
 */
export function eventTrigger<E extends EventName, Input = unknown>(
  event: E,
  spec: Omit<AgentEventTrigger<E, Input>, 'event'>
): AgentEventTrigger<E, Input> {
  return { ...spec, event }
}

/**
 * Declare an OPT-IN: this agent may be started by `event` when a subject names it (an editor's
 * "On submit, start" choice) — never by the event alone. Listed by `listBindableAgents(event)` and
 * `GET /api/agents/bindable?event=`; started by `EventCtx.startBoundAgent(key)`.
 */
export function eventBinding<E extends EventName, Input = unknown>(
  event: E,
  spec: Omit<AgentEventBinding<E, Input>, 'event'>
): AgentEventBinding<E, Input> {
  return { ...spec, event }
}

/**
 * The agents that opt in (`bindable`) to being started by `event` — what an editor's agent picker
 * lists. The same list for every tenant: agents are code. A browser reads it through
 * `GET /api/agents/bindable?event=` (`read AgentRun`), which answers this.
 */
export async function listBindableAgents(event: EventName | string): Promise<BindableAgent[]> {
  const { bindableAgents } = await import('../../api/services/agents/triggers')
  return bindableAgents(event)
}

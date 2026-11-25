/**
 * Agents started by plugin events (D42): an agent's `triggers` (automatic) and `bindable`
 * (opt-in, started only when a subject names the agent).
 *
 * Both paths end in the route's own `enqueueRun`, so everything `POST /api/agents/runs` enforces
 * applies: the agent's `inputSchema` validates what `input(payload)` built (400), an exclusive
 * agent answers its active run, the active-run cap (429 `agent_runs_limit`), the daily budget (429
 * `ai_budget_exceeded`), the Workflow binding (503). **The idempotency key is `event:<event id>`**,
 * the same for both paths, so an event starts an agent at most once however it was reached and
 * however often the delivery is retried. The run has no requester and carries the event as
 * `trigger_event` / `trigger_event_id`; its activity row says `via: 'event'` and names it.
 *
 * Inside `feature-agents`: an app that deletes the agent runtime deletes this file and the
 * `agentTriggerSubscribers` line in `services/events/subscribers.ts` (`.rocketflare.json`).
 */
import type { AgentKey, BindableAgent } from '@rocketflare/shared/ai/agents'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { JobContext } from '../../queues/jobs'
import type { AppBindings } from '../../types'
import { ForbiddenError } from '../../utils/core/errors'
import type { Logger } from '../../utils/core/logger'
import { recordActivity } from '../activity'
import type { EventSubscriber } from '../events/subscribers'
import type { AgentEventTrigger, DeliveredEvent } from '../events/types'
import type { Realtime } from '../realtime'
import { AGENTS, type AnyAgentDefinition, isAgentKey } from './registry'
import { enqueueRun } from './runs'

/** What a started run answers — `StartedAgentRun` in the plugin API. */
export interface EventRunResult {
  runId: string
  status: Awaited<ReturnType<typeof enqueueRun>>['run']['status']
  deduplicated: boolean
}

interface StartContext {
  db: Database
  config: AppConfig
  env: AppBindings
  logger: Pick<Logger, 'warn'>
}

/** The idempotency key an event's runs share: one run per (tenant, agent, event). */
export const eventRunKey = (eventId: string) => `event:${eventId}`

/** Start `agent` for `event` with `input` — the shared tail of both paths. */
async function startForEvent(
  ctx: StartContext,
  agentKey: AgentKey,
  event: DeliveredEvent,
  input: unknown,
  mode: 'trigger' | 'bindable'
): Promise<EventRunResult> {
  // A collecting realtime, settled below: a job has no `waitUntil` to hang a nudge on.
  const pending: Promise<unknown>[] = []
  const realtime: Realtime = { defer: fn => void pending.push(fn().catch(() => {})), env: ctx.env }
  const { run, deduplicated } = await enqueueRun(ctx.db, ctx.config, ctx.env, {
    tenantId: event.tenantId,
    agentKey,
    input,
    userId: null,
    realtime,
    idempotencyKey: eventRunKey(event.id),
    trigger: { event: event.name, eventId: event.id },
  })
  await Promise.all(pending)
  if (!deduplicated) {
    // Logged, never thrown: the run has started, and a throw would make the delivery retry.
    await recordActivity(ctx.db, {
      tenantId: event.tenantId,
      userId: null,
      type: 'agent_run.requested',
      subjectType: 'AgentRun',
      subjectId: run.id,
      metadata: { agentKey, via: 'event', event: event.name, eventId: event.id, mode },
    }).catch(err =>
      ctx.logger.warn({ err, runId: run.id }, 'event run: could not record the activity row')
    )
  }
  return { runId: run.id, status: run.status, deduplicated }
}

/** One subscriber per (agent, trigger), id `trigger:<agent key>:<index>`. */
export function agentTriggerSubscribers(
  agents: Readonly<Record<string, AnyAgentDefinition>> = AGENTS
): EventSubscriber[] {
  return Object.values(agents).flatMap(agent =>
    (agent.triggers ?? []).map(
      (trigger, index): EventSubscriber => ({
        id: `trigger:${agent.meta.key}:${index}`,
        event: trigger.event,
        deliver: async (event, ctx) => {
          await runTrigger(agent, trigger, event, ctx)
        },
      })
    )
  )
}

/**
 * Deliver one event to one trigger. `where` false → nothing, acknowledged. `where` or `input`
 * throwing is a bug in the agent's declaration: it throws, so the delivery retries and the log
 * names the agent. A refusal from `enqueueRun` (invalid input 400) is acknowledged by the delivery
 * job; a cap, a budget or a missing binding retries.
 */
export async function runTrigger(
  agent: AnyAgentDefinition,
  trigger: AgentEventTrigger,
  event: DeliveredEvent,
  ctx: JobContext
): Promise<EventRunResult | null> {
  if (trigger.where && !trigger.where(event.payload)) return null
  return startForEvent(ctx, agent.meta.key, event, trigger.input(event.payload), 'trigger')
}

/** The agents that opt in to being started by `event` — the "On submit, start" picker's list. */
export function bindableAgents(
  event: string,
  agents: Readonly<Record<string, AnyAgentDefinition>> = AGENTS
): BindableAgent[] {
  return Object.values(agents)
    .filter(agent => (agent.bindable ?? []).some(b => b.event === event))
    .map(agent => ({
      key: agent.meta.key,
      title: agent.meta.title,
      description: agent.meta.description,
    }))
}

/**
 * Start the agent a SUBJECT named for this event — a form block's "On submit, start" choice.
 * The key is re-checked here, on the server, against the agent's own `bindable` list: an unknown
 * key and an agent that does not opt in to THIS event are the same 403 `agent_not_bindable`, so a
 * forged key starts nothing and learns nothing. `event` is the delivery's own, read from
 * `plugin_events` under its tenant — never one the caller supplied.
 */
export async function startBoundAgent(
  ctx: StartContext,
  event: DeliveredEvent,
  agentKey: string
): Promise<EventRunResult> {
  const binding = isAgentKey(agentKey)
    ? AGENTS[agentKey].bindable?.find(b => b.event === event.name)
    : undefined
  if (!binding) {
    throw new ForbiddenError(
      `That agent cannot be started by ${event.name}`,
      ERROR_CODES.agentNotBindable
    )
  }
  return startForEvent(ctx, agentKey as AgentKey, event, binding.input(event.payload), 'bindable')
}

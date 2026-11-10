/**
 * Plugin events (D42): `ctx.emit` on every context, and `EventCtx` for a
 * `ServerPlugin.eventHandlers` entry — "something happened in a plugin" as a durable, declared,
 * tenant-scoped fact that other plugins, the app and agents can subscribe to, the way an inbound
 * email is something that happened outside.
 *
 * - **Declare** the event in the plugin's shared entry: `events: { 'sites.form.submitted': schema }`
 *   (`<id>.<name>`, never `kit.`), and list the names in `plugin.json` `"events"`.
 * - **Emit** with `ctx.emit(name, { payload, idempotencyKey? })` from a route, a run or a tool (the
 *   tenant is the context's), or `{ tenantId, payload, … }` from a job, cron, email or public
 *   handler. It validates, records a `plugin_events` row and queues one delivery per subscriber;
 *   it never runs a handler. Name the THING in the key (`submission:<id>`) so a retried route is
 *   caught.
 * - **Subscribe** with `eventHandlers: [{ event, name, handle }]`; `handle(event, ctx)` adapts with
 *   `eventCtx(ctx)`. An agent subscribes with `triggers: [eventTrigger(...)]`, or opts in to a
 *   no-code picker with `bindable: [eventBinding(...)]` (`./agent-runs`).
 *
 * The payload may hold personal data (a form's fields): it is kept `EVENTS_RETENTION_DAYS` (7),
 * travels in no queue message, and must never reach a log line of yours either.
 */

import type { AgentKey } from '@rocketflare/shared/ai/agents'
import type { JobEnvelope, JobInput } from '@rocketflare/shared/jobs'
import { emitEvent } from '../../api/services/events/emit'
import type {
  DeliveredEvent,
  Emit,
  EventContext,
  TenantEmit,
} from '../../api/services/events/types'
import { tenantFeatures } from '../../api/services/features'
import { enqueueJob, enqueueJobs } from '../../api/services/jobs'
import type { StorageService } from '../../api/services/storage'
import { agentRunStarter, type StartAgentRunInput, type StartedAgentRun } from './agent-runs'
import { createStepRealtimeFor } from './realtime-step'
import { filesStorage } from './storage'
import type { PluginContext } from './types'

export type { EventName, EventPayload } from '../../api/services/events/registry'
export type {
  AgentEventBinding,
  AgentEventTrigger,
  DeliveredEvent,
  Emit,
  EmitInput,
  EmittedEvent,
  EventContext,
  EventHandler,
  TenantEmit,
  TenantEmitInput,
} from '../../api/services/events/types'

/** The background `emit` — the tenant named per call. Shared by every background context. */
export function eventEmitter({ db, env, logger }: PluginContext): Emit {
  return (event, input) =>
    emitEvent(
      db,
      env,
      {
        name: event,
        tenantId: input.tenantId,
        payload: input.payload,
        ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
      },
      logger
    )
}

/** The same, bound to one tenant — a request's, a run's, a delivered event's. */
export function tenantEmitter(ctx: PluginContext, tenantId: string): TenantEmit {
  const emit = eventEmitter(ctx)
  return (event, input) => emit(event, { ...input, tenantId })
}

/**
 * What an event handler works with, BOUND to the delivered event's tenant: nothing on it takes a
 * tenant id, so a handler cannot reach another organisation through a method by accident (its
 * queries still carry `tenantId` — `ctx.db` is the job's unscoped handle, as in every context).
 */
export interface EventCtx extends PluginContext {
  /** The event's organisation — the tenant predicate of every query the handler writes. */
  readonly tenantId: string
  enqueue(input: JobInput, options?: { delaySeconds?: number }): Promise<JobEnvelope>
  enqueueMany(inputs: readonly JobInput[], options?: { delaySeconds?: number }): Promise<void>
  /** Nudge this organisation's open tabs. Awaited — there is no `waitUntil` in a job. */
  nudge(entity: string, id?: string): Promise<void>
  /** Emit a follow-on event in the same organisation. */
  emit: TenantEmit
  /** The organisation's feature keys — skip the work when your flag is off for it. */
  features(): Promise<readonly string[]>
  /** R2; write under `tenants/<ctx.tenantId>/<plugin id>/…`. */
  storage(): StorageService
  durableObject<T extends Rpc.DurableObjectBranded | undefined = undefined>(
    namespace: DurableObjectNamespace<T>,
    key?: string
  ): DurableObjectStub<T>
  /**
   * `startAgentRun` in this organisation (the route's own gates; each refusal throws). Pass an
   * `idempotencyKey` derived from `event.id`. For "this event starts that agent" prefer the
   * agent's own `triggers`, which needs no handler at all.
   */
  startAgentRun(input: Omit<StartAgentRunInput, 'tenantId'>): Promise<StartedAgentRun>
  /**
   * Start the agent a SUBJECT named for THIS event — the form block's "On submit, start" choice,
   * read from the plugin's own stored, published configuration, never from the payload a visitor
   * sent. The host re-checks that the agent declares `bindable` for this event: an unknown key and
   * one that does not opt in are both a 403 `agent_not_bindable` (acknowledged, never retried).
   * Idempotent per (event, agent), shared with `triggers`; the run records the event.
   */
  startBoundAgent(agentKey: AgentKey | string): Promise<StartedAgentRun>
}

/** Adapt the host's `EventContext`. The only place a plugin's event half names a core internal. */
export function eventCtx(ctx: EventContext): EventCtx {
  const base: PluginContext = { db: ctx.db, config: ctx.config, logger: ctx.logger, env: ctx.env }
  const event: DeliveredEvent = ctx.event
  const tenantId = event.tenantId
  const start = agentRunStarter(base)
  return {
    ...base,
    tenantId,
    enqueue: (input, options) => enqueueJob(ctx.env.JOBS_QUEUE, input, options),
    enqueueMany: async (inputs, options) => {
      await enqueueJobs(ctx.env.JOBS_QUEUE, inputs, options)
    },
    nudge: async (entity, id) => {
      await createStepRealtimeFor(ctx.env).nudgeEntity(tenantId, entity, id)
    },
    emit: tenantEmitter(base, tenantId),
    features: () => tenantFeatures(ctx.db, ctx.config, tenantId),
    storage: () => filesStorage(ctx.env),
    durableObject: (namespace, key) =>
      namespace.get(namespace.idFromName(key ? `${tenantId}:${key}` : tenantId)),
    startAgentRun: input => start({ ...input, tenantId }),
    startBoundAgent: async agentKey => {
      // Function-scope, for the reason `./agent-runs` gives: the agent registry reads the barrel.
      const { startBoundAgent } = await import('../../api/services/agents/triggers')
      return startBoundAgent(base, event, agentKey)
    },
  }
}

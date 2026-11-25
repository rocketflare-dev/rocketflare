/**
 * The shapes of the plugin event seam (D42), type-only so every side can name them without
 * importing a module that reads a barrel: `plugins/types.ts` (`ServerPlugin.eventHandlers`), the
 * agent registry (`triggers`, `bindable`), the subscriber registry and the delivery job.
 */
import type { JobContext } from '../../queues/jobs'
import type { EventName, EventPayload } from './registry'

/** One recorded event, as a subscriber receives it: re-read from `plugin_events`, re-validated. */
export interface DeliveredEvent<E extends EventName = EventName> {
  /** The `plugin_events` row id — the key for anything a subscriber must do once per event. */
  id: string
  name: E
  /** The organisation the event belongs to. Every write the subscriber makes is under it. */
  tenantId: string
  payload: EventPayload<E>
  occurredAt: Date
}

/** What `ctx.emit` answers. */
export interface EmittedEvent {
  eventId: string
  /** The same idempotency key was emitted before; `eventId` is THAT event and nothing new was queued. */
  deduplicated: boolean
  /** Deliveries queued by this call — one per subscriber; 0 for a deduplicated emit. */
  deliveries: number
}

/** The background `emit`: the tenant is named per call, as every background method takes it. */
export interface EmitInput<E extends EventName> {
  tenantId: string
  /** Validated against the declaring plugin's schema (400 `validation_failed`). Never logged. */
  payload: EventPayload<E>
  /**
   * At most one event per (tenant, name, key): a second emit answers the first (`deduplicated`).
   * Name the THING (`submission:<id>`), not the attempt, so a retried route or job is caught.
   */
  idempotencyKey?: string
}

/** The same input where the context is already bound to one tenant (a request, a run, a handler). */
export type TenantEmitInput<E extends EventName> = Omit<EmitInput<E>, 'tenantId'>

export type Emit = <E extends EventName>(event: E, input: EmitInput<E>) => Promise<EmittedEvent>
export type TenantEmit = <E extends EventName>(
  event: E,
  input: TenantEmitInput<E>
) => Promise<EmittedEvent>

/**
 * What an event handler is given: the job's context — its own DB client, config, logger, env —
 * plus the event it is delivering. A plugin adapts it with `eventCtx(ctx)` from `@/plugins/api`,
 * exactly as an email handler adapts with `emailCtx`; that adapter is TENANT-BOUND to the event.
 */
export interface EventContext extends JobContext {
  event: DeliveredEvent
}

/**
 * One subscription: a `ServerPlugin.eventHandlers` entry or an `APP_EVENT_HANDLERS` one. Each gets
 * its OWN queued delivery per event, so one handler's failure retries alone. Throw to retry (30 s
 * doubling to 15 min, the toml's `max_retries`); a 4xx `ApiError` (a refusal retrying cannot change)
 * is logged and acknowledged instead. Await everything — there is no `waitUntil` in a job.
 *
 * `handle` is a METHOD on purpose: method parameters are bivariant, which is what lets a handler
 * typed for one event sit in a list of handlers for any.
 */
export interface EventHandler<E extends EventName = EventName> {
  event: E
  /** Unique within its plugin (or the app), `^[a-z][a-z0-9-]*$`: part of the delivery's id. */
  name: string
  handle(event: DeliveredEvent<E>, ctx: EventContext): Promise<void>
}

/**
 * An AUTOMATIC agent start: every `event` (that `where` accepts) starts the agent with
 * `input(payload)`, through `enqueueRun` — input validated against the agent's `inputSchema`, the
 * exclusive slot, the active-run cap, the daily budget. Idempotent per (event, agent).
 */
export interface AgentEventTrigger<E extends EventName = EventName, Input = unknown> {
  event: E
  /** A pure filter over the payload; omitted = every event. */
  where?(payload: EventPayload<E>): boolean
  /** The agent's input, built from the payload. Validated by the agent's own `inputSchema`. */
  input(payload: EventPayload<E>): Input
}

/**
 * An OPT-IN: the agent may be started by `event` when a subject NAMES it — a form block an editor
 * pointed at it — never by the event alone. Listed by `GET /api/agents/bindable?event=` (and
 * `listBindableAgents`); started by `EventCtx.startBoundAgent(agentKey)`, which re-checks this
 * declaration on the server, so a forged agent key starts nothing.
 */
export interface AgentEventBinding<E extends EventName = EventName, Input = unknown> {
  event: E
  input(payload: EventPayload<E>): Input
}

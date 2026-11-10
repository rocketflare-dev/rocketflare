/**
 * Who hears an event (D42): every installed plugin's `eventHandlers`, the app's own
 * `APP_EVENT_HANDLERS`, and every agent's `triggers` — one SUBSCRIBER each, with a stable id that
 * an `event.deliver` job names. One job per (event, subscriber), so each retries on its own.
 *
 * Ids: `handler:<plugin id>:<name>`, `app:<name>`, `trigger:<agent key>:<index>`. They are what a
 * queued message carries across a deploy, so renaming a handler or reordering an agent's triggers
 * strands the deliveries already queued for the old id — those are logged and acknowledged.
 *
 * Read lazily (`emitEvent` imports this module at call time): the table reads the server barrel and
 * the agent registry, both of which a plugin module must never reach at module scope.
 */
import { serverPlugins } from '../../../plugins/server'
import type { JobContext } from '../../queues/jobs'
import { agentTriggerSubscribers } from '../agents/triggers'
import { APP_EVENT_HANDLERS } from './app-handlers'
import type { DeliveredEvent, EventHandler } from './types'

export interface EventSubscriber {
  id: string
  event: string
  deliver(event: DeliveredEvent, ctx: JobContext): Promise<void>
}

function handlerSubscriber(prefix: string, handler: EventHandler): EventSubscriber {
  return {
    id: `${prefix}:${handler.name}`,
    event: handler.event,
    deliver: (event, ctx) => handler.handle(event, { ...ctx, event }),
  }
}

let table: readonly EventSubscriber[] | null = null

/** Every subscriber, built once per isolate: plugins in barrel order, then the app, then agents. */
export function eventSubscribers(): readonly EventSubscriber[] {
  table ??= [
    ...serverPlugins.flatMap(p =>
      (p.eventHandlers ?? []).map(h => handlerSubscriber(`handler:${p.shared.id}`, h))
    ),
    ...APP_EVENT_HANDLERS.map(h => handlerSubscriber('app', h)),
    ...agentTriggerSubscribers(),
  ]
  return table
}

export function subscribersFor(event: string): EventSubscriber[] {
  return eventSubscribers().filter(s => s.event === event)
}

/**
 * A nudge from somewhere with no `waitUntil` — a queue handler, a cron task, a Workflow step.
 *
 * `services/realtime.ts` sends through a `Realtime`'s `defer`, which is `waitUntil` on the request
 * path. A background context has no such thing: the invocation ends when the handler returns, so
 * anything handed to a `defer` that resolves to "await it inline" must actually BE awaited, and
 * anything handed to one that drops it is lost.
 *
 * So this builds a `Realtime` whose `defer` collects, and awaits the collection. That keeps
 * `services/realtime.ts` the only module that touches `NOTIFICATIONS_HUB` — the kit's own runtime
 * does the same thing for Workflow steps (`createStepRealtime`), and this is the plugin-facing
 * spelling of it, kept here rather than imported because the runtime's version lives inside the
 * deletable `feature-agents` surface.
 */

import type { RealtimeEvent } from '@rocketflare/shared/realtime'
import type { HubEnv, Realtime } from '../../api/services/realtime'
import { nudge, nudgeUser, nudgeUsers, realtimeEvent } from '../../api/services/realtime'

export interface StepRealtime {
  /** The `Realtime` a kit-shaped service takes as its trailing optional argument. */
  realtime: Realtime
  /** Await every send collected so far. Failures are swallowed — a nudge is never load-bearing. */
  settle(): Promise<void>
  nudgeEntity(tenantId: string, entity: string, id?: string): Promise<void>
  send(event: RealtimeEvent): Promise<void>
  sendToUser(userId: string, event: RealtimeEvent): Promise<void>
  sendToUsers(userIds: string[], event: RealtimeEvent): Promise<void>
}

export function createStepRealtimeFor(env: HubEnv): StepRealtime {
  const pending: Promise<unknown>[] = []
  const realtime: Realtime = {
    defer: fn => {
      pending.push(fn().catch(() => {}))
    },
    env,
  }
  const settle = async () => {
    const batch = pending.splice(0, pending.length)
    await Promise.all(batch)
  }
  return {
    realtime,
    settle,
    nudgeEntity: async (tenantId, entity, id) => {
      nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity, ...(id && { id }) }))
      await settle()
    },
    send: async event => {
      nudge(realtime, event)
      await settle()
    },
    sendToUser: async (userId, event) => {
      nudgeUser(realtime, userId, event)
      await settle()
    },
    sendToUsers: async (userIds, event) => {
      nudgeUsers(realtime, userIds, event)
      await settle()
    },
  }
}

/**
 * Realtime nudges (D7, D8): the ONLY module that talks to `NOTIFICATIONS_HUB`. Routes and services
 * never touch the DO; they call `nudge*()` with the request's `Realtime` (`{ defer, env }` from
 * `withAuth`), which builds the event and hands the RPC call to `waitUntil` — never awaited on the
 * response path, never allowed to fail the request. "DB is the truth, WebSocket is a nudge."
 *
 * `Broadcaster` is the seam a test or another transport could replace; `createHubBroadcaster` is
 * the one implementation: `idFromName(tenantId)` → per-tenant DO → typed RPC stub.
 */
import type { RealtimeEvent, RealtimeEventType } from '@gmgo/shared/realtime'
import type { BroadcastResult, NotificationsHub } from '../durable-objects/notifications-hub'
import type { AppBindings } from '../types'
import type { Defer } from '../utils/routes/route-helpers'

export interface Broadcaster {
  toTenant(tenantId: string, event: RealtimeEvent): Promise<BroadcastResult>
  toUser(tenantId: string, userId: string, event: RealtimeEvent): Promise<BroadcastResult>
  toUsers(tenantId: string, userIds: string[], event: RealtimeEvent): Promise<BroadcastResult>
}

export type HubEnv = Pick<AppBindings, 'NOTIFICATIONS_HUB'>

/** Everything a service needs to nudge: how to defer, and the hub binding. Built by `withAuth`. */
export interface Realtime {
  defer: Defer
  env: HubEnv
}

export function realtimeEvent(
  type: RealtimeEventType,
  tenantId: string,
  payload?: unknown
): RealtimeEvent {
  return { type, tenantId, at: new Date().toISOString(), ...(payload !== undefined && { payload }) }
}

/** `wrangler types` types the namespace from the class exported in `src/worker.ts` — RPC is typed. */
function hubStub(env: HubEnv, tenantId: string): DurableObjectStub<NotificationsHub> {
  return env.NOTIFICATIONS_HUB.get(env.NOTIFICATIONS_HUB.idFromName(tenantId))
}

export function createHubBroadcaster(env: HubEnv): Broadcaster {
  return {
    toTenant: (tenantId, event) => hubStub(env, tenantId).broadcast(event),
    toUser: (tenantId, userId, event) => hubStub(env, tenantId).broadcastToUser(userId, event),
    toUsers: (tenantId, userIds, event) => hubStub(env, tenantId).broadcastToUsers(userIds, event),
  }
}

/** Tenant-wide nudge (member / invitation / tenant changes). No-op without a hub binding. */
export function nudge(rt: Realtime | undefined, event: RealtimeEvent): void {
  if (!rt?.env.NOTIFICATIONS_HUB) return
  rt.defer(() => createHubBroadcaster(rt.env).toTenant(event.tenantId, event))
}

/** One user's sockets in the tenant (their notifications). */
export function nudgeUser(rt: Realtime | undefined, userId: string, event: RealtimeEvent): void {
  if (!rt?.env.NOTIFICATIONS_HUB) return
  rt.defer(() => createHubBroadcaster(rt.env).toUser(event.tenantId, userId, event))
}

export function nudgeUsers(
  rt: Realtime | undefined,
  userIds: string[],
  event: RealtimeEvent
): void {
  if (!rt?.env.NOTIFICATIONS_HUB || userIds.length === 0) return
  rt.defer(() => createHubBroadcaster(rt.env).toUsers(event.tenantId, userIds, event))
}

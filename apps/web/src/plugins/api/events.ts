/**
 * Realtime nudges, notifications, activity and Durable Objects (D8, D31).
 *
 * **"DB is the truth, WebSocket is a nudge."** Everything here sends an id and a family root, never
 * a payload: the client re-queries. A nudge carrying the row would broadcast one member's data to
 * every socket in the tenant, because the hub fans out per TENANT while row visibility is per row.
 *
 * The one convention worth learning before writing a nudge: **the `entity` string of an
 * `entity.changed` nudge IS a TanStack query-key family root.** Declare it once — the server's
 * nudge and the UI's `queryKeys` root are the same constant — and `invalidationsFor()` wires the
 * socket up with no hook-side code at all. A plugin's roots start with `<id>:`, so one plugin's
 * invalidation can never reach another's cache.
 */

import { recordActivity } from '../../api/services/activity'
import { notify, notifyMany } from '../../api/services/notifications'
import type { Realtime } from '../../api/services/realtime'
import { nudge, nudgeUser, nudgeUsers, realtimeEvent } from '../../api/services/realtime'
import type { PluginBindings } from './types'

export type { ActivityInput } from '../../api/services/activity'
export type { NotifyInput } from '../../api/services/notifications'
export type { Realtime } from '../../api/services/realtime'

/**
 * Nudge every socket in one tenant that a family of rows moved.
 *
 * `entity` is the query-key family root, `id` the row if there is one. Prefer `ctx.nudge(...)` on a
 * context, which fills the tenant in; this is the form a plugin's own service function takes when
 * it is called from several contexts.
 */
export function nudgeEntity(
  realtime: Realtime | undefined,
  tenantId: string,
  entity: string,
  id?: string
): void {
  nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity, ...(id && { id }) }))
}

/**
 * Write a notification (and nudge the recipient's bell). Post-commit, like every nudge: a
 * notification about a row nobody can read yet is worse than a late one.
 */
/**
 * Append to the tenant's audit log. Fire it through `ctx.defer(...)` from a route — it is a side
 * effect that must never fail the response — and `await` it everywhere else.
 */
export { notify, notifyMany, nudge, nudgeUser, nudgeUsers, realtimeEvent, recordActivity }

/**
 * A Durable Object stub for one tenant, **with the tenant prefix built here rather than by the
 * caller** (D31).
 *
 * This is the whole reason the method exists. `docs/CONCEPTS.md` §9 rejects Cloudflare's Agents SDK
 * partly because a DO's instance name is a client-supplied string, which converts tenant isolation
 * "from structure into convention" — `tests/config/unscoped-allowlist.test.ts` parses queries and
 * cannot see a name string. A plugin calling `idFromName` itself reintroduces exactly that: one
 * forgotten prefix is a cross-tenant object with nothing in the repo able to notice.
 *
 * So the plugin never calls `idFromName`. It names a binding, a tenant and an optional key, and the
 * prefix is structural.
 */
export function durableObject<T extends Rpc.DurableObjectBranded | undefined = undefined>(
  namespace: DurableObjectNamespace<T>,
  tenantId: string,
  key?: string
): DurableObjectStub<T> {
  return namespace.get(namespace.idFromName(key ? `${tenantId}:${key}` : tenantId))
}

/** The bindings slice `durableObject` needs — so a plugin's helper can take less than the whole env. */
export type DurableObjectBindings = PluginBindings

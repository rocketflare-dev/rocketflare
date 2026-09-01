/**
 * Realtime event contracts (D8). "DB is the truth, WebSocket is a nudge": an event names WHAT
 * changed (its `type`, optionally an `entity.changed` payload `{ entity, id }`) and the client
 * re-queries — it never treats a payload as state. `REALTIME_INVALIDATIONS` maps each event type
 * to the TanStack query-key ROOTS the UI invalidates (the `queryKeys.<family>.all` prefixes in
 * `apps/web/src/ui/lib/query-keys.ts`); the server emits, the UI reacts, both through this file.
 */
import { z } from 'zod'

export const realtimeEventTypeSchema = z.enum([
  'notification.created',
  'notification.read',
  'member.changed',
  'invitation.changed',
  'tenant.changed',
  'entity.changed',
  'ping',
])
export type RealtimeEventType = z.infer<typeof realtimeEventTypeSchema>

/** Generic nudge: `entity` is a query-key root (`'members'`, `'activity'`…), `id` narrows it. */
export const entityChangedPayloadSchema = z.object({
  entity: z.string().min(1),
  id: z.string().optional(),
})
export type EntityChangedPayload = z.infer<typeof entityChangedPayloadSchema>

/** What travels over the socket, `JSON.stringify`-ed. `at` is an ISO timestamp set by the emitter. */
export const realtimeEventSchema = z.object({
  type: realtimeEventTypeSchema,
  tenantId: z.string(),
  at: z.string().datetime(),
  payload: z.unknown().optional(),
})
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>

/**
 * Event type → query-key roots to invalidate. Roots are the first element(s) of the families in
 * `queryKeys`; `entity.changed` is resolved from its payload at runtime and `ping` invalidates
 * nothing. A ui test asserts every root here is a real `queryKeys` family.
 */
export const REALTIME_INVALIDATIONS: Record<RealtimeEventType, string[][]> = {
  'notification.created': [['notifications']],
  'notification.read': [['notifications']],
  'member.changed': [['members']],
  'invitation.changed': [['invitations'], ['pending-invitations']],
  'tenant.changed': [['tenant'], ['tenants'], ['auth']],
  'entity.changed': [],
  ping: [],
}

/** The query-key roots an event should invalidate, including the `entity.changed` payload root. */
export function invalidationsFor(event: RealtimeEvent): string[][] {
  if (event.type === 'entity.changed') {
    const parsed = entityChangedPayloadSchema.safeParse(event.payload)
    return parsed.success ? [[parsed.data.entity]] : []
  }
  return REALTIME_INVALIDATIONS[event.type]
}

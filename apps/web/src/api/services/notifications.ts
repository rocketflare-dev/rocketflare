/**
 * In-app notifications: `notify()` inserts the row that IS the truth; when the caller passes
 * its `Realtime`, a `notification.created` nudge goes to that user's sockets through `waitUntil`
 * and the bell re-queries. Producers: invitation accepted, member joined, access request decided,
 * an agent run waiting on a decision (marked read again by `markNotificationsReadByData` once the
 * ask is over).
 */
import type { NotificationData } from '@rocketflare/shared/notifications'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { notifications } from '../../db/schema'
import { nudgeUser, nudgeUsers, type Realtime, realtimeEvent } from './realtime'

export interface NotifyInput {
  tenantId: string
  userId: string
  type: string
  title: string
  body?: string | null
  data?: NotificationData
}

export async function notify(db: Database, input: NotifyInput, realtime?: Realtime): Promise<void> {
  const [row] = await db
    .insert(notifications)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      data: input.data ?? {},
    })
    .returning({ id: notifications.id })
  nudgeUser(
    realtime,
    input.userId,
    realtimeEvent('notification.created', input.tenantId, {
      id: row?.id,
      type: input.type,
      title: input.title,
    })
  )
}

/** Same notification to several users (e.g. every owner/admin of a tenant). */
export async function notifyMany(
  db: Database,
  userIds: string[],
  input: Omit<NotifyInput, 'userId'>,
  realtime?: Realtime
) {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return
  await db.insert(notifications).values(
    unique.map(userId => ({
      tenantId: input.tenantId,
      userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      data: input.data ?? {},
    }))
  )
  nudgeUsers(
    realtime,
    unique,
    realtimeEvent('notification.created', input.tenantId, { type: input.type, title: input.title })
  )
}

/**
 * Mark read every unread notification of `type` whose `data[key]` is one of `values` — what a
 * producer calls once the thing a notification asked about is over (an agent's question answered,
 * expired or settled with its run), so the bell stops counting a question nobody can answer. With
 * `realtime`, each affected user's bell is nudged to re-count.
 */
export async function markNotificationsReadByData(
  db: Database,
  tenantId: string,
  type: string,
  key: string,
  values: string[],
  realtime?: Realtime
): Promise<number> {
  if (values.length === 0) return 0
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.type, type),
        isNull(notifications.readAt),
        inArray(sql`${notifications.data} ->> ${key}`, values)
      )
    )
    .returning({ id: notifications.id, userId: notifications.userId })
  // Every reader's bell re-counts, not only the person who answered.
  if (rows.length > 0) {
    nudgeUsers(
      realtime,
      [...new Set(rows.map(row => row.userId))],
      realtimeEvent('notification.read', tenantId)
    )
  }
  return rows.length
}

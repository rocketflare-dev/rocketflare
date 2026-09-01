/**
 * In-app notifications (D8): `notify()` inserts the row that IS the truth; when the caller passes
 * its `Realtime`, a `notification.created` nudge goes to that user's sockets through `waitUntil`
 * and the bell re-queries. Producers: invitation accepted, member joined, access request decided.
 */
import type { NotificationData } from '@gmgo/shared/notifications'
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

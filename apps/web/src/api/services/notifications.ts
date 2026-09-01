/**
 * In-app notifications (D8): `notify()` inserts the row that IS the truth; realtime is a nudge
 * added in Phase 2 (`// Phase 2: broadcast`). Producers: invitation accepted, member joined,
 * access request decided.
 */
import type { NotificationData } from '@gmgo/shared/notifications'
import type { Database } from '../../db/client'
import { notifications } from '../../db/schema'

export interface NotifyInput {
  tenantId: string
  userId: string
  type: string
  title: string
  body?: string | null
  data?: NotificationData
}

export async function notify(db: Database, input: NotifyInput): Promise<void> {
  await db.insert(notifications).values({
    tenantId: input.tenantId,
    userId: input.userId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    data: input.data ?? {},
  })
  // Phase 2: broadcast — nudge NOTIFICATIONS_HUB for (tenantId, userId); the client re-queries.
}

/** Same notification to several users (e.g. every owner/admin of a tenant). */
export async function notifyMany(
  db: Database,
  userIds: string[],
  input: Omit<NotifyInput, 'userId'>
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
  // Phase 2: broadcast
}

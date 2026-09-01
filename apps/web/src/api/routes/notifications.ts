/**
 * `/api/notifications` (D8): the signed-in user's inbox within the current tenant — list,
 * unread count, mark read (ids or all). Scoped by `(tenant_id, user_id)` from the auth context.
 */
import {
  markNotificationsReadRequestSchema,
  notificationListQuerySchema,
} from '@gmgo/shared/notifications'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { notifications } from '../../db/schema'
import { asCount, pageWindow, paginated } from '../utils/routes/pagination'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const notificationsRouter = createRouter()

notificationsRouter.get('/', validate('query', notificationListQuerySchema), async c => {
  const { db, tenantId, user } = withAuthAndDb(c)
  const query = c.req.valid('query')
  const where = and(
    eq(notifications.tenantId, tenantId),
    eq(notifications.userId, user.id),
    query.unreadOnly ? isNull(notifications.readAt) : undefined
  )
  const { limit, offset } = pageWindow(query)
  const [items, [count]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql`count(*)` }).from(notifications).where(where),
  ])
  return c.json(paginated(items, asCount(count?.count), query))
})

notificationsRouter.get('/unread-count', async c => {
  const { db, tenantId, user } = withAuthAndDb(c)
  const [row] = await db
    .select({ count: sql`count(*)` })
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.userId, user.id),
        isNull(notifications.readAt)
      )
    )
  return c.json({ count: asCount(row?.count) })
})

notificationsRouter.post('/read', validate('json', markNotificationsReadRequestSchema), async c => {
  const { db, tenantId, user } = withAuthAndDb(c)
  const body = c.req.valid('json')
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.userId, user.id),
        isNull(notifications.readAt),
        'ids' in body ? inArray(notifications.id, body.ids) : undefined
      )
    )
    .returning({ id: notifications.id })
  return c.json({ updated: rows.length })
})

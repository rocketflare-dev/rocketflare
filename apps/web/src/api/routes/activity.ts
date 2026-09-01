/**
 * `GET /api/activity` (D19): the tenant's activity feed, admin+, filterable by type / subject /
 * time range, with the actor resolved.
 */
import { activityListQuerySchema } from '@rocketflare/shared/activity'
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { activityEvents, users } from '../../db/schema'
import { isAdminLevel } from '../middleware/permissions'
import { ForbiddenError } from '../utils/core/errors'
import { asCount, pageWindow, paginated } from '../utils/routes/pagination'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const activityRouter = createRouter()

activityRouter.get('/', validate('query', activityListQuerySchema), async c => {
  const { db, tenantId, auth } = withAuthAndDb(c)
  if (!isAdminLevel(auth)) throw new ForbiddenError('Only admins can read the activity log')
  const query = c.req.valid('query')
  const where = and(
    eq(activityEvents.tenantId, tenantId),
    query.type ? eq(activityEvents.type, query.type) : undefined,
    query.subjectType ? eq(activityEvents.subjectType, query.subjectType) : undefined,
    query.subjectId ? eq(activityEvents.subjectId, query.subjectId) : undefined,
    query.from ? gte(activityEvents.createdAt, query.from) : undefined,
    query.to ? lte(activityEvents.createdAt, query.to) : undefined
  )
  const { limit, offset } = pageWindow(query)
  const [rows, [count]] = await Promise.all([
    db
      .select({ event: activityEvents, actorName: users.name, actorEmail: users.email })
      .from(activityEvents)
      .leftJoin(users, eq(users.id, activityEvents.userId))
      .where(where)
      .orderBy(desc(activityEvents.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql`count(*)` }).from(activityEvents).where(where),
  ])
  const items = rows.map(r => ({
    ...r.event,
    actor: r.actorName && r.actorEmail ? { name: r.actorName, email: r.actorEmail } : null,
  }))
  return c.json(paginated(items, asCount(count?.count), query))
})

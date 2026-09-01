/**
 * `/api/analytics` (D19): dashboard pages, templates and fact-table status.
 *   GET    /pages            every member; ensures the tenant's template pages exist, then lists
 *   POST   /pages            manage Dashboard (admin+) — user-created page, slug from the name
 *   GET    /pages/:id        every member
 *   PATCH  /pages/:id        manage Dashboard — name / description / config / order / isDefault
 *   DELETE /pages/:id        manage Dashboard — user-created pages only (template pages would be
 *                            re-created by the next list, so deleting one is refused: 403 `template_page`)
 *   POST   /pages/:id/reset  manage Dashboard — template pages back to their template
 *   GET    /templates        every member — `{ key, name, description }[]`
 *   POST   /templates/recreate  manage Dashboard — create missing + reset existing template pages
 *   GET    /facts/status     admin+ — fact-table freshness
 * Reads are tenant membership only; the cube data behind a page is served by `/cubejs-api` with
 * its own `read Analytics` guard. Contracts: `@rocketflare/shared/analytics`.
 */
import {
  createAnalyticsPageRequestSchema,
  updateAnalyticsPageRequestSchema,
} from '@rocketflare/shared/analytics'
import type { DashboardConfig } from 'drizzle-cube/client'
import { and, asc, eq } from 'drizzle-orm'
import { listTemplates } from '../../dashboards'
import { analyticsPages } from '../../db/schema'
import { guardPermission, isAdminLevel } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import {
  ensureDefaultDashboards,
  recreateTemplates,
  resetToTemplate,
  toAnalyticsPageDto,
  uniquePageSlug,
} from '../services/dashboard-templates'
import { checkFactTableFreshness } from '../services/fact-tables'
import { ForbiddenError, NotFoundError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const analyticsPagesRouter = createRouter()

/** What a user-created page starts as: an empty rows-mode dashboard the editor can fill. */
const EMPTY_DASHBOARD: DashboardConfig = { layoutMode: 'rows', rows: [], portlets: [] }

analyticsPagesRouter.get('/pages', async c => {
  const { db, tenantId, user } = withAuthAndDb(c)
  await ensureDefaultDashboards(db, tenantId, user.id)
  const rows = await db
    .select()
    .from(analyticsPages)
    .where(eq(analyticsPages.tenantId, tenantId))
    .orderBy(asc(analyticsPages.sortOrder), asc(analyticsPages.name))
  return c.json({ items: rows.map(toAnalyticsPageDto) })
})

analyticsPagesRouter.post('/pages', validate('json', createAnalyticsPageRequestSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Dashboard')
  const body = c.req.valid('json')
  const [row] = await db
    .insert(analyticsPages)
    .values({
      tenantId,
      slug: await uniquePageSlug(db, tenantId, body.name),
      name: body.name,
      description: body.description ?? null,
      templateKey: null,
      config: (body.config as unknown as DashboardConfig | undefined) ?? EMPTY_DASHBOARD,
      sortOrder: body.order ?? 100,
      createdByUserId: user.id,
    })
    .returning()
  if (!row) throw new Error('analytics page insert returned no row')
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'dashboard.created',
      subjectType: 'Dashboard',
      subjectId: row.id,
      metadata: { name: row.name },
    })
  )
  return c.json(toAnalyticsPageDto(row), 201)
})

analyticsPagesRouter.get('/pages/:id', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  const id = uuidParam(c, 'id')
  const row = await db.query.analyticsPages.findFirst({
    where: and(eq(analyticsPages.id, id), eq(analyticsPages.tenantId, tenantId)),
  })
  if (!row) throw new NotFoundError('Dashboard not found')
  return c.json(toAnalyticsPageDto(row))
})

analyticsPagesRouter.patch(
  '/pages/:id',
  validate('json', updateAnalyticsPageRequestSchema),
  async c => {
    const { db, tenantId, user, defer } = withAuthAndDb(c)
    guardPermission(c, 'manage', 'Dashboard')
    const id = uuidParam(c, 'id')
    const patch = c.req.valid('json')
    const [row] = await db
      .update(analyticsPages)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.config !== undefined && { config: patch.config as unknown as DashboardConfig }),
        ...(patch.order !== undefined && { sortOrder: patch.order }),
        ...(patch.isDefault !== undefined && { isDefault: patch.isDefault }),
      })
      .where(and(eq(analyticsPages.id, id), eq(analyticsPages.tenantId, tenantId)))
      .returning()
    if (!row) throw new NotFoundError('Dashboard not found')
    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: 'dashboard.updated',
        subjectType: 'Dashboard',
        subjectId: row.id,
        metadata: { fields: Object.keys(patch) },
      })
    )
    return c.json(toAnalyticsPageDto(row))
  }
)

analyticsPagesRouter.delete('/pages/:id', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Dashboard')
  const id = uuidParam(c, 'id')
  const row = await db.query.analyticsPages.findFirst({
    columns: { id: true, name: true, templateKey: true },
    where: and(eq(analyticsPages.id, id), eq(analyticsPages.tenantId, tenantId)),
  })
  if (!row) throw new NotFoundError('Dashboard not found')
  if (row.templateKey) {
    throw new ForbiddenError(
      'Template dashboards cannot be deleted — reset them instead',
      'template_page'
    )
  }
  await db.delete(analyticsPages).where(eq(analyticsPages.id, id))
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'dashboard.deleted',
      subjectType: 'Dashboard',
      subjectId: id,
      metadata: { name: row.name },
    })
  )
  return c.body(null, 204)
})

analyticsPagesRouter.post('/pages/:id/reset', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Dashboard')
  const id = uuidParam(c, 'id')
  const row = await resetToTemplate(db, tenantId, id)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'dashboard.reset',
      subjectType: 'Dashboard',
      subjectId: row.id,
      metadata: { templateKey: row.templateKey },
    })
  )
  return c.json(toAnalyticsPageDto(row))
})

analyticsPagesRouter.get('/templates', c => {
  withAuthAndDb(c)
  return c.json({
    items: listTemplates().map(t => ({ key: t.key, name: t.name, description: t.description })),
  })
})

analyticsPagesRouter.post('/templates/recreate', async c => {
  const { db, tenantId, user } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Dashboard')
  return c.json(await recreateTemplates(db, tenantId, user.id))
})

analyticsPagesRouter.get('/facts/status', async c => {
  const { db, auth } = withAuthAndDb(c)
  if (!isAdminLevel(auth)) throw new ForbiddenError('Only admins can read fact-table status')
  return c.json({ items: await checkFactTableFreshness(db) })
})

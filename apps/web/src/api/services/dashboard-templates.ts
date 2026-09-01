/**
 * Templates → per-tenant dashboards (D19). `ensureDefaultDashboards` copies every entry of
 * `DASHBOARD_TEMPLATES` into `analytics_pages` that the tenant does not have yet — idempotent via
 * the `(tenant_id, slug)` unique index (slug = template key) — and runs on tenant creation
 * (`utils/db/tenant-helpers.ts`) and lazily on every `GET /api/analytics/pages`, so a template
 * added later still reaches existing tenants. `resetToTemplate` / `recreateTemplates` are the
 * repair paths: `config` is a copy, so template changes do not propagate on their own.
 * Every function takes `tenantId` from the caller's auth context.
 */
import type { AnalyticsPage as AnalyticsPageDto } from '@rocketflare/shared/analytics'
import { slugify } from '@rocketflare/shared/tenants'
import { and, eq } from 'drizzle-orm'
import { getTemplate, listTemplates } from '../../dashboards'
import type { Database } from '../../db/client'
import { type AnalyticsPage, analyticsPages } from '../../db/schema'
import { BadRequestError, NotFoundError } from '../utils/core/errors'

export function toAnalyticsPageDto(row: AnalyticsPage): AnalyticsPageDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    templateKey: row.templateKey,
    config: row.config as unknown as AnalyticsPageDto['config'],
    isDefault: row.isDefault,
    order: row.sortOrder,
    createdBy: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Insert every template the tenant lacks. Returns how many were created (0 = nothing to do). */
export async function ensureDefaultDashboards(
  db: Database,
  tenantId: string,
  createdByUserId: string | null = null
): Promise<number> {
  const templates = listTemplates()
  if (templates.length === 0) return 0
  const created = await db
    .insert(analyticsPages)
    .values(
      templates.map(t => ({
        tenantId,
        slug: t.key,
        name: t.name,
        description: t.description,
        templateKey: t.key,
        config: t.config,
        isDefault: t.isDefault ?? false,
        sortOrder: t.order,
        createdByUserId,
      }))
    )
    .onConflictDoNothing({ target: [analyticsPages.tenantId, analyticsPages.slug] })
    .returning({ id: analyticsPages.id })
  return created.length
}

/** Overwrite a template page's name/description/config/order from its template. */
export async function resetToTemplate(
  db: Database,
  tenantId: string,
  pageId: string
): Promise<AnalyticsPage> {
  const page = await db.query.analyticsPages.findFirst({
    where: and(eq(analyticsPages.id, pageId), eq(analyticsPages.tenantId, tenantId)),
  })
  if (!page) throw new NotFoundError('Dashboard not found')
  if (!page.templateKey) {
    throw new BadRequestError('Only template dashboards can be reset', 'not_a_template_page')
  }
  const template = getTemplate(page.templateKey)
  if (!template) {
    throw new NotFoundError(`Template "${page.templateKey}" no longer exists`, 'template_not_found')
  }
  const [row] = await db
    .update(analyticsPages)
    .set({
      name: template.name,
      description: template.description,
      config: template.config,
      sortOrder: template.order,
    })
    .where(and(eq(analyticsPages.id, pageId), eq(analyticsPages.tenantId, tenantId)))
    .returning()
  if (!row) throw new NotFoundError('Dashboard not found')
  return row
}

/** Create missing template pages AND reset the existing ones — the "repair everything" button. */
export async function recreateTemplates(
  db: Database,
  tenantId: string,
  createdByUserId: string | null = null
): Promise<{ created: number; reset: number }> {
  const created = await ensureDefaultDashboards(db, tenantId, createdByUserId)
  let reset = 0
  for (const template of listTemplates()) {
    const rows = await db
      .update(analyticsPages)
      .set({
        name: template.name,
        description: template.description,
        config: template.config,
        sortOrder: template.order,
      })
      .where(
        and(eq(analyticsPages.tenantId, tenantId), eq(analyticsPages.templateKey, template.key))
      )
      .returning({ id: analyticsPages.id })
    reset += rows.length
  }
  return { created, reset: reset - created }
}

/** `slugify(name)` made unique within the tenant by a numeric suffix. */
export async function uniquePageSlug(
  db: Database,
  tenantId: string,
  name: string
): Promise<string> {
  const root = slugify(name, 'dashboard')
  const taken = new Set(
    (
      await db
        .select({ slug: analyticsPages.slug })
        .from(analyticsPages)
        .where(eq(analyticsPages.tenantId, tenantId))
    ).map(r => r.slug)
  )
  if (!taken.has(root)) return root
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root}-${i}`.slice(0, 63)
    if (!taken.has(candidate)) return candidate
  }
  return `${root}-${Date.now().toString(36)}`
}

/**
 * Analytics contracts (D19): dashboard pages (`analytics_pages`), dashboard templates and
 * fact-table freshness. `config` is a drizzle-cube `DashboardConfig` — typed loosely here because
 * this package may import only zod; the UI narrows it with `DashboardConfig` from
 * `drizzle-cube/client`, the API with the same type on the db column. Documented shape:
 *
 *   {
 *     layoutMode: 'rows',
 *     rows:     [{ id, h, columns: [{ portletId? | groupId?, w }] }]   // widths sum to 12
 *     groups?:  [{ id, title?, direction: 'row'|'column', cells: [{ portletIds: [...] }] }]
 *     filters?: [{ id, label, isUniversalTime?, filter: { member, operator, values, dateRange? } }]
 *     portlets: [{ id, title, query: '<JSON cube query>', chartType, chartConfig, displayConfig,
 *                  dashboardFilterMapping?: [filterId...], x, y, w, h }]
 *   }
 *
 * The cube API itself (`/cubejs-api/v1/*`) is drizzle-cube's Cube.js-compatible contract and is
 * consumed through `drizzle-cube/client`, not through schemas here.
 */
import { z } from 'zod'

/** A drizzle-cube `DashboardConfig`; must at least carry a `portlets` array. */
export const dashboardConfigSchema = z
  .object({ portlets: z.array(z.record(z.string(), z.unknown())) })
  .catchall(z.unknown())
export type DashboardConfigJson = z.infer<typeof dashboardConfigSchema>

export const analyticsPageSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  /** Unique per tenant; equals `templateKey` for template pages. */
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Non-null = seeded from a template and resettable; null = user-created. */
  templateKey: z.string().nullable(),
  config: dashboardConfigSchema,
  isDefault: z.boolean(),
  order: z.number().int(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type AnalyticsPage = z.infer<typeof analyticsPageSchema>

export const analyticsPageListResponseSchema = z.object({ items: z.array(analyticsPageSchema) })
export type AnalyticsPageListResponse = z.infer<typeof analyticsPageListResponseSchema>

export const ANALYTICS_PAGE_NAME_MAX = 120
export const ANALYTICS_PAGE_DESCRIPTION_MAX = 500

export const createAnalyticsPageRequestSchema = z.object({
  name: z.string().trim().min(1).max(ANALYTICS_PAGE_NAME_MAX),
  description: z.string().trim().max(ANALYTICS_PAGE_DESCRIPTION_MAX).nullable().optional(),
  /** Defaults to an empty rows-mode dashboard the editor can fill. */
  config: dashboardConfigSchema.optional(),
  order: z.number().int().min(0).max(10_000).optional(),
})
export type CreateAnalyticsPageRequest = z.infer<typeof createAnalyticsPageRequestSchema>

export const updateAnalyticsPageRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(ANALYTICS_PAGE_NAME_MAX),
    description: z.string().trim().max(ANALYTICS_PAGE_DESCRIPTION_MAX).nullable(),
    config: dashboardConfigSchema,
    order: z.number().int().min(0).max(10_000),
    isDefault: z.boolean(),
  })
  .partial()
  .refine(v => Object.keys(v).length > 0, 'At least one field must be provided')
export type UpdateAnalyticsPageRequest = z.infer<typeof updateAnalyticsPageRequestSchema>

export const dashboardTemplateSummarySchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
})
export type DashboardTemplateSummary = z.infer<typeof dashboardTemplateSummarySchema>

export const dashboardTemplateListResponseSchema = z.object({
  items: z.array(dashboardTemplateSummarySchema),
})

/** One fact table's freshness (`GET /api/analytics/facts/status`, admin+). */
export const factTableStatusSchema = z.object({
  table: z.string(),
  /** Newest `fact_refreshed_at`; null when the table has never been built. */
  refreshedAt: z.coerce.date().nullable(),
  /** Seconds the newest source row has waited for a refresh (0 when nothing is pending). */
  lagSeconds: z.number().int().min(0),
  /** True when `lagSeconds` exceeds twice the table's refresh interval. */
  stale: z.boolean(),
})
export type FactTableStatus = z.infer<typeof factTableStatusSchema>

export const factTableStatusListResponseSchema = z.object({
  items: z.array(factTableStatusSchema),
})

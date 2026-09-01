/**
 * `analytics_pages` — one row per dashboard a tenant can open (D19). `config` is a drizzle-cube
 * `DashboardConfig` (portlets + rows/groups + filters) stored whole as jsonb; there is no widget
 * table. `templateKey` non-null means the page was seeded from `src/dashboards/` and can be reset
 * to its template (`POST /api/analytics/pages/:id/reset`); NULL = user-created. `slug` is unique
 * per tenant — template pages use the template key as their slug, which is what makes
 * `ensureDefaultDashboards` idempotent. The shared contract is `@rocketflare/shared/analytics`
 * (`config` typed loosely there; the drizzle-cube type lives only on this side).
 */
import type { DashboardConfig } from 'drizzle-cube/client'
import { relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const analyticsPages = pgTable(
  'analytics_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** URL-safe, unique per tenant; equals `templateKey` for seeded pages. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Key into `DASHBOARD_TEMPLATES`; NULL for a page a user created from scratch. */
    templateKey: text('template_key'),
    config: jsonb('config').$type<DashboardConfig>().notNull(),
    /** The page the Analytics section opens first. */
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    /** NULL for template pages seeded by the system. */
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('analytics_pages_tenant_slug_idx').on(table.tenantId, table.slug),
    index('analytics_pages_tenant_order_idx').on(table.tenantId, table.sortOrder),
    tenantIsolation('analytics_pages'),
  ]
)

export const analyticsPagesRelations = relations(analyticsPages, ({ one }) => ({
  tenant: one(tenants, { fields: [analyticsPages.tenantId], references: [tenants.id] }),
  createdBy: one(users, { fields: [analyticsPages.createdByUserId], references: [users.id] }),
}))

export type AnalyticsPage = typeof analyticsPages.$inferSelect
export type NewAnalyticsPage = typeof analyticsPages.$inferInsert

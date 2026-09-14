/**
 * `analytics_page_groups` (D29) — which groups a `visibility: 'groups'` dashboard is shared with.
 * The same shape and the same rules as `document_groups`: a real FK per resource, and the grants
 * are never the decision (`analytics_pages.visibility` is).
 */
import { index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { analyticsPages } from './analytics-pages'
import { groups } from './groups'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const analyticsPageGroups = pgTable(
  'analytics_page_groups',
  {
    tenantId: tenantRef(tenants),
    pageId: uuid('page_id')
      .notNull()
      .references(() => analyticsPages.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  table => [
    primaryKey({ columns: [table.pageId, table.groupId] }),
    index('analytics_page_groups_tenant_group_idx').on(table.tenantId, table.groupId),
    tenantIsolation('analytics_page_groups'),
  ]
)

export type AnalyticsPageGroupRow = typeof analyticsPageGroups.$inferSelect

/**
 * `tenant_settings` — one row per tenant, keyed by `tenant_id` itself (D1). The two generic
 * columns both reference apps shared (`timezone`, `notificationsEnabled`) are real columns; anything
 * app-specific goes in `settings` jsonb, typed by `tenantSettingsJsonSchema` in src/shared.
 */
import type { TenantSettingsJson } from '@shared/tenant-settings'
import { relations } from 'drizzle-orm'
import { boolean, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const tenantSettings = pgTable(
  'tenant_settings',
  {
    tenantId: tenantRef(tenants).primaryKey(),
    /** IANA zone name, e.g. `Europe/London`. */
    timezone: text('timezone').notNull().default('UTC'),
    notificationsEnabled: boolean('notifications_enabled').notNull().default(true),
    settings: jsonb('settings').$type<TenantSettingsJson>().notNull().default({}),
    ...timestamps(),
  },
  () => [tenantIsolation('tenant_settings')]
)

export const tenantSettingsRelations = relations(tenantSettings, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantSettings.tenantId], references: [tenants.id] }),
}))

export type TenantSettings = typeof tenantSettings.$inferSelect
export type NewTenantSettings = typeof tenantSettings.$inferInsert

/**
 * `tenant_user_settings` — a user's preferences WITHIN one tenant (D1, D25): favourites, sidebar
 * state, per-workspace defaults. Shape from the Workers reference app with `favorites` generalised
 * to `preferences` jsonb (typed by `userPreferencesSchema` in src/shared). Composite PK, tenant
 * first. Profile fields that belong to the person (name, avatar) stay on `users`.
 */
import type { UserPreferences } from '@gmgo/shared/user-settings'
import { relations } from 'drizzle-orm'
import { index, jsonb, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const tenantUserSettings = pgTable(
  'tenant_user_settings',
  {
    tenantId: tenantRef(tenants),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    preferences: jsonb('preferences').$type<UserPreferences>().notNull().default({}),
    ...timestamps(),
  },
  table => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    index('tenant_user_settings_user_idx').on(table.userId),
    tenantIsolation('tenant_user_settings'),
  ]
)

export const tenantUserSettingsRelations = relations(tenantUserSettings, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantUserSettings.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [tenantUserSettings.userId], references: [users.id] }),
}))

export type TenantUserSettings = typeof tenantUserSettings.$inferSelect
export type NewTenantUserSettings = typeof tenantUserSettings.$inferInsert

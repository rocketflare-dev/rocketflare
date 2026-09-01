/**
 * `prompt_overrides` — a tenant's override of a registry prompt (D17). PK (tenant, key); a row
 * exists ONLY when overridden, so reverting is a delete and the registry default needs no row.
 * `key` is a `PromptKey` from `services/prompts.ts` — text, not an enum, so a new prompt is a
 * registry entry and no migration. All runtime reads go through `resolvePrompt()`.
 */
import { relations } from 'drizzle-orm'
import { pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const promptOverrides = pgTable(
  'prompt_overrides',
  {
    tenantId: tenantRef(tenants),
    key: text('key').notNull(),
    text: text('text').notNull(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    primaryKey({ name: 'prompt_overrides_pk', columns: [table.tenantId, table.key] }),
    tenantIsolation('prompt_overrides'),
  ]
)

export const promptOverridesRelations = relations(promptOverrides, ({ one }) => ({
  tenant: one(tenants, { fields: [promptOverrides.tenantId], references: [tenants.id] }),
  updatedBy: one(users, { fields: [promptOverrides.updatedByUserId], references: [users.id] }),
}))

export type PromptOverrideRow = typeof promptOverrides.$inferSelect
export type NewPromptOverrideRow = typeof promptOverrides.$inferInsert

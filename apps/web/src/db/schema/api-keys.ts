/**
 * `api_keys` — tenant-scoped bearer credentials (D12). The plaintext is shown ONCE at creation;
 * only `keyHash` (SHA-256) is stored, `keyPrefix` is the human-readable handle in lists. A key acts
 * AS its creator: validation requires the creator to still be an unblocked member of the tenant,
 * so removing a member revokes their keys' access. Soft-revoked via `revokedAt`, never deleted.
 */
import { relations } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First characters of the plaintext (e.g. `rocketflare_ab12cd34`) for identification in lists. */
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    /** `apiKeyScopeSchema` values; CASL on the creator's role is the real authorisation. */
    scopes: text('scopes').array().notNull().default(['read', 'write']),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** `validateApiKey` MUST check this (D12 — neither reference app did). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('api_keys_tenant_idx').on(table.tenantId, table.revokedAt),
    tenantIsolation('api_keys'),
  ]
)

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  tenant: one(tenants, { fields: [apiKeys.tenantId], references: [tenants.id] }),
  createdBy: one(users, { fields: [apiKeys.createdByUserId], references: [users.id] }),
}))

export type ApiKey = typeof apiKeys.$inferSelect
export type NewApiKey = typeof apiKeys.$inferInsert

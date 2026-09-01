/**
 * `ai_configs` — a tenant's AI providers (D17). One row per (tenant, scope, label); the credential
 * is AES-GCM encrypted with `OAUTH_ENCRYPTION_KEY` (`api/auth/oauth-encryption.ts`) and NEVER
 * leaves the server. Exactly one row per (tenant, scope) carries `isDefault` — enforced by a
 * partial unique index so "two defaults" is unrepresentable; `routes/ai-config.ts` clears the old
 * default before setting the new one inside a transaction. `services/ai/resolve.ts` is the ONLY
 * runtime reader; feature code never queries this table.
 */
import type { AiProvider, AiScope, ThinkingSetting } from '@gmgo/shared/ai/config'
import { relations, sql } from 'drizzle-orm'
import { boolean, index, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

/** Mirrors `AI_PROVIDERS` / `AI_SCOPES` in `@gmgo/shared/ai/config`; text enums so a new value is no migration. */
export const AI_PROVIDER_VALUES = [
  'anthropic',
  'anthropic_compatible',
  'openai',
  'openai_compatible',
  'workers_ai',
] as const satisfies readonly AiProvider[]
export const AI_SCOPE_VALUES = ['chat', 'embeddings'] as const satisfies readonly AiScope[]

export const aiConfigs = pgTable(
  'ai_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    scope: text('scope', { enum: AI_SCOPE_VALUES }).notNull().default('chat'),
    provider: text('provider', { enum: AI_PROVIDER_VALUES }).notNull(),
    /** Human label; the upsert key within a scope. */
    label: text('label').notNull(),
    /** Endpoint override for the `*_compatible` providers (and regional Anthropic proxies). */
    baseUrl: text('base_url'),
    model: text('model').notNull(),
    /** Encrypted API key / bearer token; null for `workers_ai` (binding, no key). */
    apiKeyEnc: text('api_key_enc'),
    isDefault: boolean('is_default').notNull().default(false),
    /** `{ enabled, budgetTokens? }` — off by default and sent explicitly (cost, D17). */
    thinking: jsonb('thinking').$type<ThinkingSetting>().notNull().default({ enabled: false }),
    /** Provider service tier, verbatim; null = omit the field. */
    serviceTier: text('service_tier'),
    ...timestamps(),
  },
  table => [
    index('ai_configs_tenant_scope_idx').on(table.tenantId, table.scope),
    unique('ai_configs_tenant_scope_label_unique').on(table.tenantId, table.scope, table.label),
    // At most ONE default per (tenant, scope), by the database rather than by a route remembering.
    uniqueIndex('ai_configs_default_unique')
      .on(table.tenantId, table.scope)
      .where(sql`${table.isDefault}`),
    tenantIsolation('ai_configs'),
  ]
)

export const aiConfigsRelations = relations(aiConfigs, ({ one }) => ({
  tenant: one(tenants, { fields: [aiConfigs.tenantId], references: [tenants.id] }),
}))

export type AiConfigRow = typeof aiConfigs.$inferSelect
export type NewAiConfigRow = typeof aiConfigs.$inferInsert

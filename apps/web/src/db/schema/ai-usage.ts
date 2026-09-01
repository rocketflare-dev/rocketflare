/**
 * `ai_usage` — one row per model generation (D18): who spent what, on which provider/model, for
 * which feature. Written by `services/ai/usage.ts` from the provider's usage tap (chat route,
 * agent runs, connection tests). Append-only, no `updated_at`. `costMicrocents` stays null until an
 * app supplies a pricing table — cheap to record now, impossible to backfill later.
 */
import type { AiProvider } from '@rocketflare/shared/ai/config'
import { relations } from 'drizzle-orm'
import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Prompt key or feature name: `chat`, `summarize-text`, `connection-test`. */
    feature: text('feature').notNull(),
    provider: text('provider').$type<AiProvider>().notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costMicrocents: bigint('cost_microcents', { mode: 'number' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('ai_usage_tenant_at_idx').on(table.tenantId, table.at.desc()),
    tenantIsolation('ai_usage'),
  ]
)

export const aiUsageRelations = relations(aiUsage, ({ one }) => ({
  tenant: one(tenants, { fields: [aiUsage.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [aiUsage.userId], references: [users.id] }),
}))

export type AiUsageRow = typeof aiUsage.$inferSelect
export type NewAiUsageRow = typeof aiUsage.$inferInsert

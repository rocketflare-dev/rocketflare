/**
 * `agent_models` — per-agent model assignment (D17): pins one registry prompt key to a tenant
 * `ai_configs` row and/or a model. PK (tenant, promptKey); a row exists ONLY when something is
 * overridden, so reverting is a delete and the default needs no row. `aiConfigId` cascades: deleting
 * a provider config reverts every agent pointed at it to the tenant default rather than leaving a
 * pointer that would 503 at the next call. `services/ai/resolve.ts` is the ONLY runtime reader.
 */
import { relations } from 'drizzle-orm'
import { pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { aiConfigs } from './ai-configs'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const agentModels = pgTable(
  'agent_models',
  {
    tenantId: tenantRef(tenants),
    /** A `PromptKey` from `services/prompts.ts` — text, so a new agent is no migration. */
    promptKey: text('prompt_key').notNull(),
    /** Null = the tenant's default chat config. */
    aiConfigId: uuid('ai_config_id').references(() => aiConfigs.id, { onDelete: 'cascade' }),
    /** Null = the config's own model. */
    model: text('model'),
    ...timestamps(),
  },
  table => [
    primaryKey({ name: 'agent_models_pk', columns: [table.tenantId, table.promptKey] }),
    tenantIsolation('agent_models'),
  ]
)

export const agentModelsRelations = relations(agentModels, ({ one }) => ({
  tenant: one(tenants, { fields: [agentModels.tenantId], references: [tenants.id] }),
  config: one(aiConfigs, { fields: [agentModels.aiConfigId], references: [aiConfigs.id] }),
}))

export type AgentModelRow = typeof agentModels.$inferSelect
export type NewAgentModelRow = typeof agentModels.$inferInsert

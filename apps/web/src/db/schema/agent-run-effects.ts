/**
 * `agent_run_effects` — the durable-effect ledger for one agent run (D7). An agent wraps work that
 * must not repeat in `ctx.once(key, fn)`; the result is recorded here under `(run_id, key)`, and a
 * later attempt of the same run reads the recorded value instead of doing the work again. The
 * `agent_run_effects_run_key_idx` UNIQUE index IS the guarantee — like
 * `agent_runs_active_exclusive_idx`, it is a database constraint, never an in-memory map.
 *
 * Deliberately NOT `agent_run_events`: that log's `type` is a closed enum the UI renders and
 * `GET /api/agents/runs/:id` returns every row of it, whereas an effect result is internal runtime
 * state. No route reads this table.
 *
 * The contract is at-least-once WITH a recorded result, not exactly-once: an isolate that dies
 * between `fn()` returning and this insert committing repeats the effect. `result` is jsonb, so the
 * rule for callers is "return ids, not rows".
 */
import { relations } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { agentRuns } from './agent-runs'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const agentRunEffects = pgTable(
  'agent_run_effects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    tenantId: tenantRef(tenants),
    /** The agent's own name for this unit of work, unique within the run. */
    key: text('key').notNull(),
    /** Whatever `fn()` returned, replayed verbatim to a later attempt. `null` is a valid result. */
    result: jsonb('result'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('agent_run_effects_run_key_idx').on(table.runId, table.key),
    index('agent_run_effects_tenant_run_idx').on(table.tenantId, table.runId),
    tenantIsolation('agent_run_effects'),
  ]
)

export const agentRunEffectsRelations = relations(agentRunEffects, ({ one }) => ({
  run: one(agentRuns, { fields: [agentRunEffects.runId], references: [agentRuns.id] }),
  tenant: one(tenants, { fields: [agentRunEffects.tenantId], references: [tenants.id] }),
}))

export type AgentRunEffectRow = typeof agentRunEffects.$inferSelect
export type NewAgentRunEffectRow = typeof agentRunEffects.$inferInsert

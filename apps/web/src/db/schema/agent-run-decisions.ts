/**
 * `agent_run_decisions` — every typed question an agent run asked through `ctx.decide`: the
 * state and questions it sent, the answers and probabilities it got back, and the engine that gave
 * them. It is three things at once, which is why it is a table and not an event row:
 *
 * - **The idempotency record.** `UNIQUE (run_id, key)` makes a re-entered `run()` find its answer
 *   instead of asking again — the same contract as `agent_run_effects` and `agent_run_interrupts`.
 * - **The audit trail.** "Which engine decided this, on what inputs, under which questions?" —
 *   `provider`/`method`/`model`, `request`, and `questions_hash` (the policy fingerprint, over the
 *   questions and not the state, so every case judged under one rubric shares it).
 * - **The replay and eval source.** A question set is re-askable over its recorded states, and an
 *   eval reads answers per key without a model call.
 *
 * `method` is `typesafe` (calibrated) or `llm_self_report` (a chat model's own numbers). It is a
 * text column over the contract's closed set, so a third engine is a contract change, not a migration.
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import type { DecisionAnswers, DecisionRequest } from '@rocketflare/shared/ai/decisions'
import { DECISION_METHODS } from '@rocketflare/shared/ai/decisions'
import { relations } from 'drizzle-orm'
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { agentRuns } from './agent-runs'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const agentRunDecisions = pgTable(
  'agent_run_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    /** The agent's own stable name for this decision — the idempotency key within the run. */
    key: text('key').notNull(),
    /** `typesafe`, or the chat provider that answered for the fallback. */
    provider: text('provider').notNull(),
    method: text('method', { enum: DECISION_METHODS }).notNull(),
    model: text('model').notNull(),
    request: jsonb('request').$type<DecisionRequest>().notNull(),
    answers: jsonb('answers').$type<DecisionAnswers>().notNull(),
    usage: jsonb('usage').$type<TokenUsage>().notNull(),
    questionsHash: text('questions_hash').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    ...timestamps(),
  },
  table => [
    uniqueIndex('agent_run_decisions_run_key_idx').on(table.runId, table.key),
    index('agent_run_decisions_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    // "Every case judged under this rubric" — the replay and drift query.
    index('agent_run_decisions_tenant_hash_idx').on(table.tenantId, table.questionsHash),
    tenantIsolation('agent_run_decisions'),
  ]
)

export const agentRunDecisionsRelations = relations(agentRunDecisions, ({ one }) => ({
  run: one(agentRuns, { fields: [agentRunDecisions.runId], references: [agentRuns.id] }),
  tenant: one(tenants, { fields: [agentRunDecisions.tenantId], references: [tenants.id] }),
}))

export type AgentRunDecisionRow = typeof agentRunDecisions.$inferSelect
export type NewAgentRunDecisionRow = typeof agentRunDecisions.$inferInsert

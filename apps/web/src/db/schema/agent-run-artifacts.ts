/**
 * `agent_run_artifacts` — the things an agent run PRODUCED that a person opens (issue #17): a draft
 * email, a table of the rows it is about to change, the document it wrote.
 *
 * **An artifact is a table row and a steering note is an event row, and the asymmetry is the whole
 * design** (decision 4). An artifact is MUTABLE — a redraft must replace itself under
 * `(run_id, key)` — it is QUERIED ACROSS RUNS ("everything this agent has produced"), and it
 * OUTLIVES the run with an id a card links to. An append-only positional log expresses none of
 * those. What goes in `agent_run_events` is a *thin* `artifact` row carrying
 * `{ artifactId, key, kind, title }`: position in the timeline without making the log the store.
 *
 * `kind` is a real column as well as `data`'s discriminant so `(tenant_id, kind)` can index it;
 * `agentArtifactSchema`'s refinement is what stops the two drifting.
 *
 * Size caps live in the contract (`@rocketflare/shared/ai/artifacts`), not here: an artifact bigger
 * than they allow belongs in R2 as a `file` artifact, and `document` / `file` kinds carry **ids,
 * never content**, because those bytes already sit behind routes that enforce tenancy and, for a
 * document, group visibility (D29).
 */
import type { AgentArtifactData } from '@rocketflare/shared/ai/artifacts'
import { AGENT_ARTIFACT_KINDS } from '@rocketflare/shared/ai/artifacts'
import { relations } from 'drizzle-orm'
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { agentRuns } from './agent-runs'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const agentRunArtifacts = pgTable(
  'agent_run_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    /** The agent's own name for this artifact: the UPSERT key, so a redraft replaces itself. */
    key: text('key').notNull(),
    /**
     * The closed set from `@rocketflare/shared/ai/artifacts`, used DIRECTLY rather than mirrored
     * into a local `*_VALUES` const so the column and the contract cannot drift. Text, so a sixth
     * kind is a contract change and not a migration.
     */
    kind: text('kind', { enum: AGENT_ARTIFACT_KINDS }).notNull(),
    title: text('title').notNull(),
    description: text('description'),
    data: jsonb('data').$type<AgentArtifactData>().notNull(),
    ...timestamps(),
  },
  table => [
    // The upsert key: a redrafted artifact replaces itself instead of accumulating versions.
    uniqueIndex('agent_run_artifacts_run_key_idx').on(table.runId, table.key),
    index('agent_run_artifacts_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    index('agent_run_artifacts_tenant_kind_idx').on(table.tenantId, table.kind),
    tenantIsolation('agent_run_artifacts'),
  ]
)

export const agentRunArtifactsRelations = relations(agentRunArtifacts, ({ one }) => ({
  run: one(agentRuns, { fields: [agentRunArtifacts.runId], references: [agentRuns.id] }),
  tenant: one(tenants, { fields: [agentRunArtifacts.tenantId], references: [tenants.id] }),
}))

export type AgentRunArtifactRow = typeof agentRunArtifacts.$inferSelect
export type NewAgentRunArtifactRow = typeof agentRunArtifacts.$inferInsert

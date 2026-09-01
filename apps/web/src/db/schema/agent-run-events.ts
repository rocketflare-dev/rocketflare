/**
 * `agent_run_events` — append-only progress log for one agent run (D7, D8). The Workflow appends a
 * row per `step` / `tool.start` / `tool.end` / `text` / `status` / `error` event and then nudges the
 * tenant's hub (`entity.changed { entity: 'agent-run', id }`); viewers re-query `GET
 * /api/agents/runs/:id`, so progress survives a reconnect, a retry and a different isolate.
 * `seq` is assigned per run by the writer and continues across attempts; `(run_id, seq)` is unique
 * so a re-driven step can never duplicate a position.
 */
import type { AgentRunEventType } from '@gmgo/shared/ai/agents'
import { relations } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { agentRuns } from './agent-runs'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const agentRunEvents = pgTable(
  'agent_run_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    tenantId: tenantRef(tenants),
    /** Position within this run's stream, from 1. */
    seq: integer('seq').notNull(),
    type: text('type').$type<AgentRunEventType>().notNull(),
    data: jsonb('data').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('agent_run_events_run_seq_idx').on(table.runId, table.seq),
    index('agent_run_events_tenant_run_idx').on(table.tenantId, table.runId),
    tenantIsolation('agent_run_events'),
  ]
)

export const agentRunEventsRelations = relations(agentRunEvents, ({ one }) => ({
  run: one(agentRuns, { fields: [agentRunEvents.runId], references: [agentRuns.id] }),
  tenant: one(tenants, { fields: [agentRunEvents.tenantId], references: [tenants.id] }),
}))

export type AgentRunEventRow = typeof agentRunEvents.$inferSelect
export type NewAgentRunEventRow = typeof agentRunEvents.$inferInsert

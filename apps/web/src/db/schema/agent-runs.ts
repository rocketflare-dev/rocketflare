/**
 * `agent_runs` — one row per agent run (D7): the durable claim record behind `AGENT_RUN_WORKFLOW`.
 * A row is inserted `queued` BEFORE the Workflow instance is created (id = run id); the `claim`
 * step flips it to `running` with `UPDATE … WHERE status IN ('queued','running') RETURNING` — the
 * row IS the idempotency gate, so a retried step re-claims and a settled row is a no-op.
 * `agent_runs_active_exclusive_idx` (partial unique on `(tenant_id, agent_key)` while active) is
 * the **exclusive** guarantee: a second enqueue while one is queued/running fails at the database,
 * never in memory. `cancelRequestedAt` is the cooperative cancel flag the run polls between turns.
 * `input`/`output` are jsonb so a retry re-reads the payload from the row, not a message, and
 * `checkpoint` is where a retried step picks the tool loop back up instead of replaying it.
 */
import type { AgentKey, AgentRunStatus } from '@rocketflare/shared/ai/agents'
import { relations, sql } from 'drizzle-orm'
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
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

/** Mirrors `agentRunStatusSchema` in `@rocketflare/shared/ai/agents`; text so a new state is no migration. */
export const AGENT_RUN_STATUS_VALUES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly AgentRunStatus[]

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** Text, not an enum: a new agent gains run history without a schema change. */
    agentKey: text('agent_key').$type<AgentKey>().notNull(),
    status: text('status', { enum: AGENT_RUN_STATUS_VALUES }).notNull().default('queued'),
    input: jsonb('input').notNull(),
    output: jsonb('output'),
    /** Failure message when `failed`. NULL on a cancel — that is a status, not a message. */
    error: text('error'),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The Workflow instance id (deterministic = the run id). Unique so a probe maps back 1:1. */
    instanceId: text('instance_id').unique(),
    /** Execute attempts started; the Workflow step retry re-claims and increments it. */
    attempt: integer('attempt').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Cooperative cancel flag: set by the route, read by the run between turns. */
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    /**
     * Resume point for a retried `execute` step: the tool loop's transcript, turns spent and tokens
     * billed so far (`ToolLoopCheckpoint`). Scratch space, not a record — every terminal settle
     * clears it, and a row that fails to parse on read starts the run fresh rather than failing it.
     * Untyped on purpose: it is internal runtime state with no `@rocketflare/shared` contract, and
     * `db/schema` must not import from `api/services`. Validated in `services/agents/runs.ts`.
     */
    checkpoint: jsonb('checkpoint'),
    ...timestamps(),
  },
  table => [
    index('agent_runs_tenant_agent_status_idx').on(table.tenantId, table.agentKey, table.status),
    index('agent_runs_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    // The EXCLUSIVE guarantee (D7): at most one active run per (tenant, agent), by the database.
    uniqueIndex('agent_runs_active_exclusive_idx')
      .on(table.tenantId, table.agentKey)
      .where(sql`${table.status} IN ('queued', 'running')`),
    tenantIsolation('agent_runs'),
  ]
)

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  tenant: one(tenants, { fields: [agentRuns.tenantId], references: [tenants.id] }),
  requestedBy: one(users, { fields: [agentRuns.requestedByUserId], references: [users.id] }),
}))

export type AgentRunRow = typeof agentRuns.$inferSelect
export type NewAgentRunRow = typeof agentRuns.$inferInsert

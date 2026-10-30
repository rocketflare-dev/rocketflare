/**
 * `agent_runs` — one row per agent run: the durable claim record behind `AGENT_RUN_WORKFLOW`.
 * A row is inserted `queued` BEFORE the Workflow instance is created (id = run id); the `claim`
 * step flips it to `running` with `UPDATE … WHERE status IN ('queued','running') RETURNING` — the
 * row IS the idempotency gate, so a retried step re-claims and a settled row is a no-op.
 * `agent_runs_active_exclusive_idx` (partial unique on `(tenant_id, agent_key, concurrency_key)`
 * while active, for rows WITH a key) is the **exclusive** guarantee: a second enqueue into the same
 * slot while one is queued/running fails at the database, never in memory. `concurrency_key` is
 * the slot — `''` for an `exclusive` agent (one per tenant), a caller's key to narrow it (one
 * active run per key), NULL for a non-exclusive run (no slot: any number may be active at once).
 * `cancelRequestedAt` is the cooperative cancel flag the run polls between turns.
 * `input`/`output` are jsonb so a retry re-reads the payload from the row, not a message, and
 * `checkpoint` is where a retried step picks the tool loop back up instead of replaying it.
 */
import type { AgentKey, AgentRunStatus } from '@rocketflare/shared/ai/agents'
import { ACTIVE_RUN_STATUSES } from '@rocketflare/shared/ai/agents'
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
  'awaiting_input',
] as const satisfies readonly AgentRunStatus[]

/**
 * `'queued', 'running', 'awaiting_input'` as SQL literals, derived from the shared list rather than
 * typed out, so the index predicate and `ACTIVE_RUN_STATUSES` cannot drift. `sql.raw` because this
 * renders into DDL: a bound parameter is not a thing a partial index predicate can hold.
 */
const ACTIVE_STATUS_LITERALS = ACTIVE_RUN_STATUSES.map(status => `'${status}'`).join(', ')

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
    /**
     * The run's OTLP trace id — derived from the run id (`traceIdForRun`), so every Workflow
     * step lands in one trace without carrying anything; stored so a reader need not know the rule.
     */
    traceId: text('trace_id'),
    /**
     * The exclusive SLOT this run holds while active, written by `enqueueRun` because a partial
     * index can only read the row it indexes: `''` = the whole tenant (an `exclusive` agent),
     * `<caller key>` = one active run per key, NULL = none (runs freely).
     */
    concurrencyKey: text('concurrency_key'),
    /** The `POST /runs/batch` call that created the row — `GET /runs?batchId=`. */
    batchId: uuid('batch_id'),
    ...timestamps(),
  },
  table => [
    index('agent_runs_tenant_agent_status_idx').on(table.tenantId, table.agentKey, table.status),
    index('agent_runs_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    // The EXCLUSIVE guarantee: at most one active run per (tenant, agent, slot), by the
    // database. A row with no slot (NULL `concurrency_key`, a non-exclusive agent — one person's
    // conversation, where two people at once is the normal case) is outside it.
    // The predicate is `ACTIVE_RUN_STATUSES`, which INCLUDES `awaiting_input`: a run parked on a
    // human is still *the* active run for that agent, and a narrower predicate would let a second
    // enqueue slip past the guarantee while the first waits for an answer. It is deliberately wider
    // than `CLAIMABLE_RUN_STATUSES`, which the claim step uses.
    uniqueIndex('agent_runs_active_exclusive_idx')
      .on(table.tenantId, table.agentKey, table.concurrencyKey)
      .where(
        sql`${table.status} IN (${sql.raw(ACTIVE_STATUS_LITERALS)}) AND ${table.concurrencyKey} IS NOT NULL`
      ),
    // The per-tenant concurrency cap counts active rows on every enqueue.
    index('agent_runs_tenant_status_idx').on(table.tenantId, table.status),
    index('agent_runs_tenant_batch_idx')
      .on(table.tenantId, table.batchId)
      .where(sql`${table.batchId} IS NOT NULL`),
    tenantIsolation('agent_runs'),
  ]
)

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  tenant: one(tenants, { fields: [agentRuns.tenantId], references: [tenants.id] }),
  requestedBy: one(users, { fields: [agentRuns.requestedByUserId], references: [users.id] }),
}))

export type AgentRunRow = typeof agentRuns.$inferSelect
export type NewAgentRunRow = typeof agentRuns.$inferInsert

/**
 * `agent_run_interrupts` — one row per question an agent run asked a person (issue #17). The run
 * parks (`agent_runs.status = 'awaiting_input'`, the Workflow instance on `step.waitForEvent`) and
 * resumes when somebody answers.
 *
 * Three properties of this table are load-bearing:
 *
 * - **`id` IS the AG-UI `Interrupt.id`.** The row is not a private mirror of something sent on the
 *   wire; it is the thing, and `toAguiInterrupt(row)` is a pure projection of it.
 * - **`UNIQUE (run_id, key)` is the idempotency.** A retried `execute` step re-enters the agent's
 *   `run()` from the top and asks again; the unique index is what makes the second ask find the
 *   first ask's ANSWER rather than opening a second question that nobody will ever see. Like
 *   `agent_run_effects_run_key_idx`, it is a database constraint and never an in-memory map.
 * - **`status` is the decision and every settle is a compare-and-set on `pending`.** That is what
 *   makes "two people answer at once → one 200, one 409" true, and it is why a rejection is
 *   `status = 'cancelled'` rather than an `approved` boolean: two ways to say no is how a UI and a
 *   server end up disagreeing (see `@rocketflare/shared/ai/interrupts`).
 *
 * `runId` is the ONLY host-specific column. Giving chat the same machinery is a nullable
 * `conversationId` sibling plus `CHECK (num_nonnulls(run_id, conversation_id) = 1)` — that is the
 * whole migration, which is why nothing else here names a run.
 */
import type { AgentInterruptSpec, JsonSchema } from '@rocketflare/shared/ai/interrupts'
import { AGENT_INTERRUPT_KINDS, AGENT_INTERRUPT_STATUSES } from '@rocketflare/shared/ai/interrupts'
import { relations } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { agentRuns } from './agent-runs'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const agentRunInterrupts = pgTable(
  'agent_run_interrupts',
  {
    /** The AG-UI `Interrupt.id` — generated here, quoted on the wire, answered by that id. */
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    /** The agent's own name for this ask, stable across attempts. Half of the idempotency key. */
    key: text('key').notNull(),
    /**
     * The closed set from `@rocketflare/shared/ai/interrupts`, used DIRECTLY rather than mirrored
     * into a local `*_VALUES` const: the column and the contract cannot drift if there is only one
     * list. Still `text`, so a fifth kind is a contract change and not a migration.
     */
    kind: text('kind', { enum: AGENT_INTERRUPT_KINDS }).notNull(),
    /** The AG-UI reason (`confirmation` | `tool_call` | `input_required`), from `aguiReasonFor`. */
    reason: text('reason').notNull(),
    message: text('message'),
    /** The tool call this ask gates, when it gates one. */
    toolCallId: text('tool_call_id'),
    /** JSON Schema an answer must satisfy — for a client that carries no kit code. */
    responseSchema: jsonb('response_schema').$type<JsonSchema>(),
    /** What was asked, in the shape the panel needs to draw it. Typed, and named `spec` not `metadata`. */
    spec: jsonb('spec').$type<AgentInterruptSpec>().notNull(),
    /** `pending` → `resolved` | `cancelled` | `expired`. Only `pending` is writable. */
    status: text('status', { enum: AGENT_INTERRUPT_STATUSES }).notNull().default('pending'),
    /**
     * The answer, once there is one. Untyped here because its shape depends on `kind` and on what
     * the ask offered: `interruptPayloadSchema(spec)` is the one validator, and it lives in shared
     * so the route's 400 and the UI's draft check cannot disagree.
     */
    payload: jsonb('payload'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    // The idempotency (T2): a re-entered `execute` finds the first ask, not a second question.
    uniqueIndex('agent_run_interrupts_run_key_idx').on(table.runId, table.key),
    // The inbox: everything this tenant still owes an answer to, newest first.
    index('agent_run_interrupts_tenant_status_idx').on(
      table.tenantId,
      table.status,
      table.createdAt.desc()
    ),
    // The run page: every ask this run made.
    index('agent_run_interrupts_tenant_run_idx').on(table.tenantId, table.runId),
    tenantIsolation('agent_run_interrupts'),
  ]
)

export const agentRunInterruptsRelations = relations(agentRunInterrupts, ({ one }) => ({
  run: one(agentRuns, { fields: [agentRunInterrupts.runId], references: [agentRuns.id] }),
  tenant: one(tenants, { fields: [agentRunInterrupts.tenantId], references: [tenants.id] }),
  resolvedBy: one(users, {
    fields: [agentRunInterrupts.resolvedByUserId],
    references: [users.id],
  }),
}))

export type AgentRunInterruptRow = typeof agentRunInterrupts.$inferSelect
export type NewAgentRunInterruptRow = typeof agentRunInterrupts.$inferInsert

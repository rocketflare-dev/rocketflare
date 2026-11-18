/**
 * `agent_run_turns` — the tool loop's journal: every model turn `runToolLoop` took and every tool
 * call it ran, recorded as each one settles. It is what makes the loop durable at the granularity
 * of a single call rather than a whole attempt:
 *
 * - **A model turn** (`role = 'model'`, one row per `(run_id, loop_key, turn)`) carries the
 *   response blocks, the stop reason, its usage, the messages folded in before it (steering
 *   notes), and `request_hash` — a fingerprint of the transcript it answered. A retried attempt
 *   that reaches the same turn with the same transcript is handed this row instead of paying for
 *   the call again; a different transcript asks the model and replaces the row.
 * - **A tool call** (`role = 'tool'`, one row per `(run_id, loop_key, tool_call_id)`) carries the
 *   result text. `status = 'started'` is written BEFORE a `Tool.sideEffects` handler runs, so a
 *   retry can tell "never ran" (no row) from "may have run" (`started`, no result) — the second
 *   settles as an unknown outcome the model sees, never as a silent second write.
 * - **The replay record.** Settling a run clears `agent_runs.checkpoint`; this table stays, so a
 *   strict `agent:replay` of a tool-loop agent is answered from it without a model call.
 *
 * Pruned nightly `AGENT_TRANSCRIPT_RETENTION_DAYS` (30) after the run settled (`scheduled.ts`).
 * Runs, events, effects and decisions are kept as they are. No route reads this table.
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import { relations, sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { agentRuns } from './agent-runs'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const AGENT_RUN_TURN_ROLES = ['model', 'tool'] as const
export const agentRunTurnRole = pgEnum('agent_run_turn_role', AGENT_RUN_TURN_ROLES)

export const AGENT_RUN_TURN_STATUSES = ['started', 'settled'] as const
export const agentRunTurnStatus = pgEnum('agent_run_turn_status', AGENT_RUN_TURN_STATUSES)

/**
 * What a row holds. The blocks are the loop's own `ContentBlock`/`ChatMessage` shapes, stored as
 * jsonb and parsed back field by field (`services/agents/turns.ts`), so the type here is loose on
 * purpose: a row written by an older build must degrade to "not recorded", never to a throw.
 */
export type AgentRunTurnContent =
  | {
      kind: 'model'
      content: unknown[]
      stopReason: string
      usage: TokenUsage
      /** Messages folded into the transcript before this call (`beforeTurn` — steering). */
      injected: unknown[]
    }
  | { kind: 'tool'; text: string; isError: boolean }

export const agentRunTurns = pgTable(
  'agent_run_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    /** Which loop of the run — `RunToolLoopOptions.key`, prefixed by the `ctx.scope` it ran in. */
    loopKey: text('loop_key').notNull(),
    /** The model turn (1-based, across attempts); a tool row carries the turn that asked for it. */
    turn: integer('turn').notNull(),
    role: agentRunTurnRole('role').notNull(),
    /** The model's id for the call — a tool row's identity within its loop. */
    toolCallId: text('tool_call_id'),
    toolName: text('tool_name'),
    status: agentRunTurnStatus('status').notNull().default('settled'),
    /** NULL only for a `started` tool row. */
    content: jsonb('content').$type<AgentRunTurnContent>(),
    /** Model rows: the transcript (plus the tool list) the turn answered. */
    requestHash: text('request_hash'),
    /** Model rows: the system prompt it ran under — a replay reports a changed one as drift. */
    systemHash: text('system_hash'),
    ...timestamps(),
  },
  table => [
    uniqueIndex('agent_run_turns_model_idx')
      .on(table.runId, table.loopKey, table.turn)
      .where(sql`role = 'model'`),
    uniqueIndex('agent_run_turns_tool_idx')
      .on(table.runId, table.loopKey, table.toolCallId)
      .where(sql`role = 'tool'`),
    index('agent_run_turns_tenant_run_idx').on(table.tenantId, table.runId),
    // The nightly prune's cutoff (`runPruneAgentTurns`), answered like `ai_spans`' own.
    index('agent_run_turns_tenant_updated_idx').on(table.tenantId, table.updatedAt),
    tenantIsolation('agent_run_turns'),
  ]
)

export const agentRunTurnsRelations = relations(agentRunTurns, ({ one }) => ({
  run: one(agentRuns, { fields: [agentRunTurns.runId], references: [agentRuns.id] }),
  tenant: one(tenants, { fields: [agentRunTurns.tenantId], references: [tenants.id] }),
}))

export type AgentRunTurnRow = typeof agentRunTurns.$inferSelect
export type NewAgentRunTurnRow = typeof agentRunTurns.$inferInsert

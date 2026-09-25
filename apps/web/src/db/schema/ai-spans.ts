/**
 * `ai_spans` — the local trace store (D32): every span the tracer records, batch-inserted in the
 * same flush that exports to OTLP, whether or not a backend is configured. It exists so an agent
 * (Claude Code, a developer at a terminal) can read a run's span tree with `rocketflare traces
 * show` — no vendor REST adapter, no credentials, and it works on a laptop with zero config.
 *
 * Append-only, no `updated_at`; pruned by the nightly cron past `OBSERVABILITY_SPAN_RETENTION_DAYS`.
 * `run_id`, `conversation_id` and `user_id` are plain uuids with NO foreign key: a span is a record
 * of what happened, and deleting a run or a thread must not rewrite its trace (the tenant FK is the
 * one cascade, because a deleted tenant's traces are its data). `content` is null when
 * `OBSERVABILITY_CAPTURE_CONTENT=false`; `attributes` never carries content.
 */
import type { TraceSpanKind, TraceSpanStatus } from '@rocketflare/shared/ai/traces'
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
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const aiSpans = pgTable(
  'ai_spans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** OTLP hex: 32 chars. The same id opens the trace in the configured backend. */
    traceId: text('trace_id').notNull(),
    /** OTLP hex: 16 chars. */
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    name: text('name').notNull(),
    kind: text('kind').$type<TraceSpanKind>().notNull(),
    status: text('status').$type<TraceSpanStatus>().notNull(),
    statusMessage: text('status_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    runId: uuid('run_id'),
    conversationId: uuid('conversation_id'),
    userId: uuid('user_id'),
    model: text('model'),
    provider: text('provider'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    toolName: text('tool_name'),
    /** The exported attributes minus content (`gen_ai.*`, `rocketflare.*`, …). */
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull(),
    /** Prompt/completion/tool I/O, clipped; null when capture is off. */
    content: jsonb('content').$type<{ input?: unknown; output?: unknown }>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    /** A span recorded twice (a settle that runs on two paths) is one row: `onConflictDoNothing`. */
    uniqueIndex('ai_spans_tenant_trace_span_idx').on(table.tenantId, table.traceId, table.spanId),
    index('ai_spans_tenant_started_idx').on(table.tenantId, table.startedAt.desc()),
    index('ai_spans_tenant_run_idx').on(table.tenantId, table.runId),
    index('ai_spans_tenant_conversation_idx').on(table.tenantId, table.conversationId),
    tenantIsolation('ai_spans'),
  ]
)

export const aiSpansRelations = relations(aiSpans, ({ one }) => ({
  tenant: one(tenants, { fields: [aiSpans.tenantId], references: [tenants.id] }),
}))

export type AiSpanRow = typeof aiSpans.$inferSelect
export type NewAiSpanRow = typeof aiSpans.$inferInsert

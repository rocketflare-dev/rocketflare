/**
 * AI trace contracts (D32): the local span store (`ai_spans`) read back as traces, for
 * `GET /api/traces` (list) and `GET /api/traces/:id` (one trace's spans, parent-linked) and the
 * CLI's `rocketflare traces list|show`. A span is one unit of AI work — the agent/chat root, each
 * model call, each tool execution, retrieval and embeddings — with the GenAI attributes it was
 * exported with. `content` is null when the deployment sets `OBSERVABILITY_CAPTURE_CONTENT=false`.
 * Trace ids are OTLP hex (32 chars) so the same id opens the trace in the configured backend.
 */
import { z } from 'zod'
import { paginatedResponse, paginationQuerySchema } from '../pagination'

export const TRACE_SPAN_KINDS = [
  'agent',
  'llm',
  'tool',
  'retrieval',
  'embedding',
  'job',
  'span',
] as const
export const traceSpanKindSchema = z.enum(TRACE_SPAN_KINDS)
export type TraceSpanKind = z.infer<typeof traceSpanKindSchema>

export const TRACE_SPAN_STATUSES = ['ok', 'error'] as const
export const traceSpanStatusSchema = z.enum(TRACE_SPAN_STATUSES)
export type TraceSpanStatus = z.infer<typeof traceSpanStatusSchema>

export const traceIdSchema = z.string().regex(/^[0-9a-f]{32}$/, 'a 32-character hex trace id')

export const traceSpanSchema = z.object({
  traceId: traceIdSchema,
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
  name: z.string(),
  kind: traceSpanKindSchema,
  status: traceSpanStatusSchema,
  statusMessage: z.string().nullable(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  durationMs: z.number().int().nonnegative(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  toolName: z.string().nullable(),
  attributes: z.record(z.unknown()),
  content: z.object({ input: z.unknown().optional(), output: z.unknown().optional() }).nullable(),
})
export type TraceSpan = z.infer<typeof traceSpanSchema>

export const traceSummarySchema = z.object({
  traceId: traceIdSchema,
  /** The root span's name (`invoke_agent research-topic`), or the earliest span's while a run is live. */
  name: z.string(),
  status: traceSpanStatusSchema,
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  durationMs: z.number().int().nonnegative(),
  spanCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  models: z.array(z.string()),
  runId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
  /** The trace in the configured backend (`OBSERVABILITY_TRACE_URL`), when one is set. */
  traceUrl: z.string().nullable(),
})
export type TraceSummary = z.infer<typeof traceSummarySchema>

export const traceListQuerySchema = paginationQuerySchema.extend({
  runId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  /** ISO timestamp: traces that started at or after it. */
  since: z.coerce.date().optional(),
  /** Agent key or surface (`chat`, `research-topic`) — matches the root's `rocketflare.name`. */
  agent: z.string().min(1).max(100).optional(),
  status: traceSpanStatusSchema.optional(),
})
export type TraceListQuery = z.infer<typeof traceListQuerySchema>

export const traceListResponseSchema = paginatedResponse(traceSummarySchema)
export type TraceListResponse = z.infer<typeof traceListResponseSchema>

export const traceDetailSchema = z.object({
  trace: traceSummarySchema,
  /** Every span, oldest first; build the tree from `parentSpanId`. */
  spans: z.array(traceSpanSchema),
})
export type TraceDetail = z.infer<typeof traceDetailSchema>

/**
 * `:id` on `GET /api/traces/:id` — a trace id, or an agent run id / message id, which the server
 * resolves to the trace it recorded.
 */
export const traceLookupParamSchema = z.object({
  id: z.union([traceIdSchema, z.string().uuid()]),
})

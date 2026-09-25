/**
 * Tracing seam (D32, superseding D16): a thin `Tracer` interface every AI call site talks to, with
 * a no-op default so code paths are identical with and without a backend. The one implementation
 * is the span recorder in `recorder.ts`, which `tracing.ts` builds with two sinks: the OTLP/HTTP
 * exporter (`otlp-fetch.ts`, when a backend is configured) and the local `ai_spans` store
 * (`span-store.ts`, always, when a database is reachable). No OpenTelemetry dependency —
 * `@opentelemetry/sdk-node` cannot run in Workers, and the wire format is small enough to own.
 *
 * Handles NEST: `handle.span()` opens a child and returns its handle, so a tool call can parent the
 * retrieval it runs. Every handle carries a stable OTLP `traceId` (32 hex) and `spanId` (16 hex).
 * `id` is the trace id, kept for the plugins that read it before nesting existed.
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'

/** What a span IS — it picks the GenAI operation name and the backend's observation type. */
export type SpanKind = 'agent' | 'llm' | 'tool' | 'retrieval' | 'embedding' | 'job' | 'span'

export type SpanAttributeValue = string | number | boolean | string[]
export type SpanAttributes = Record<string, SpanAttributeValue | undefined>

export interface TraceParams {
  /** Stable per agent/surface, e.g. `chat`, `summarize-text`. The root span is `invoke_agent <name>`. */
  name: string
  tenantId?: string
  userId?: string
  /** Groups related traces; defaults to `conversationId ?? runId`. */
  sessionId?: string
  /** The agent run this trace belongs to — `rocketflare.run_id`, and the `ai_spans.run_id` column. */
  runId?: string
  /** The chat thread this trace belongs to — `rocketflare.conversation_id`. */
  conversationId?: string
  tags?: string[]
  metadata?: Record<string, string | number | boolean | undefined>
  input?: unknown
  /** An evaluation run (`rocketflare.eval=true`), so a backend can filter it out of production views. */
  eval?: boolean
  /** Join an existing trace instead of starting one — how every Workflow step lands in ONE trace. */
  traceId?: string
  /** A fixed span id for this span (the run's deterministic root); random otherwise. */
  spanId?: string
  /** Make this span a child of one recorded elsewhere (another Worker invocation). */
  parentSpanId?: string
  /** Override the span name (`execute#0`); defaults to `invoke_agent <name>`. */
  spanName?: string
  /** Defaults to `agent`. */
  kind?: SpanKind
  startTime?: Date
}

export interface GenerationParams {
  name: string
  model: string
  provider: string
  input: unknown
  output?: unknown
  usage?: TokenUsage
  startTime: Date
  endTime: Date
  level?: 'DEFAULT' | 'ERROR'
  statusMessage?: string
  metadata?: Record<string, unknown>
}

export interface SpanParams {
  name: string
  kind?: SpanKind
  input?: unknown
  output?: unknown
  /** Defaults to now. */
  startTime?: Date
  /** Given → the span is recorded as already finished. Omitted → it stays open until `end()`. */
  endTime?: Date
  level?: 'DEFAULT' | 'ERROR'
  statusMessage?: string
  metadata?: Record<string, unknown>
  attributes?: SpanAttributes
}

export interface ToolCallParams {
  name: string
  toolCallId?: string
  input?: unknown
  output?: unknown
  startTime: Date
  endTime: Date
  isError?: boolean
  statusMessage?: string
}

export interface TraceHandle {
  /** The trace id (kept as `id` for callers that predate nesting). */
  readonly id: string
  readonly traceId: string
  readonly spanId: string
  /** A child span. Open until `end()` unless `endTime` is given. */
  span(params: SpanParams): TraceHandle
  /** A finished model call, as a `chat <model>` child. */
  generation(params: GenerationParams): void
  /** A finished tool execution, as an `execute_tool <name>` child. */
  toolCall(params: ToolCallParams): void
  setAttributes(attributes: SpanAttributes): void
  /** Finish this span with its output (or error). Idempotent: only the first call records. */
  end(result?: { output?: unknown; error?: unknown }): void
}

export interface Tracer {
  /** `true` when spans go somewhere — an OTLP backend, the local store, or both. */
  readonly enabled: boolean
  startTrace(params: TraceParams): TraceHandle
  /** Ship what is batched. Safe to call repeatedly; never throws. */
  flush(): Promise<void>
}

const NOOP_TRACE_ID = '00000000000000000000000000000000'
const NOOP_SPAN_ID = '0000000000000000'

const noopHandle: TraceHandle = {
  id: NOOP_TRACE_ID,
  traceId: NOOP_TRACE_ID,
  spanId: NOOP_SPAN_ID,
  span: () => noopHandle,
  generation() {},
  toolCall() {},
  setAttributes() {},
  end() {},
}

/** What a context carries when no sink is reachable (a unit test, a bare router). */
export const noopTracer: Tracer = {
  enabled: false,
  startTrace: () => noopHandle,
  flush: async () => {},
}

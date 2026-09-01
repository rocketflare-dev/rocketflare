/**
 * Tracing seam (D16): a thin `Tracer` interface every LLM call site talks to, with a no-op default
 * so agent code paths are identical in dev/CI and production. The only v1 implementation is the
 * fetch-based Langfuse batcher (`langfuse-fetch.ts`), selected by `tracing.ts` when both keys are
 * present. No OpenTelemetry dependency — `@opentelemetry/sdk-node` cannot run in Workers.
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'

export interface TraceParams {
  /** Stable per agent/surface, e.g. `chat`, `summarize-text`. */
  name: string
  tenantId?: string
  userId?: string
  /** Groups related traces (a conversation id, an agent run id). */
  sessionId?: string
  tags?: string[]
  metadata?: Record<string, string | number | boolean | undefined>
  input?: unknown
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
  input?: unknown
  output?: unknown
  startTime: Date
  endTime: Date
  level?: 'DEFAULT' | 'ERROR'
  statusMessage?: string
  metadata?: Record<string, unknown>
}

export interface TraceHandle {
  readonly id: string
  generation(params: GenerationParams): void
  span(params: SpanParams): void
  /** Record the trace's output (or error) — call once when the work is done. */
  end(result?: { output?: unknown; error?: unknown }): void
}

export interface Tracer {
  readonly enabled: boolean
  startTrace(params: TraceParams): TraceHandle
  /** Ship what is batched. Safe to call repeatedly; never throws. */
  flush(): Promise<void>
}

const noopHandle: TraceHandle = {
  id: '00000000-0000-0000-0000-000000000000',
  generation() {},
  span() {},
  end() {},
}

/** What a request without Langfuse keys carries. */
export const noopTracer: Tracer = {
  enabled: false,
  startTrace: () => noopHandle,
  flush: async () => {},
}

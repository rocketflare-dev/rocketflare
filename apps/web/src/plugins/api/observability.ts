/**
 * Logging and tracing, as a plugin sees them (D16 → D32, D31).
 *
 * There is deliberately no `createLogger` here. A logger is always INJECTED — `ctx.logger` in every
 * context — because the one a request carries is bound to its request id, the one a job carries to
 * its job id, and a plugin that built its own would emit lines nothing could correlate. What is
 * exported is the TYPE (for a plugin's own service signatures) and the tracing wrappers, which are
 * genuinely callable rather than injectable: they bracket a span, so they take the work.
 *
 * Since D32 handles nest (`trace.span()` returns a child) and a plugin's TOOLS need nothing at all:
 * every tool execution is traced by the kit's tool runner, in chat and agent runs alike.
 */

import type { Tracer } from '../../api/observability/tracer'
import { noopTracer } from '../../api/observability/tracer'
import { traceChatClient, withAgentTrace } from '../../api/observability/tracing'

export { traceStep } from '../../api/observability/context'
export type {
  GenerationParams,
  SpanAttributes,
  SpanKind,
  SpanParams,
  ToolCallParams,
  TraceHandle,
  Tracer,
} from '../../api/observability/tracer'
export type { AgentTraceContext } from '../../api/observability/tracing'
export type { Logger } from '../../api/utils/core/logger'
/**
 * Bracket a unit of model work as one trace, and wrap the client so every call inside it is one
 * `chat <model>` span with its token usage. `traceStep` nests a span of your own (a retrieval, a
 * call out to your service) under whatever is active.
 *
 * A plugin that calls a model outside an agent run (a route that summarises something, a job that
 * classifies) should use these rather than leaving the work untraced — the Usage page reads
 * `ai_usage`, but "what did this actually send" only ever lives in the trace.
 */
/**
 * The tracer a context carries when nothing is reachable. Exported so a plugin's own test or a
 * maintenance path can supply one without reaching for `tracerFor(cfg)`, which reads config a
 * plugin has already been handed.
 */
export { noopTracer, traceChatClient, withAgentTrace }

/** `true` when this request/run is actually recording spans — cheap enough to branch on. */
export function tracingEnabled(tracer: Tracer): boolean {
  return tracer.enabled
}

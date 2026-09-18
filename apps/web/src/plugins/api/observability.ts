/**
 * Logging and tracing, as a plugin sees them (D16, D31).
 *
 * There is deliberately no `createLogger` here. A logger is always INJECTED — `ctx.logger` in every
 * context — because the one a request carries is bound to its request id, the one a job carries to
 * its job id, and a plugin that built its own would emit lines nothing could correlate. What is
 * exported is the TYPE (for a plugin's own service signatures) and the two tracing wrappers, which
 * are genuinely callable rather than injectable: they bracket a span, so they take the work.
 */

import type { Tracer } from '../../api/observability/tracer'
import { noopTracer } from '../../api/observability/tracer'
import { traceChatClient, withAgentTrace } from '../../api/observability/tracing'

export type {
  GenerationParams,
  SpanParams,
  TraceHandle,
  Tracer,
} from '../../api/observability/tracer'
export type { AgentTraceContext } from '../../api/observability/tracing'
export type { Logger } from '../../api/utils/core/logger'
/**
 * Bracket a unit of model work as one trace, and wrap the client so every call inside it is one
 * `generation` with its token usage.
 *
 * A plugin that calls a model outside an agent run (a route that summarises something, a job that
 * classifies) should use these rather than leaving the work untraced — the Usage page reads
 * `ai_usage`, but "what did this actually send" only ever lives in the trace.
 */
/**
 * The tracer a context carries when Langfuse is not configured. Exported so a plugin's own test or
 * a maintenance path can supply one without reaching for `tracerFor(cfg)`, which reads config a
 * plugin has already been handed.
 */
export { noopTracer, traceChatClient, withAgentTrace }

/** `true` when this request/run is actually shipping traces — cheap enough to branch on. */
export function tracingEnabled(tracer: Tracer): boolean {
  return tracer.enabled
}

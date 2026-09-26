/**
 * Every attribute name the kit writes on a span, in ONE module (D32). Three vocabularies, because
 * three kinds of backend read them:
 *
 * - **OpenTelemetry GenAI semantic conventions** (`gen_ai.*`, Development status) — the neutral
 *   core: operation, provider, model, token usage, finish reasons, tool name/id/arguments/result.
 * - **OpenInference** (`openinference.span.kind`, `input.value`, `llm.*`) — what Arize Phoenix
 *   renders its span tree from.
 * - **Langfuse aliases** (`langfuse.*`) — trace name, session, user, tags, observation type and
 *   level. Langfuse maps most `gen_ai.*` itself; the aliases cover what it does not.
 *
 * A semconv rename is an edit here and nowhere else. Content (prompts, completions, tool I/O) is
 * NOT written at record time: `contentAttributes` adds it at export time, and only when
 * `OBSERVABILITY_CAPTURE_CONTENT` allows it, so the recorded span never has to be scrubbed.
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import type { SpanAttributes, SpanKind } from './tracer'

export const ATTR = {
  operationName: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  agentName: 'gen_ai.agent.name',
  requestModel: 'gen_ai.request.model',
  requestMaxTokens: 'gen_ai.request.max_tokens',
  responseModel: 'gen_ai.response.model',
  finishReasons: 'gen_ai.response.finish_reasons',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  cacheReadTokens: 'gen_ai.usage.cache_read.input_tokens',
  cacheWriteTokens: 'gen_ai.usage.cache_creation.input_tokens',
  inputMessages: 'gen_ai.input.messages',
  outputMessages: 'gen_ai.output.messages',
  toolName: 'gen_ai.tool.name',
  toolType: 'gen_ai.tool.type',
  toolCallId: 'gen_ai.tool.call.id',
  toolCallArguments: 'gen_ai.tool.call.arguments',
  toolCallResult: 'gen_ai.tool.call.result',
  conversationId: 'gen_ai.conversation.id',

  sessionId: 'session.id',
  userId: 'user.id',
  environment: 'deployment.environment.name',
  errorType: 'error.type',

  tenantId: 'rocketflare.tenant_id',
  runId: 'rocketflare.run_id',
  rfConversationId: 'rocketflare.conversation_id',
  eval: 'rocketflare.eval',
  feedbackRating: 'rocketflare.feedback.rating',
  feedbackTarget: 'rocketflare.feedback.target',
  provider: 'rocketflare.provider',
  tags: 'rocketflare.tags',

  oiSpanKind: 'openinference.span.kind',
  oiInputValue: 'input.value',
  oiInputMime: 'input.mime_type',
  oiOutputValue: 'output.value',
  oiOutputMime: 'output.mime_type',
  oiModelName: 'llm.model_name',
  oiPromptTokens: 'llm.token_count.prompt',
  oiCompletionTokens: 'llm.token_count.completion',
  oiTotalTokens: 'llm.token_count.total',
  oiToolName: 'tool.name',

  lfTraceName: 'langfuse.trace.name',
  lfTraceTags: 'langfuse.trace.tags',
  lfTraceInput: 'langfuse.trace.input',
  lfTraceOutput: 'langfuse.trace.output',
  lfSessionId: 'langfuse.session.id',
  lfUserId: 'langfuse.user.id',
  lfEnvironment: 'langfuse.environment',
  lfObservationType: 'langfuse.observation.type',
  lfObservationLevel: 'langfuse.observation.level',
  lfStatusMessage: 'langfuse.observation.status_message',
  lfObservationInput: 'langfuse.observation.input',
  lfObservationOutput: 'langfuse.observation.output',
  lfTraceMetadataPrefix: 'langfuse.trace.metadata.',
} as const

/** `gen_ai.operation.name` per kind. `retrieval` is not (yet) in semconv; it is what Phoenix shows. */
const OPERATION: Record<SpanKind, string | undefined> = {
  agent: 'invoke_agent',
  llm: 'chat',
  tool: 'execute_tool',
  retrieval: 'retrieval',
  embedding: 'embeddings',
  job: undefined,
  span: undefined,
}

const OPENINFERENCE_KIND: Record<SpanKind, string> = {
  agent: 'AGENT',
  llm: 'LLM',
  tool: 'TOOL',
  retrieval: 'RETRIEVER',
  embedding: 'EMBEDDING',
  job: 'CHAIN',
  span: 'CHAIN',
}

const LANGFUSE_TYPE: Record<SpanKind, string> = {
  agent: 'agent',
  llm: 'generation',
  tool: 'tool',
  retrieval: 'retriever',
  embedding: 'embedding',
  job: 'span',
  span: 'span',
}

/** The kit's provider ids → `gen_ai.provider.name` well-known values (unknowns pass through). */
export function genAiProvider(provider: string): string {
  switch (provider) {
    case 'anthropic':
    case 'anthropic_compatible':
      return 'anthropic'
    case 'openai':
    case 'openai_compatible':
      return 'openai'
    case 'workers_ai':
      return 'cloudflare.workers_ai'
    default:
      return provider
  }
}

/** The span name semconv prescribes: `{operation} {target}`. */
export function spanNameFor(kind: SpanKind, target: string): string {
  const operation = OPERATION[kind]
  return operation ? `${operation} ${target}` : target
}

/** Attributes every span of a kind carries. */
export function kindAttributes(kind: SpanKind): SpanAttributes {
  return {
    [ATTR.operationName]: OPERATION[kind],
    [ATTR.oiSpanKind]: OPENINFERENCE_KIND[kind],
    [ATTR.lfObservationType]: LANGFUSE_TYPE[kind],
  }
}

export interface TraceContextAttrs {
  tenantId?: string
  userId?: string
  sessionId?: string
  runId?: string
  conversationId?: string
  eval?: boolean
}

/** Correlation attributes, put on EVERY span so a backend filtering one span still sees whose it is. */
export function contextAttributes(ctx: TraceContextAttrs): SpanAttributes {
  return {
    [ATTR.tenantId]: ctx.tenantId,
    [ATTR.userId]: ctx.userId,
    [ATTR.lfUserId]: ctx.userId,
    [ATTR.sessionId]: ctx.sessionId,
    [ATTR.lfSessionId]: ctx.sessionId,
    [ATTR.runId]: ctx.runId,
    [ATTR.rfConversationId]: ctx.conversationId,
    [ATTR.conversationId]: ctx.conversationId,
    [ATTR.eval]: ctx.eval ? true : undefined,
  }
}

/** What only the ROOT of a trace says: its name, tags and metadata. */
export function rootAttributes(params: {
  name: string
  tags?: string[]
  metadata?: Record<string, string | number | boolean | undefined>
}): SpanAttributes {
  const attrs: SpanAttributes = {
    [ATTR.agentName]: params.name,
    [ATTR.lfTraceName]: params.name,
    [ATTR.lfTraceTags]: params.tags?.length ? params.tags : undefined,
    [ATTR.tags]: params.tags?.length ? params.tags : undefined,
  }
  for (const [key, value] of Object.entries(params.metadata ?? {})) {
    if (value === undefined) continue
    attrs[`${ATTR.lfTraceMetadataPrefix}${key}`] =
      typeof value === 'string' ? value.slice(0, 200) : value
    attrs[`rocketflare.${key}`] = typeof value === 'string' ? value.slice(0, 200) : value
  }
  return attrs
}

/** A model call: request/response model, provider, usage (cache tokens separate), finish reason. */
export function generationAttributes(params: {
  model: string
  provider: string
  usage?: TokenUsage
  maxTokens?: number
  stopReason?: string
}): SpanAttributes {
  const usage = params.usage
  const total = usage
    ? usage.inputTokens +
      usage.outputTokens +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0)
    : undefined
  return {
    [ATTR.providerName]: genAiProvider(params.provider),
    [ATTR.provider]: params.provider,
    [ATTR.requestModel]: params.model,
    [ATTR.responseModel]: params.model,
    [ATTR.requestMaxTokens]: params.maxTokens,
    [ATTR.finishReasons]: params.stopReason ? [params.stopReason] : undefined,
    [ATTR.inputTokens]: usage?.inputTokens,
    [ATTR.outputTokens]: usage?.outputTokens,
    [ATTR.cacheReadTokens]: usage?.cacheReadTokens,
    [ATTR.cacheWriteTokens]: usage?.cacheWriteTokens,
    [ATTR.oiModelName]: params.model,
    [ATTR.oiPromptTokens]: usage?.inputTokens,
    [ATTR.oiCompletionTokens]: usage?.outputTokens,
    [ATTR.oiTotalTokens]: total,
  }
}

export function toolAttributes(params: { name: string; toolCallId?: string }): SpanAttributes {
  return {
    [ATTR.toolName]: params.name,
    [ATTR.toolType]: 'function',
    [ATTR.toolCallId]: params.toolCallId,
    [ATTR.oiToolName]: params.name,
  }
}

export function embeddingAttributes(params: {
  model: string
  provider: string
  count: number
}): SpanAttributes {
  return {
    [ATTR.providerName]: genAiProvider(params.provider),
    [ATTR.provider]: params.provider,
    [ATTR.requestModel]: params.model,
    [ATTR.oiModelName]: params.model,
    'rocketflare.embeddings.count': params.count,
  }
}

/** Status in the backends' own words — Langfuse reads a level, everyone reads the OTLP status. */
export function errorAttributes(message: string | undefined, type?: string): SpanAttributes {
  return {
    [ATTR.lfObservationLevel]: 'ERROR',
    [ATTR.lfStatusMessage]: message?.slice(0, 500),
    [ATTR.errorType]: type ?? 'error',
  }
}

/** Longest content string exported or stored; the rest is cut and marked. */
export const CONTENT_MAX_CHARS = 32_000

export function contentString(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return ''
  return text.length > CONTENT_MAX_CHARS
    ? `${text.slice(0, CONTENT_MAX_CHARS)}… [truncated ${text.length - CONTENT_MAX_CHARS} chars]`
    : text
}

/**
 * The content half, added at EXPORT time: OpenInference `input.value`/`output.value` on every span
 * (Phoenix renders them, Langfuse maps them), the structured `gen_ai.*` form on model and tool
 * spans, and — for Langfuse only — the observation/trace input and output aliases.
 */
export function contentAttributes(
  kind: SpanKind,
  content: { input?: unknown; output?: unknown },
  options: { root: boolean; langfuse: boolean }
): SpanAttributes {
  const input = content.input === undefined ? undefined : contentString(content.input)
  const output = content.output === undefined ? undefined : contentString(content.output)
  const attrs: SpanAttributes = {
    [ATTR.oiInputValue]: input,
    [ATTR.oiInputMime]: input === undefined ? undefined : mimeOf(content.input),
    [ATTR.oiOutputValue]: output,
    [ATTR.oiOutputMime]: output === undefined ? undefined : mimeOf(content.output),
  }
  if (kind === 'llm') {
    attrs[ATTR.inputMessages] = input
    attrs[ATTR.outputMessages] = output
  } else if (kind === 'tool') {
    attrs[ATTR.toolCallArguments] = input
    attrs[ATTR.toolCallResult] = output
  }
  if (options.langfuse) {
    attrs[ATTR.lfObservationInput] = input
    attrs[ATTR.lfObservationOutput] = output
    if (options.root) {
      attrs[ATTR.lfTraceInput] = input
      attrs[ATTR.lfTraceOutput] = output
    }
  }
  return attrs
}

function mimeOf(value: unknown): string {
  return typeof value === 'string' ? 'text/plain' : 'application/json'
}

/**
 * The span recorder behind `Tracer` (D32): handles open and nest in memory, a span is appended to
 * the batch when it ENDS, and `flush()` hands the batch to every sink — the OTLP exporter and the
 * `ai_spans` store — in parallel. Called in `waitUntil` by the middleware, awaited at the end of a
 * stream, a Workflow step or a job; never on the response path, and a sink that fails is logged,
 * never thrown. Content is dropped HERE when `OBSERVABILITY_CAPTURE_CONTENT=false`, so no sink can
 * leak what was never kept.
 */
import type { Logger } from '../utils/core/logger'
import {
  ATTR,
  contextAttributes,
  errorAttributes,
  generationAttributes,
  kindAttributes,
  rootAttributes,
  spanNameFor,
  type TraceContextAttrs,
  toolAttributes,
} from './genai-attributes'
import { newSpanId, newTraceId } from './trace-ids'
import type {
  GenerationParams,
  SpanAttributes,
  SpanAttributeValue,
  SpanKind,
  SpanParams,
  ToolCallParams,
  TraceHandle,
  TraceParams,
  Tracer,
} from './tracer'

/** One finished span, as both sinks receive it. */
export interface RecordedSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: SpanKind
  startTime: Date
  endTime: Date
  status: 'ok' | 'error'
  statusMessage?: string
  /** Non-content attributes only; content is added by the exporter from `content`. */
  attributes: Record<string, SpanAttributeValue>
  /** Null when capture is off or there was nothing to capture. */
  content: { input?: unknown; output?: unknown } | null
  /** No parent anywhere — the span a backend names the trace after. */
  root: boolean
  tenantId?: string
  userId?: string
  runId?: string
  conversationId?: string
  model?: string
  provider?: string
  inputTokens?: number
  outputTokens?: number
  toolName?: string
}

export type SpanSink = (spans: RecordedSpan[]) => Promise<void>

export interface RecorderOptions {
  sinks: SpanSink[]
  captureContent: boolean
  logger?: Pick<Logger, 'warn' | 'debug'>
}

export function describeSpanError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500)
  if (typeof error === 'string') return error.slice(0, 500)
  return 'error'
}

function compact(attributes: SpanAttributes): Record<string, SpanAttributeValue> {
  const out: Record<string, SpanAttributeValue> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    out[key] = value
  }
  return out
}

interface TraceScope extends TraceContextAttrs {
  traceId: string
}

interface FinishResult {
  output?: unknown
  error?: unknown
  endTime?: Date
  usage?: GenerationParams['usage']
}

interface OpenSpan {
  handle: TraceHandle
  /** End THIS span — each span owns its own, so a child can never close its parent. */
  finish(result: FinishResult): void
}

interface OpenSpanInit {
  spanId?: string
  parentSpanId?: string
  name: string
  kind: SpanKind
  startTime?: Date
  attributes?: SpanAttributes
  input?: unknown
  root: boolean
}

export function createTracer(options: RecorderOptions): Tracer {
  const batch: RecordedSpan[] = []

  const contentOf = (input: unknown, output: unknown): RecordedSpan['content'] => {
    if (!options.captureContent) return null
    if (input === undefined && output === undefined) return null
    return {
      ...(input !== undefined && { input }),
      ...(output !== undefined && { output }),
    }
  }

  const open = (scope: TraceScope, init: OpenSpanInit): OpenSpan => {
    const spanId = init.spanId ?? newSpanId()
    const startTime = init.startTime ?? new Date()
    const attributes: SpanAttributes = {
      ...kindAttributes(init.kind),
      ...contextAttributes(scope),
      ...init.attributes,
    }
    let ended = false

    const handle: TraceHandle = {
      id: scope.traceId,
      traceId: scope.traceId,
      spanId,
      span(params: SpanParams) {
        const { handle: child, finish: finishChild } = open(scope, {
          parentSpanId: spanId,
          name: params.name,
          kind: params.kind ?? 'span',
          startTime: params.startTime,
          attributes: {
            ...params.attributes,
            ...metadataAttributes(params.metadata),
          },
          input: params.input,
          root: false,
        })
        if (params.endTime) {
          finishChild({
            output: params.output,
            error: params.level === 'ERROR' ? (params.statusMessage ?? 'error') : undefined,
            endTime: params.endTime,
          })
        }
        return child
      },
      generation(g: GenerationParams) {
        const { finish: finishChild } = open(scope, {
          parentSpanId: spanId,
          name: spanNameFor('llm', g.model),
          kind: 'llm',
          startTime: g.startTime,
          attributes: {
            ...generationAttributes({
              model: g.model,
              provider: g.provider,
              usage: g.usage,
              maxTokens: numberOr(g.metadata?.maxTokens),
              stopReason: stringOr(g.metadata?.stopReason),
            }),
            'rocketflare.generation.name': g.name,
          },
          input: g.input,
          root: false,
        })
        finishChild({
          output: g.output,
          error: g.level === 'ERROR' ? (g.statusMessage ?? 'error') : undefined,
          endTime: g.endTime,
          usage: g.usage,
        })
      },
      toolCall(t: ToolCallParams) {
        const { finish: finishChild } = open(scope, {
          parentSpanId: spanId,
          name: spanNameFor('tool', t.name),
          kind: 'tool',
          startTime: t.startTime,
          attributes: toolAttributes({ name: t.name, toolCallId: t.toolCallId }),
          input: t.input,
          root: false,
        })
        finishChild({
          output: t.output,
          error: t.isError ? (t.statusMessage ?? 'tool returned an error') : undefined,
          endTime: t.endTime,
        })
      },
      setAttributes(extra: SpanAttributes) {
        Object.assign(attributes, extra)
      },
      end(result) {
        finish(result ?? {})
      },
    }

    function finish(result: FinishResult) {
      if (ended) return
      ended = true
      const failed = result.error !== undefined && result.error !== null
      const statusMessage = failed ? describeSpanError(result.error) : undefined
      batch.push({
        traceId: scope.traceId,
        spanId,
        parentSpanId: init.parentSpanId,
        name: init.name,
        kind: init.kind,
        startTime,
        endTime: result.endTime ?? new Date(),
        status: failed ? 'error' : 'ok',
        statusMessage,
        attributes: compact({
          ...attributes,
          ...(failed ? errorAttributes(statusMessage, errorType(result.error)) : {}),
        }),
        content: contentOf(init.input, result.output),
        root: init.root,
        tenantId: scope.tenantId,
        userId: scope.userId,
        runId: scope.runId,
        conversationId: scope.conversationId,
        // The store's typed columns, read off the attributes so any span that carries them (one
        // opened with `span({ kind: 'tool', attributes })` as much as `toolCall()`) fills them.
        model: stringOr(attributes[ATTR.requestModel]),
        provider: stringOr(attributes[ATTR.provider]),
        toolName: stringOr(attributes[ATTR.toolName]),
        inputTokens: result.usage?.inputTokens ?? numberOr(attributes[ATTR.inputTokens]),
        outputTokens: result.usage?.outputTokens ?? numberOr(attributes[ATTR.outputTokens]),
      })
    }

    return { handle, finish }
  }

  const startTrace = (params: TraceParams): TraceHandle => {
    const kind = params.kind ?? 'agent'
    const scope: TraceScope = {
      traceId: params.traceId ?? newTraceId(),
      tenantId: params.tenantId,
      userId: params.userId,
      sessionId: params.sessionId ?? params.conversationId ?? params.runId,
      runId: params.runId,
      conversationId: params.conversationId,
      eval: params.eval,
    }
    const root = !params.parentSpanId
    return open(scope, {
      spanId: params.spanId,
      parentSpanId: params.parentSpanId,
      name: params.spanName ?? spanNameFor(kind, params.name),
      kind,
      startTime: params.startTime,
      attributes: {
        ...(root
          ? rootAttributes({ name: params.name, tags: params.tags, metadata: params.metadata })
          : metadataAttributes(params.metadata)),
        'rocketflare.name': params.name,
      },
      input: params.input,
      root,
    }).handle
  }

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const spans = batch.splice(0)
    const results = await Promise.allSettled(options.sinks.map(sink => sink(spans)))
    for (const result of results) {
      if (result.status === 'rejected') {
        options.logger?.warn({ err: result.reason, spans: spans.length }, 'tracing: sink failed')
      }
    }
  }

  return { enabled: options.sinks.length > 0, startTrace, flush }
}

function metadataAttributes(metadata: Record<string, unknown> | undefined): SpanAttributes {
  const out: SpanAttributes = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (typeof value === 'string') out[`rocketflare.${key}`] = value.slice(0, 200)
    else if (typeof value === 'number' || typeof value === 'boolean')
      out[`rocketflare.${key}`] = value
  }
  return out
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function errorType(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : error.name
  }
  return 'error'
}

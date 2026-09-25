/**
 * The tracing seams every AI entry point uses (D32): `withAgentTrace(name, ctx, fn)` brackets one
 * agent run step / chat turn / AI job as a span and makes it ACTIVE (`context.ts`), and
 * `traceChatClient(client, trace, meta)` wraps a `ChatClient` so every `complete`/`stream` is one
 * `chat <model>` child with usage. Tool, retrieval and embeddings spans nest under the active span
 * on their own. `tracerFor(cfg, { store })` is the switch: a recorder with the OTLP exporter when a
 * backend is configured (`exporterSettings`) and the `ai_spans` store when a database is, the
 * no-op when neither.
 */
import type { AppConfig } from '../../config'
import type { ChatClient, ChatParams, ChatResult } from '../services/ai/types'
import type { Logger } from '../utils/core/logger'
import { withActiveSpan } from './context'
import { createOtlpExporter, type OtlpProtocol } from './otlp-fetch'
import { createTracer, type SpanSink } from './recorder'
import { noopTracer, type TraceHandle, type TraceParams, type Tracer } from './tracer'

export type ObservabilityPreset = 'langfuse' | 'phoenix' | 'generic'

export interface ExporterSettings {
  preset: ObservabilityPreset
  endpoint: string
  protocol: OtlpProtocol
  headers: Record<string, string>
}

/**
 * `OTEL_EXPORTER_OTLP_HEADERS` as the OTel spec defines it: `k=v` pairs separated by commas, values
 * URL-encoded. A malformed pair is dropped rather than failing config — tracing never breaks the app.
 */
export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const pair of (value ?? '').split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = pair.slice(0, eq).trim().toLowerCase()
    let raw = pair.slice(eq + 1).trim()
    try {
      raw = decodeURIComponent(raw)
    } catch {
      // Not encoded after all; keep it verbatim.
    }
    if (key && raw) headers[key] = raw
  }
  return headers
}

/** Which preset applies: the explicit one, else Langfuse when its keys exist, else generic. */
export function observabilityPreset(cfg: AppConfig): ObservabilityPreset {
  if (cfg.OBSERVABILITY_PRESET) return cfg.OBSERVABILITY_PRESET
  return cfg.LANGFUSE_PUBLIC_KEY && cfg.LANGFUSE_SECRET_KEY ? 'langfuse' : 'generic'
}

/**
 * Where, how and with which headers to export — or `null` for "record locally only". The preset
 * fills what the backend needs so a deployment sets as little as possible:
 * - `langfuse`: endpoint defaults to `<LANGFUSE_BASE_URL>/api/public/otel`; Basic auth from the
 *   EXISTING `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY` plus `x-langfuse-ingestion-version: 4`, so a D16
 *   deployment migrates with no new secret. Without both keys there is nothing to authenticate as.
 * - `phoenix`: endpoint required (`http://localhost:6006` for the docker image); protobuf by default.
 * - `generic`: endpoint required; headers exactly as given.
 * Explicit `OTEL_EXPORTER_OTLP_HEADERS` win over preset headers of the same name.
 */
export function exporterSettings(cfg: AppConfig): ExporterSettings | null {
  const preset = observabilityPreset(cfg)
  const explicit = parseOtlpHeaders(cfg.OTEL_EXPORTER_OTLP_HEADERS)
  if (preset === 'langfuse') {
    if (!cfg.LANGFUSE_PUBLIC_KEY || !cfg.LANGFUSE_SECRET_KEY) return null
    return {
      preset,
      endpoint:
        cfg.OTEL_EXPORTER_OTLP_ENDPOINT ??
        `${cfg.LANGFUSE_BASE_URL.replace(/\/+$/, '')}/api/public/otel`,
      protocol: cfg.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/json',
      headers: {
        authorization: `Basic ${btoa(`${cfg.LANGFUSE_PUBLIC_KEY}:${cfg.LANGFUSE_SECRET_KEY}`)}`,
        'x-langfuse-ingestion-version': '4',
        ...explicit,
      },
    }
  }
  if (!cfg.OTEL_EXPORTER_OTLP_ENDPOINT) return null
  return {
    preset,
    endpoint: cfg.OTEL_EXPORTER_OTLP_ENDPOINT,
    protocol:
      cfg.OTEL_EXPORTER_OTLP_PROTOCOL ?? (preset === 'phoenix' ? 'http/protobuf' : 'http/json'),
    headers: explicit,
  }
}

/** `true` when spans leave the Worker for a backend (the local store is independent of this). */
export function isTracingEnabled(cfg: AppConfig): boolean {
  return exporterSettings(cfg) !== null
}

/** The trace in the configured backend, from `OBSERVABILITY_TRACE_URL`; null when unset. */
export function traceUrlFor(cfg: AppConfig, traceId: string): string | null {
  return cfg.OBSERVABILITY_TRACE_URL
    ? cfg.OBSERVABILITY_TRACE_URL.replace('{traceId}', traceId)
    : null
}

export interface TracerForOptions {
  fetch?: typeof fetch
  logger?: Pick<Logger, 'warn' | 'debug'>
  /** The `ai_spans` sink (`databaseSpanStore` / `ownConnectionSpanStore`); omitted → export only. */
  store?: SpanSink | null
}

/** A per-request / per-step tracer over whichever sinks are available; the no-op when none is. */
export function tracerFor(cfg: AppConfig, options: TracerForOptions = {}): Tracer {
  const sinks: SpanSink[] = []
  const settings = exporterSettings(cfg)
  if (settings) {
    sinks.push(
      createOtlpExporter({
        endpoint: settings.endpoint,
        headers: settings.headers,
        protocol: settings.protocol,
        langfuse: settings.preset === 'langfuse',
        resource: {
          serviceName: cfg.APP_NAME,
          serviceVersion: cfg.RELEASE_VERSION,
          environment: cfg.LANGFUSE_TRACING_ENVIRONMENT ?? cfg.APP_ENV,
        },
        fetch: options.fetch,
        logger: options.logger,
      })
    )
  }
  if (options.store) sinks.push(options.store)
  if (sinks.length === 0) return noopTracer
  return createTracer({
    sinks,
    captureContent: cfg.OBSERVABILITY_CAPTURE_CONTENT,
    logger: options.logger,
  })
}

export interface AgentTraceContext extends Omit<TraceParams, 'name'> {
  tracer: Tracer
}

/**
 * Run `fn` inside one span named for `name` (`invoke_agent <name>` unless `spanName` overrides it),
 * ACTIVE for everything `fn` does, so tools, retrieval and embeddings nest under it. The handle is
 * passed so the body can wrap its client with `traceChatClient`. Output is recorded on success, the
 * error on failure (then rethrown).
 */
export async function withAgentTrace<T>(
  name: string,
  ctx: AgentTraceContext,
  fn: (trace: TraceHandle) => Promise<T>
): Promise<T> {
  const { tracer, ...params } = ctx
  const trace = tracer.startTrace({ name, ...params })
  if (!tracer.enabled) return fn(trace)
  try {
    const output = await withActiveSpan(trace, () => fn(trace))
    trace.end({ output })
    return output
  } catch (error) {
    trace.end({ error })
    throw error
  }
}

export interface TraceClientMeta {
  provider: string
  /** Kept as `rocketflare.generation.name`; the span itself is `chat <model>` per semconv. */
  name?: string
}

function generationInput(params: ChatParams) {
  return { system: params.system, messages: params.messages, tools: params.tools?.map(t => t.name) }
}

/** Wrap a client so each call emits a `chat <model>` child of `trace`. Unchanged when tracing is off. */
export function traceChatClient(
  client: ChatClient,
  trace: TraceHandle,
  meta: TraceClientMeta,
  tracer?: Tracer
): ChatClient {
  if (tracer && !tracer.enabled) return client
  const name = meta.name ?? `${meta.provider}.messages`
  const record = (params: ChatParams, startTime: Date, result?: ChatResult, error?: unknown) => {
    trace.generation({
      name,
      model: result?.model ?? params.model,
      provider: meta.provider,
      input: generationInput(params),
      output: result?.content,
      usage: result?.usage,
      startTime,
      endTime: new Date(),
      level: error ? 'ERROR' : 'DEFAULT',
      statusMessage: error ? (error instanceof Error ? error.message : String(error)) : undefined,
      metadata: { maxTokens: params.maxTokens, stopReason: result?.stopReason },
    })
  }
  return {
    provider: client.provider,
    countTokens: client.countTokens?.bind(client),
    async complete(params) {
      const startTime = new Date()
      try {
        const result = await client.complete(params)
        record(params, startTime, result)
        return result
      } catch (err) {
        record(params, startTime, undefined, err)
        throw err
      }
    },
    async *stream(params) {
      const startTime = new Date()
      let result: ChatResult | undefined
      try {
        for await (const delta of client.stream(params)) {
          if (delta.type === 'end') result = delta.result
          yield delta
        }
        record(params, startTime, result)
      } catch (err) {
        record(params, startTime, result, err)
        throw err
      }
    },
  }
}

/**
 * OTLP/HTTP over plain `fetch` (replacing the Langfuse ingestion client): a span sink
 * that serialises a batch to ONE `ExportTraceServiceRequest` and POSTs it to
 * `<endpoint>/v1/traces`. JSON by default (`http/json`, what Langfuse and Cloudflare's own export
 * speak); protobuf (`http/protobuf`, `otlp-protobuf.ts`) for backends that accept nothing else, such
 * as Phoenix. No dependencies, no Node APIs, errors swallowed and logged — tracing must never break
 * the app, and the recorder already runs it in `waitUntil`.
 */
import type { Logger } from '../utils/core/logger'
import { contentAttributes, GENAI_SEMCONV_SCHEMA_URL } from './genai-attributes'
import { encodeOtlpProtobuf } from './otlp-protobuf'
import type { RecordedSpan, SpanSink } from './recorder'
import type { SpanAttributeValue } from './tracer'

export type OtlpProtocol = 'http/json' | 'http/protobuf'

export type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAnyValue[] } }

export interface OtlpKeyValue {
  key: string
  value: OtlpAnyValue
}

export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  /** 1 INTERNAL · 3 CLIENT. */
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpKeyValue[]
  /** 0 UNSET · 2 ERROR. Success stays UNSET, as the spec recommends for instrumentation. */
  status: { code: number; message?: string }
}

export interface OtlpExportRequest {
  resourceSpans: {
    resource: { attributes: OtlpKeyValue[] }
    scopeSpans: {
      scope: { name: string; version?: string }
      /** The semantic-conventions version the attribute names follow (`GENAI_SEMCONV_SCHEMA_URL`). */
      schemaUrl?: string
      spans: OtlpSpan[]
    }[]
  }[]
}

export interface OtlpResource {
  serviceName: string
  serviceVersion: string
  environment: string
}

export interface OtlpExporterOptions {
  /** Base URL; `/v1/traces` is appended unless it is already there. */
  endpoint: string
  headers: Record<string, string>
  protocol: OtlpProtocol
  resource: OtlpResource
  /** Add the `langfuse.observation.*` content aliases. */
  langfuse: boolean
  /**
   * `<APP_URL>/api/traces` when the local store keeps content too: a captured model span then
   * carries `gen_ai.*_ref` URIs to its stored copy. Never a signed URL — the route is auth-gated.
   */
  contentRefBase?: string
  /** Injected for tests. */
  fetch?: typeof fetch
  logger?: Pick<Logger, 'warn' | 'debug'>
}

export const SCOPE_NAME = 'rocketflare'

export function tracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '')
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`
}

export function anyValue(value: SpanAttributeValue): OtlpAnyValue {
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  return { arrayValue: { values: value.map(v => ({ stringValue: v })) } }
}

function keyValues(attributes: Record<string, SpanAttributeValue | undefined>): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = []
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) out.push({ key, value: anyValue(value) })
  }
  return out
}

const unixNano = (date: Date): string => (BigInt(date.getTime()) * 1_000_000n).toString()

export function toOtlpSpan(
  span: RecordedSpan,
  options: { langfuse: boolean; contentRefBase?: string }
): OtlpSpan {
  // Only a span the store keeps: it has a tenant (`ai_spans` skips one without).
  const ref =
    options.contentRefBase && span.tenantId
      ? `${options.contentRefBase}/${span.traceId}#${span.spanId}`
      : undefined
  const content = span.content
    ? contentAttributes(span.kind, span.content, {
        root: span.root,
        langfuse: options.langfuse,
        ref,
      })
    : {}
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId && { parentSpanId: span.parentSpanId }),
    name: span.name,
    kind: span.kind === 'llm' || span.kind === 'embedding' ? 3 : 1,
    startTimeUnixNano: unixNano(span.startTime),
    endTimeUnixNano: unixNano(span.endTime),
    attributes: keyValues({ ...span.attributes, ...content }),
    status:
      span.status === 'error'
        ? { code: 2, ...(span.statusMessage && { message: span.statusMessage }) }
        : { code: 0 },
  }
}

export function toOtlpRequest(
  spans: RecordedSpan[],
  resource: OtlpResource,
  options: { langfuse: boolean; scopeVersion?: string; contentRefBase?: string }
): OtlpExportRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: keyValues({
            'service.name': resource.serviceName,
            'service.version': resource.serviceVersion,
            'deployment.environment.name': resource.environment,
            'telemetry.sdk.name': SCOPE_NAME,
            'telemetry.sdk.language': 'webjs',
            ...(options.langfuse && { 'langfuse.environment': resource.environment }),
          }),
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: options.scopeVersion ?? resource.serviceVersion },
            schemaUrl: GENAI_SEMCONV_SCHEMA_URL,
            spans: spans.map(s => toOtlpSpan(s, options)),
          },
        ],
      },
    ],
  }
}

export function createOtlpExporter(options: OtlpExporterOptions): SpanSink {
  const url = tracesUrl(options.endpoint)
  const fetchImpl = options.fetch ?? fetch
  return async spans => {
    if (spans.length === 0) return
    const request = toOtlpRequest(spans, options.resource, {
      langfuse: options.langfuse,
      contentRefBase: options.contentRefBase,
    })
    const binary = options.protocol === 'http/protobuf'
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          ...options.headers,
          'content-type': binary ? 'application/x-protobuf' : 'application/json',
        },
        body: binary ? encodeOtlpProtobuf(request) : JSON.stringify(request),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        options.logger?.warn(
          { status: res.status, spans: spans.length, body: body.slice(0, 300) },
          'tracing: OTLP export returned a non-OK status'
        )
      }
    } catch (err) {
      options.logger?.debug({ err }, 'tracing: OTLP export failed (non-blocking)')
    }
  }
}

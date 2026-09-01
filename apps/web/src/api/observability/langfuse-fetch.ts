/**
 * Langfuse over plain `fetch` (D16): events (`trace-create`, `generation-create`, `span-create`)
 * are batched in memory per request and POSTed once to `/api/public/ingestion` (basic auth
 * `publicKey:secretKey`) from `flush()` — called in `waitUntil`, never on the response path.
 * Errors are swallowed and logged: tracing must never break the app. Shape ported from the
 * Workers reference app's ingestion client, generalised behind the `Tracer` interface.
 */
import type { GenerationParams, SpanParams, TraceHandle, TraceParams, Tracer } from './tracer'

export interface LangfuseTracerOptions {
  publicKey: string
  secretKey: string
  baseUrl: string
  /** Shown in Langfuse for filtering; the kit passes `LANGFUSE_TRACING_ENVIRONMENT ?? APP_ENV`. */
  environment?: string
  /** Injected for tests. */
  fetch?: typeof fetch
  logger?: { warn(obj: unknown, msg?: string): void; debug(obj: unknown, msg?: string): void }
}

interface IngestionEvent {
  id: string
  type: 'trace-create' | 'generation-create' | 'span-create'
  timestamp: string
  body: Record<string, unknown>
}

/** Langfuse `usageDetails`: cache tokens are SEPARATE from input, so `total` sums all of them. */
export function toUsageDetails(
  usage: GenerationParams['usage']
): Record<string, number> | undefined {
  if (!usage) return undefined
  const details: Record<string, number> = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    total:
      usage.inputTokens +
      usage.outputTokens +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0),
  }
  if (usage.cacheReadTokens !== undefined) details.cache_read = usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined) details.cache_creation = usage.cacheWriteTokens
  return details
}

function compactMetadata(metadata: TraceParams['metadata']): Record<string, string> | undefined {
  if (!metadata) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) out[key] = String(value).slice(0, 200)
  }
  return Object.keys(out).length ? out : undefined
}

export function createLangfuseTracer(options: LangfuseTracerOptions): Tracer {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const fetchImpl = options.fetch ?? fetch
  const batch: IngestionEvent[] = []
  const now = () => new Date().toISOString()

  const push = (type: IngestionEvent['type'], body: Record<string, unknown>) => {
    batch.push({ id: crypto.randomUUID(), type, timestamp: now(), body })
  }
  const withEnv = (body: Record<string, unknown>) =>
    options.environment ? { ...body, environment: options.environment } : body

  const startTrace = (params: TraceParams): TraceHandle => {
    const traceId = crypto.randomUUID()
    const startedAt = new Date()
    const base = withEnv({
      id: traceId,
      name: params.name,
      timestamp: startedAt.toISOString(),
      ...(params.input !== undefined && { input: params.input }),
      ...(params.userId && { userId: params.userId }),
      ...(params.sessionId && { sessionId: params.sessionId }),
      ...(params.tags?.length && { tags: params.tags }),
      ...(compactMetadata({ tenantId: params.tenantId, ...params.metadata }) && {
        metadata: compactMetadata({ tenantId: params.tenantId, ...params.metadata }),
      }),
    })
    push('trace-create', base)
    return {
      id: traceId,
      generation(g: GenerationParams) {
        push(
          'generation-create',
          withEnv({
            id: crypto.randomUUID(),
            traceId,
            name: g.name,
            model: g.model,
            modelParameters: { provider: g.provider },
            input: g.input,
            ...(g.output !== undefined && { output: g.output }),
            ...(g.usage && { usageDetails: toUsageDetails(g.usage) }),
            startTime: g.startTime.toISOString(),
            endTime: g.endTime.toISOString(),
            level: g.level ?? 'DEFAULT',
            ...(g.statusMessage && { statusMessage: g.statusMessage.slice(0, 500) }),
            ...(g.metadata && { metadata: g.metadata }),
          })
        )
      },
      span(s: SpanParams) {
        push(
          'span-create',
          withEnv({
            id: crypto.randomUUID(),
            traceId,
            name: s.name,
            ...(s.input !== undefined && { input: s.input }),
            ...(s.output !== undefined && { output: s.output }),
            startTime: s.startTime.toISOString(),
            endTime: s.endTime.toISOString(),
            level: s.level ?? 'DEFAULT',
            ...(s.statusMessage && { statusMessage: s.statusMessage.slice(0, 500) }),
            ...(s.metadata && { metadata: s.metadata }),
          })
        )
      },
      end(result) {
        // Langfuse upserts a trace by id: a second `trace-create` carries the output / error.
        push(
          'trace-create',
          withEnv({
            id: traceId,
            name: params.name,
            ...(result?.output !== undefined && { output: result.output }),
            ...(result?.error !== undefined && {
              metadata: {
                error: result.error instanceof Error ? result.error.message.slice(0, 200) : 'error',
              },
            }),
          })
        )
      },
    }
  }

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const events = batch.splice(0)
    try {
      const res = await fetchImpl(`${baseUrl}/api/public/ingestion`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${btoa(`${options.publicKey}:${options.secretKey}`)}`,
        },
        body: JSON.stringify({ batch: events }),
      })
      if (!res.ok) {
        options.logger?.warn(
          { status: res.status, eventCount: events.length },
          'Langfuse: ingestion returned non-OK status'
        )
        return
      }
      const json = (await res.json().catch(() => null)) as { errors?: unknown[] } | null
      if (json?.errors?.length)
        options.logger?.warn({ errors: json.errors }, 'Langfuse: event-level errors')
    } catch (err) {
      options.logger?.debug({ err }, 'Langfuse: flush failed (non-blocking)')
    }
  }

  return { enabled: true, startTrace, flush }
}

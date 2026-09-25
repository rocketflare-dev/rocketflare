/**
 * The `ai_spans` sink (D32): recorded spans batch-inserted into Postgres in the same flush as the
 * OTLP export, so `rocketflare traces show` works with zero credentials. A span with no tenant is
 * skipped — the table is tenant-scoped and RLS'd, and every AI path the kit traces has one.
 *
 * Two ways to get a database, because the flush runs in two kinds of place:
 * - `databaseSpanStore(db)` — a Workflow step or a job, whose client is open until after the flush.
 * - `ownConnectionSpanStore(cfg, env)` — a request, whose client is closed in `waitUntil` possibly
 *   BEFORE the tracer's flush runs there (and a chat stream closes its own first). It opens one
 *   short-lived client per non-empty flush; Hyperdrive is the pool, so that is cheap.
 * `onConflictDoNothing` on `(tenant_id, trace_id, span_id)`: a run's root is recorded by
 * `finishStep`, which runs twice on the expiry path.
 */
import type { AppConfig } from '../../config'
import { createDatabase, type Database, resolveDatabaseUrl } from '../../db/client'
import { aiSpans, type NewAiSpanRow } from '../../db/schema/ai-spans'
import { CONTENT_MAX_CHARS } from './genai-attributes'
import type { RecordedSpan, SpanSink } from './recorder'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const asUuid = (value: string | undefined): string | null =>
  value && UUID.test(value) ? value : null

/** Clip one content value to what the row should hold; a clipped value says so. */
function clip(value: unknown): unknown {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined || text.length <= CONTENT_MAX_CHARS) return value
  return { truncated: true, chars: text.length, preview: text.slice(0, CONTENT_MAX_CHARS) }
}

export function toSpanRow(span: RecordedSpan): NewAiSpanRow | null {
  const tenantId = asUuid(span.tenantId)
  if (!tenantId) return null
  return {
    tenantId,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? null,
    name: span.name.slice(0, 300),
    kind: span.kind,
    status: span.status,
    statusMessage: span.statusMessage ?? null,
    startedAt: span.startTime,
    endedAt: span.endTime,
    durationMs: Math.max(0, span.endTime.getTime() - span.startTime.getTime()),
    runId: asUuid(span.runId),
    conversationId: asUuid(span.conversationId),
    userId: asUuid(span.userId),
    model: span.model ?? null,
    provider: span.provider ?? null,
    inputTokens: span.inputTokens ?? null,
    outputTokens: span.outputTokens ?? null,
    toolName: span.toolName ?? null,
    attributes: span.attributes,
    content: span.content
      ? {
          ...(span.content.input !== undefined && { input: clip(span.content.input) }),
          ...(span.content.output !== undefined && { output: clip(span.content.output) }),
        }
      : null,
  }
}

export async function insertSpans(db: Database, spans: RecordedSpan[]): Promise<number> {
  const rows = spans.map(toSpanRow).filter((row): row is NewAiSpanRow => row !== null)
  if (rows.length === 0) return 0
  await db.insert(aiSpans).values(rows).onConflictDoNothing()
  return rows.length
}

export function databaseSpanStore(db: Database): SpanSink {
  return async spans => {
    await insertSpans(db, spans)
  }
}

export interface SpanStoreEnv {
  HYPERDRIVE?: Hyperdrive
}

/** A sink that opens (and closes) its own client per flush. `null` when no database is configured. */
export function ownConnectionSpanStore(cfg: AppConfig, env: SpanStoreEnv): SpanSink | null {
  if (!env.HYPERDRIVE && !cfg.PREVIEW_DATABASE_URL && !cfg.DATABASE_URL) return null
  return async spans => {
    if (!spans.some(span => asUuid(span.tenantId))) return
    const handle = createDatabase(
      resolveDatabaseUrl({
        HYPERDRIVE: env.HYPERDRIVE,
        PREVIEW_DATABASE_URL: cfg.PREVIEW_DATABASE_URL,
        DATABASE_URL: cfg.DATABASE_URL,
      })
    )
    try {
      await insertSpans(handle.db, spans)
    } finally {
      await handle.close()
    }
  }
}

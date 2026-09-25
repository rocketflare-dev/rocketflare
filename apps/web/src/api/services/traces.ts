/**
 * Reading the local trace store (D32): `ai_spans` grouped into traces for `GET /api/traces` and one
 * trace's spans for `GET /api/traces/:id`. Every query carries the tenant predicate first — the
 * store is written by background flushes with no request context, so the READ is where tenancy is
 * proven. A trace's status is its ROOT's when the root has been recorded (a tool that answered an
 * error inside a run that recovered is not a failed run), otherwise "any span errored" — which is
 * how a run still in flight, whose root `finishStep` has not written yet, reads.
 */
import type {
  TraceDetail,
  TraceListQuery,
  TraceListResponse,
  TraceSpan,
  TraceSummary,
} from '@rocketflare/shared/ai/traces'
import { paginationMeta } from '@rocketflare/shared/pagination'
import { and, asc, eq, type SQL, sql } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { Database } from '../../db/client'
import { agentRuns, aiSpans, messages } from '../../db/schema'
import { isTraceId, traceIdForRun } from '../observability/trace-ids'
import { traceUrlFor } from '../observability/tracing'
import { NotFoundError } from '../utils/core/errors'

interface TraceAggregateRow extends Record<string, unknown> {
  trace_id: string
  name: string
  started_at: string | Date
  ended_at: string | Date
  span_count: number | string
  error_count: number | string
  root_recorded: boolean
  root_failed: boolean
  input_tokens: number | string
  output_tokens: number | string
  models: string[] | null
  run_id: string | null
  conversation_id: string | null
  user_id: string | null
  total: number | string
}

const asDate = (value: string | Date) => (value instanceof Date ? value : new Date(value))

function toSummary(cfg: AppConfig, row: TraceAggregateRow): TraceSummary {
  const startedAt = asDate(row.started_at)
  const endedAt = asDate(row.ended_at)
  const errorCount = Number(row.error_count)
  const failed = row.root_recorded ? row.root_failed : errorCount > 0
  return {
    traceId: row.trace_id,
    name: row.name,
    status: failed ? 'error' : 'ok',
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    spanCount: Number(row.span_count),
    errorCount,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    models: row.models ?? [],
    runId: row.run_id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    traceUrl: traceUrlFor(cfg, row.trace_id),
  }
}

/**
 * One row per trace. Raw SQL because the root-first `array_agg(... ORDER BY)` and the `FILTER`
 * clauses have no query-builder form; `db.execute` hands back raw column names, hence the row type.
 */
function aggregateQuery(
  tenantId: string,
  where: SQL[],
  having: SQL[],
  limit: number,
  offset: number
) {
  const filters = sql.join([sql`s.tenant_id = ${tenantId}`, ...where], sql` AND `)
  const havingClause = having.length ? sql`HAVING ${sql.join(having, sql` AND `)}` : sql``
  return sql`
    WITH traces AS (
      SELECT
        s.trace_id,
        (array_agg(s.name ORDER BY (s.parent_span_id IS NULL) DESC, s.started_at))[1] AS name,
        min(s.started_at) AS started_at,
        max(s.ended_at) AS ended_at,
        count(*) AS span_count,
        count(*) FILTER (WHERE s.status = 'error') AS error_count,
        bool_or(s.parent_span_id IS NULL) AS root_recorded,
        coalesce(bool_or(s.parent_span_id IS NULL AND s.status = 'error'), false) AS root_failed,
        coalesce(sum(s.input_tokens) FILTER (WHERE s.kind = 'llm'), 0) AS input_tokens,
        coalesce(sum(s.output_tokens) FILTER (WHERE s.kind = 'llm'), 0) AS output_tokens,
        -- json, not text[]: \`db.execute\` returns raw values, and postgres.js parses json.
        json_agg(DISTINCT s.model) FILTER (WHERE s.model IS NOT NULL AND s.kind = 'llm') AS models,
        max(s.run_id::text) AS run_id,
        max(s.conversation_id::text) AS conversation_id,
        max(s.user_id::text) AS user_id
      FROM ai_spans s
      WHERE ${filters}
      GROUP BY s.trace_id
      ${havingClause}
    )
    SELECT traces.*, count(*) OVER () AS total
    FROM traces
    ORDER BY started_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `
}

export async function listTraces(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  query: TraceListQuery
): Promise<TraceListResponse> {
  const where: SQL[] = []
  const having: SQL[] = []
  if (query.runId) where.push(sql`s.run_id = ${query.runId}`)
  if (query.conversationId) where.push(sql`s.conversation_id = ${query.conversationId}`)
  if (query.since) where.push(sql`s.started_at >= ${query.since.toISOString()}`)
  if (query.agent) having.push(sql`bool_or(s.attributes->>'rocketflare.name' = ${query.agent})`)
  if (query.status === 'error') {
    having.push(sql`CASE WHEN bool_or(s.parent_span_id IS NULL)
      THEN coalesce(bool_or(s.parent_span_id IS NULL AND s.status = 'error'), false)
      ELSE bool_or(s.status = 'error') END`)
  } else if (query.status === 'ok') {
    having.push(sql`NOT CASE WHEN bool_or(s.parent_span_id IS NULL)
      THEN coalesce(bool_or(s.parent_span_id IS NULL AND s.status = 'error'), false)
      ELSE bool_or(s.status = 'error') END`)
  }
  const offset = (query.page - 1) * query.pageSize
  const rows = await db.execute<TraceAggregateRow>(
    aggregateQuery(tenantId, where, having, query.pageSize, offset)
  )
  const list = Array.from(rows)
  const total = list.length ? Number(list[0]?.total) : 0
  return {
    items: list.map(row => toSummary(cfg, row)),
    pagination: paginationMeta(query.page, query.pageSize, total),
  }
}

/**
 * `:id` → trace id. A trace id is taken as given; a uuid is an agent run (its stored or derived
 * trace id) or an assistant message (the turn that wrote it). Both lookups carry the tenant, so
 * another tenant's run id is exactly as unknown as a made-up one.
 */
export async function resolveTraceId(db: Database, tenantId: string, id: string): Promise<string> {
  if (isTraceId(id)) return id
  const [run] = await db
    .select({ id: agentRuns.id, traceId: agentRuns.traceId })
    .from(agentRuns)
    .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.id, id)))
    .limit(1)
  if (run) return run.traceId ?? traceIdForRun(run.id)
  const [message] = await db
    .select({ traceId: messages.traceId })
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.id, id)))
    .limit(1)
  if (message?.traceId) return message.traceId
  throw new NotFoundError('No trace for that id', 'trace_not_found')
}

export async function getTrace(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  id: string
): Promise<TraceDetail> {
  const traceId = await resolveTraceId(db, tenantId, id)
  const rows = await db
    .select()
    .from(aiSpans)
    .where(and(eq(aiSpans.tenantId, tenantId), eq(aiSpans.traceId, traceId)))
    .orderBy(asc(aiSpans.startedAt), asc(aiSpans.createdAt))
  if (rows.length === 0)
    throw new NotFoundError('No spans recorded for that trace', 'trace_not_found')
  const [summary] = Array.from(
    await db.execute<TraceAggregateRow>(
      aggregateQuery(tenantId, [sql`s.trace_id = ${traceId}`], [], 1, 0)
    )
  )
  if (!summary) throw new NotFoundError('No spans recorded for that trace', 'trace_not_found')
  const spans: TraceSpan[] = rows.map(row => ({
    traceId: row.traceId,
    spanId: row.spanId,
    parentSpanId: row.parentSpanId,
    name: row.name,
    kind: row.kind,
    status: row.status,
    statusMessage: row.statusMessage,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMs: row.durationMs,
    model: row.model,
    provider: row.provider,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    toolName: row.toolName,
    attributes: row.attributes,
    content: row.content,
  }))
  return { trace: toSummary(cfg, summary), spans }
}

/**
 * `rocketflare traces list|show` — the local AI trace store (`GET /api/traces`, admin+) (D32).
 *
 * `show` is what an agent debugging a run reads: the span tree, indented by parent, with each
 * span's model, tokens, latency and status, and — for tool, retrieval and model spans — the input
 * and output, clipped unless `--full`. `<id>` is a trace id, an agent run id or a message id; the
 * server resolves the last two. The backend link-out is printed when the deployment sets
 * `OBSERVABILITY_TRACE_URL`.
 */
import {
  type TraceDetail,
  type TraceSpan,
  traceDetailSchema,
  traceListResponseSchema,
} from '@rocketflare/shared/ai/traces'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context'
import { formatDate, formatPagination, renderTable } from '../utils/output'

export interface TracesListOptions {
  page?: number
  pageSize?: number
  /** Agent key or surface — `chat`, `research-topic`. */
  agent?: string
  status?: 'ok' | 'error'
  runId?: string
  conversation?: string
  since?: string
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export async function runTracesList(
  ctx: CommandContext,
  options: TracesListOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/traces', {
    schema: traceListResponseSchema,
    query: {
      page: options.page,
      pageSize: options.pageSize,
      agent: options.agent,
      status: options.status,
      runId: options.runId,
      conversationId: options.conversation,
      since: options.since,
    },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Started', value: t => formatDate(t.startedAt) },
      { header: 'Trace', value: t => t.traceId },
      { header: 'Name', value: t => t.name },
      { header: 'Status', value: t => (t.status === 'error' ? chalk.red('error') : 'ok') },
      { header: 'Took', value: t => formatDuration(t.durationMs) },
      { header: 'Spans', value: t => t.spanCount },
      { header: 'Tokens', value: t => `${t.inputTokens}/${t.outputTokens}` },
      { header: 'Run', value: t => t.runId },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

export interface TracesShowOptions {
  /** Print content unclipped. */
  full?: boolean
}

const CLIP = 400

function clip(value: unknown, full: boolean): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return ''
  return !full && text.length > CLIP
    ? `${text.slice(0, CLIP)}… (+${text.length - CLIP} chars)`
    : text
}

/** D33: a thumbs vote on the traced answer, recorded as a zero-length `feedback` span. */
function feedbackOf(span: TraceSpan): 1 | -1 | null {
  const rating = span.attributes['rocketflare.feedback.rating']
  return rating === 1 || rating === -1 ? rating : null
}

function spanLine(span: TraceSpan): string {
  const rating = feedbackOf(span)
  if (rating !== null) {
    return `${chalk.bold('feedback')}  ${rating === 1 ? chalk.green('👍 up') : chalk.red('👎 down')}`
  }
  const parts = [chalk.bold(span.name)]
  if (span.model && !span.name.includes(span.model)) parts.push(chalk.cyan(span.model))
  if (span.inputTokens !== null || span.outputTokens !== null) {
    parts.push(`${span.inputTokens ?? 0}→${span.outputTokens ?? 0} tok`)
  }
  parts.push(chalk.dim(formatDuration(span.durationMs)))
  if (span.status === 'error') parts.push(chalk.red(`ERROR ${span.statusMessage ?? ''}`.trim()))
  return parts.join('  ')
}

/** Content worth reading inline: tool I/O, retrieval, model output. The agent root's is the run's. */
const SHOW_CONTENT = new Set<TraceSpan['kind']>(['tool', 'retrieval', 'llm', 'agent'])

/** The span tree as indented lines; orphans (a parent in another invocation) print at the top. */
export function renderTraceTree(detail: TraceDetail, options: { full?: boolean } = {}): string {
  const full = options.full ?? false
  const ids = new Set(detail.spans.map(s => s.spanId))
  const children = new Map<string | null, TraceSpan[]>()
  for (const span of detail.spans) {
    const parent = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : null
    children.set(parent, [...(children.get(parent) ?? []), span])
  }
  const lines: string[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const span of children.get(parent) ?? []) {
      const indent = '  '.repeat(depth)
      lines.push(`${indent}${depth ? '└ ' : ''}${spanLine(span)}`)
      if (feedbackOf(span) !== null && typeof span.content?.input === 'string') {
        lines.push(chalk.dim(`${indent}${depth ? '  ' : ''}  "${clip(span.content.input, full)}"`))
      } else if (span.content && SHOW_CONTENT.has(span.kind)) {
        const pad = `${indent}${depth ? '  ' : ''}  `
        // A model span's input is the whole transcript — the output is what is worth reading.
        if (span.content.input !== undefined && span.kind !== 'llm') {
          lines.push(chalk.dim(`${pad}in:  ${clip(span.content.input, full)}`))
        }
        if (span.content.output !== undefined) {
          lines.push(chalk.dim(`${pad}out: ${clip(span.content.output, full)}`))
        }
      }
      walk(span.spanId, depth + 1)
    }
  }
  walk(null, 0)
  return lines.join('\n')
}

export async function runTracesShow(
  ctx: CommandContext,
  id: string,
  options: TracesShowOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request(
    'GET',
    `/api/traces/${encodeURIComponent(id)}`,
    { schema: traceDetailSchema }
  )
  ctx.out.data(raw, () => {
    const t = data.trace
    const header = [
      `${chalk.bold(t.name)}  ${t.status === 'error' ? chalk.red('error') : chalk.green('ok')}`,
      chalk.dim(
        `trace ${t.traceId} · ${formatDate(t.startedAt)} · ${formatDuration(t.durationMs)} · ` +
          `${t.spanCount} spans · ${t.inputTokens}→${t.outputTokens} tokens` +
          (t.models.length ? ` · ${t.models.join(', ')}` : '')
      ),
    ]
    if (t.runId) header.push(chalk.dim(`run ${t.runId}`))
    if (t.traceUrl) header.push(`${chalk.dim('open:')} ${t.traceUrl}`)
    return [...header, '', renderTraceTree(data, options)].join('\n')
  })
}

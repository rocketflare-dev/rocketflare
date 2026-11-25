/**
 * `rocketflare agents list|run|runs list` — start agent runs from a terminal.
 *
 * `run <key> --input x.json` is one run (`POST /api/agents/runs`); `run <key> --batch x.jsonl` is
 * one run per line (`POST /api/agents/runs/batch`), sent in chunks of `AGENT_RUN_BATCH_MAX` — so a
 * file of a thousand questions is ten requests, each with its own batch id. A batch only takes a
 * NON-exclusive agent (`agents list` says which). Inputs that did not start are listed by line and
 * the command exits 1, after everything that could start has. `runs list --batch <id>` follows one
 * batch.
 */
import { readFile } from 'node:fs/promises'
import { agentRunTimelineSchema } from '@rocketflare/shared/ai/agent-timeline'
import {
  AGENT_RUN_BATCH_MAX,
  type AgentRunBatchItem,
  agentListResponseSchema,
  agentRunSchema,
  type CreateAgentRunBatchResponse,
  createAgentRunBatchResponseSchema,
  createAgentRunResponseSchema,
} from '@rocketflare/shared/ai/agents'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import { formatDate, formatPagination, renderTable } from '../utils/output'

const agentRunListResponseSchema = paginatedResponse(agentRunSchema)

export async function runAgentsList(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/agents', {
    schema: agentListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Key', value: a => a.key },
      { header: 'Title', value: a => a.title },
      {
        header: 'Batch',
        value: a => (a.exclusive ? 'no — exclusive' : 'yes'),
        style: (text, a) => (a.exclusive ? chalk.dim(text) : text),
      },
    ])
  )
}

export interface AgentsRunOptions {
  /** A JSON file holding ONE input. */
  input?: string
  /** A JSONL file, one input per line. */
  batch?: string
}

export async function runAgentsRun(
  ctx: CommandContext,
  agentKey: string,
  options: AgentsRunOptions
): Promise<void> {
  if (Boolean(options.input) === Boolean(options.batch)) {
    throw new CliError('Give exactly one of --input <file.json> or --batch <file.jsonl>')
  }
  if (options.input) return runOne(ctx, agentKey, await readJsonFile(options.input))
  return runBatch(ctx, agentKey, await readJsonLines(options.batch as string))
}

async function runOne(ctx: CommandContext, agentKey: string, input: unknown): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('POST', '/api/agents/runs', {
    schema: createAgentRunResponseSchema,
    body: { agentKey, input },
  })
  ctx.out.data(raw, () =>
    renderTable(
      [data],
      [
        { header: 'Run', value: r => r.id },
        { header: 'Agent', value: r => r.agentKey },
        { header: 'Status', value: r => r.status },
      ]
    )
  )
  if (data.deduplicated) {
    ctx.log.hint(`${agentKey} is exclusive and already had a run going — this is that run.`)
  }
}

async function runBatch(
  ctx: CommandContext,
  agentKey: string,
  lines: { line: number; input: unknown }[]
): Promise<void> {
  if (lines.length === 0) throw new CliError('The batch file has no inputs')
  const client = requireClient(ctx)
  const responses: unknown[] = []
  const rows: { line: number; item: AgentRunBatchItem; batchId: string }[] = []
  for (let start = 0; start < lines.length; start += AGENT_RUN_BATCH_MAX) {
    const chunk = lines.slice(start, start + AGENT_RUN_BATCH_MAX)
    const { data, raw } = await client.request('POST', '/api/agents/runs/batch', {
      schema: createAgentRunBatchResponseSchema,
      body: { agentKey, inputs: chunk.map(l => l.input) },
    })
    responses.push(raw)
    for (const item of (data as CreateAgentRunBatchResponse).items) {
      rows.push({ line: chunk[item.index]?.line ?? 0, item, batchId: data.batchId })
    }
  }
  ctx.out.data(responses, () =>
    renderTable(rows, [
      { header: 'Line', value: r => r.line },
      { header: 'Run', value: r => r.item.run?.id ?? '' },
      {
        header: 'Status',
        value: r => r.item.error?.code ?? r.item.run?.status ?? '',
        style: (text, r) => (r.item.error ? chalk.red(text) : text),
      },
      { header: 'Batch', value: r => r.batchId },
    ])
  )
  const failed = rows.filter(r => r.item.error)
  if (!ctx.json) {
    const batches = [...new Set(rows.map(r => r.batchId))]
    ctx.log.hint(`Follow it: ${ctx.binName} agents runs list --batch ${batches[0]}`)
  }
  if (failed.length > 0) {
    throw new CliError(`${failed.length} of ${rows.length} inputs did not start`, {
      hint: `Lines ${failed.map(r => r.line).join(', ')}: ${failed[0]?.item.error?.message ?? ''}`,
    })
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  const text = await readText(path)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CliError(`${path} is not valid JSON`, { cause: error })
  }
}

/** One JSON value per non-blank line, each remembered by its 1-based line number. */
async function readJsonLines(path: string): Promise<{ line: number; input: unknown }[]> {
  const out: { line: number; input: unknown }[] = []
  for (const [i, raw] of (await readText(path)).split('\n').entries()) {
    if (!raw.trim()) continue
    try {
      out.push({ line: i + 1, input: JSON.parse(raw) })
    } catch (error) {
      throw new CliError(`${path}:${i + 1} is not valid JSON`, { cause: error })
    }
  }
  return out
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new CliError(`Cannot read ${path}`, { cause: error })
  }
}

export interface AgentRunsListOptions {
  agent?: string
  status?: string
  batch?: string
  /** One run's children (`ctx.spawn`); without it, children are left out. */
  parent?: string
  /** Runs created at or after this ISO date or time. */
  since?: string
  /** Runs recorded under this `meta.version`. */
  agentVersion?: number
  page?: number
  pageSize?: number
}

export async function runAgentRunsList(
  ctx: CommandContext,
  options: AgentRunsListOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/agents/runs', {
    schema: agentRunListResponseSchema,
    query: {
      agentKey: options.agent,
      status: options.status,
      batchId: options.batch,
      parentRunId: options.parent,
      since: options.since,
      agentVersion: options.agentVersion,
      page: options.page,
      pageSize: options.pageSize,
    },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Created', value: r => formatDate(r.createdAt) },
      { header: 'Run', value: r => r.id },
      { header: 'Agent', value: r => r.agentKey },
      { header: 'v', value: r => String(r.agentVersion) },
      {
        header: 'Status',
        value: r => r.status,
        style: (text, r) => (r.status === 'failed' ? chalk.red(text) : text),
      },
      { header: 'Error', value: r => (r.error ? r.error.slice(0, 60) : '') },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`

/**
 * `agents inspect <runId>` — the run's timeline (`GET /api/agents/runs/:id/timeline`): every
 * record it left, by time, with its versions, its children and its spend against its budget.
 */
export async function runAgentsInspect(ctx: CommandContext, runId: string): Promise<void> {
  if (!runId) throw new CliError('Give the run id: rocketflare agents inspect <runId>')
  const { data, raw } = await requireClient(ctx).request(
    'GET',
    `/api/agents/runs/${encodeURIComponent(runId)}/timeline`,
    { schema: agentRunTimelineSchema }
  )
  ctx.out.data(raw, () => {
    const { run, versions, spend, children, entries } = data
    const status = run.status === 'failed' ? chalk.red(run.status) : run.status
    const moved =
      versions.currentAgentVersion !== null &&
      versions.currentAgentVersion !== versions.agentVersion
        ? chalk.yellow(` (deployed: v${versions.currentAgentVersion})`)
        : ''
    const lines = [
      `${chalk.bold(run.agentKey)} ${run.id}  ${status}  attempt ${run.attempt}`,
      `version v${versions.agentVersion}${moved}  worker ${versions.workerVersionId ?? '—'}${
        run.parentRunId ? `  parent ${run.parentRunId}` : ''
      }`,
      `spend ${spend.own.tokens} tokens ${usd(spend.own.costUsd)} in ${spend.own.calls} calls` +
        (children.length
          ? `; with children ${spend.tree.tokens} tokens ${usd(spend.tree.costUsd)}`
          : '') +
        (spend.budget.maxTokens !== undefined ? `  / max ${spend.budget.maxTokens} tokens` : '') +
        (spend.budget.maxCostUsd !== undefined ? `  / max ${usd(spend.budget.maxCostUsd)}` : ''),
    ]
    if (run.error) lines.push(chalk.red(`error: ${run.error}`))
    lines.push('')
    const start = entries[0]?.at.getTime() ?? 0
    lines.push(
      renderTable(entries, [
        { header: '+s', value: e => ((e.at.getTime() - start) / 1000).toFixed(1) },
        { header: 'Kind', value: e => e.kind, style: text => chalk.dim(text) },
        { header: 'What', value: e => e.label },
        { header: 'Ref', value: e => e.ref ?? '' },
      ])
    )
    return lines.join('\n')
  })
}

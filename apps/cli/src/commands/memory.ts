/**
 * `rocketflare memory` — YOUR memory in the active tenant (D36): what the assistant learned from
 * your chats (`GET /api/memory`), and forgetting it (`DELETE /api/memory/:id`, `DELETE
 * /api/memory`). The key's own person only — a private memory is never readable by anyone else,
 * admins included — and 404 `feature_disabled` where the organisation has no memory.
 */
import { memoryForgetResponseSchema, memoryListResponseSchema } from '@rocketflare/shared/ai/memory'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import { formatDate, formatPagination, renderTable } from '../utils/output'

export interface MemoryListOptions {
  q?: string
  history?: boolean
  page?: number
  pageSize?: number
}

export async function runMemoryList(
  ctx: CommandContext,
  options: MemoryListOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/memory', {
    schema: memoryListResponseSchema,
    query: {
      q: options.q,
      includeHistorical: options.history ? 'true' : undefined,
      page: options.page,
      pageSize: options.pageSize,
    },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Said', value: m => formatDate(m.mentionedAt) },
      {
        header: 'Fact',
        value: m => (m.invalidatedAt ? chalk.dim(`${m.text} (replaced)`) : m.text),
      },
      { header: 'About', value: m => (m.occurredStart ? formatDate(m.occurredStart) : '') },
      { header: 'Names', value: m => m.entities.map(e => e.name).join(', ') },
      { header: 'Id', value: m => m.id },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

export interface MemoryForgetOptions {
  all?: boolean
}

export async function runMemoryForget(
  ctx: CommandContext,
  id: string | undefined,
  options: MemoryForgetOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  if (options.all) {
    const { data, raw } = await client.request('DELETE', '/api/memory', {
      schema: memoryForgetResponseSchema,
    })
    ctx.out.data(raw, () => `Forgot ${data.deleted} memories.`)
    return
  }
  if (!id) {
    throw new CliError('Pass a memory id, or --all to forget everything.', {
      hint: `List them with \`${ctx.binName} memory list\`.`,
    })
  }
  await client.request('DELETE', `/api/memory/${encodeURIComponent(id)}`)
  ctx.out.data({ id, forgotten: true }, () => `Forgot ${id}.`)
}

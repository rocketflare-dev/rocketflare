/**
 * `rocketflare docs list|search|ingest|retry` — the knowledge base from a terminal, over
 * `/api/ai/documents` with the same shared schemas the web UI parses.
 *
 * - `list [--status]` — `GET /` (paginated, newest first; only what the key's user may see).
 * - `search <query> [--limit] [--document]` — `POST /search`: the same hybrid search chat uses.
 * - `ingest <file> [--title] [--source]` — `POST /ingest` with the file's TEXT (UTF-8, up to
 *   `INGEST_TEXT_MAX_CHARS`); tenant-wide, as an ingest that names no groups is. A PDF or Word file
 *   goes through the web upload, which converts it; this command refuses one rather than sending
 *   its bytes as text.
 * - `retry <id>` — `POST /:id/retry` for a `failed` document (owner or admin+).
 */
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  documentSchema,
  INGEST_TEXT_MAX_CHARS,
  ingestDocumentResponseSchema,
  retryDocumentResponseSchema,
  SEARCH_MAX_LIMIT,
  searchResponseSchema,
} from '@rocketflare/shared/ai/embeddings'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import { formatDate, formatPagination, neutralise, renderTable } from '../utils/output'

const documentListSchema = paginatedResponse(documentSchema)

const STATUSES = ['pending', 'indexed', 'failed'] as const
export type DocumentStatusOption = (typeof STATUSES)[number]

/** Text a terminal user can mean: anything else goes through the web upload, which converts it. */
const TEXT_EXTENSIONS = new Set([
  '',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.html',
  '.htm',
  '.xml',
  '.log',
])

export interface DocsListOptions {
  status?: string
  page?: number
  pageSize?: number
}

export async function runDocsList(
  ctx: CommandContext,
  options: DocsListOptions = {}
): Promise<void> {
  if (options.status && !STATUSES.includes(options.status as DocumentStatusOption)) {
    throw new CliError(`--status must be one of ${STATUSES.join(', ')}`)
  }
  const { data, raw } = await requireClient(ctx).request('GET', '/api/ai/documents', {
    schema: documentListSchema,
    query: { status: options.status, page: options.page, pageSize: options.pageSize },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Added', value: d => formatDate(d.createdAt) },
      { header: 'Title', value: d => d.title.slice(0, 60) },
      {
        header: 'Status',
        value: d => d.status,
        style: (text, d) =>
          d.status === 'failed'
            ? chalk.red(text)
            : d.status === 'pending'
              ? chalk.yellow(text)
              : text,
      },
      { header: 'Passages', value: d => String(d.chunkCount) },
      { header: 'Shared', value: d => (d.visibility === 'tenant' ? 'everyone' : 'groups') },
      { header: 'Id', value: d => d.id },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
  if (!ctx.json && data.items.some(d => d.status === 'failed')) {
    ctx.log.hint(`Retry a failed one: ${ctx.binName} docs retry <id>`)
  }
}

export interface DocsSearchOptions {
  limit?: number
  document?: string
}

export async function runDocsSearch(
  ctx: CommandContext,
  query: string,
  options: DocsSearchOptions = {}
): Promise<void> {
  const q = query.trim()
  if (!q) throw new CliError('Give a query to search for')
  if (options.limit !== undefined && options.limit > SEARCH_MAX_LIMIT) {
    throw new CliError(`--limit is at most ${SEARCH_MAX_LIMIT}`)
  }
  const { data, raw } = await requireClient(ctx).request('POST', '/api/ai/documents/search', {
    schema: searchResponseSchema,
    body: {
      query: q,
      ...(options.limit ? { limit: options.limit } : {}),
      ...(options.document ? { documentId: options.document } : {}),
    },
  })
  if (ctx.json) {
    ctx.out.data(raw, () => '')
    return
  }
  if (data.hits.length === 0) {
    ctx.out.text('No passages matched.')
    return
  }
  for (const hit of data.hits) {
    const where = [`passage ${hit.seq + 1} of ${hit.documentPassages}`, hit.headingPath]
      .filter(Boolean)
      .map(s => neutralise(String(s)))
      .join(' · ')
    ctx.out.text(`${chalk.bold(`${hit.rank}. ${neutralise(hit.title)}`)}  ${chalk.dim(where)}`)
    ctx.out.text(`   ${neutralise(hit.text.replace(/\s+/g, ' ').slice(0, 280))}`)
    ctx.out.text(chalk.dim(`   ${hit.documentId}`))
  }
  if (data.lexical === 'no_terms') {
    ctx.log.hint(
      'Every word of the query is too common to match on; only meaning-based search ran.'
    )
  }
}

export interface DocsIngestOptions {
  title?: string
  source?: string
}

export async function runDocsIngest(
  ctx: CommandContext,
  path: string,
  options: DocsIngestOptions = {}
): Promise<void> {
  if (!path) throw new CliError('Give the path of a text file to ingest')
  const ext = extname(path).toLowerCase()
  if (!TEXT_EXTENSIONS.has(ext)) {
    throw new CliError(`${path} is not a text file`, {
      hint: 'Upload PDFs, Word and other files in the web app — it converts them first.',
    })
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new CliError(`Cannot read ${path}`, { cause: error })
  }
  if (!text.trim()) throw new CliError(`${path} is empty`)
  if (text.length > INGEST_TEXT_MAX_CHARS) {
    throw new CliError(
      `${path} is ${text.length.toLocaleString()} characters; the most one ingest takes is ${INGEST_TEXT_MAX_CHARS.toLocaleString()}`
    )
  }
  const title = (options.title ?? basename(path, extname(path))).trim().slice(0, 200)
  const { data, raw } = await requireClient(ctx).request('POST', '/api/ai/documents/ingest', {
    schema: ingestDocumentResponseSchema,
    body: { title, text, ...(options.source ? { source: options.source } : {}) },
  })
  ctx.out.data(raw, () =>
    data.deduplicated
      ? `Already in the knowledge base as "${neutralise(data.title)}" (${data.id}).`
      : `Added "${neutralise(data.title)}" (${data.id}) — ${data.status === 'indexed' ? `${data.chunkCount} passage(s), searchable now` : 'indexing in the background'}.`
  )
}

export async function runDocsRetry(ctx: CommandContext, id: string): Promise<void> {
  if (!id) throw new CliError('Give the id of the failed document')
  const { data, raw } = await requireClient(ctx).request(
    'POST',
    `/api/ai/documents/${encodeURIComponent(id)}/retry`,
    { schema: retryDocumentResponseSchema }
  )
  ctx.out.data(raw, () => `Retrying "${neutralise(data.title)}" — it is ${data.status} again.`)
}

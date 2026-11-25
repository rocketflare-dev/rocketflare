/**
 * Contextual chunk prefixes (#148 — Anthropic's "Contextual Retrieval"). A passage cut out of its
 * document loses what it is about: "The fee rises to £300 from April" names neither the customer
 * nor the service. For a tenant with the `knowledge-context` flag, the `document.contextualize`
 * job asks a model, passage by passage, for one or two sentences placing it in its document, stores
 * them in `chunks.context`, and re-embeds the passage with them in front (`storedEmbeddingInput`);
 * the keyword index (`chunks.search_vector`, generated) reads the column too. The stored passage
 * text, its offsets and everything a reader is shown stay exactly as they were.
 *
 * - **When.** After an index whose TEXT changed (`afterTextIndexed`), and by the backfill
 *   (`enqueueContextualizeBackfill`). A re-index of unchanged text keeps the contexts
 *   (`indexDocument`), so a re-embed never pays twice.
 * - **The call.** The document (or, past `CONTEXT_WINDOW_CHARS`, the window its passage falls in)
 *   is the STABLE system prompt, so Anthropic caches it and every passage after the first reads it
 *   at the cache rate; the passage is the user turn. The first passage of each window runs alone
 *   (it writes the cache), the rest `CONTEXT_CONCURRENCY` at a time.
 * - **Untrusted text.** The document is a tenant's own text and may contain instructions. The
 *   prompt says to ignore them, the answer is cut to `SITUATING_CONTEXT_MAX_CHARS` with control
 *   characters stripped, and it is only ever a retrieval aid: never shown as the passage, never
 *   quoted, never read by another document's processing.
 * - **Progress is durable.** Each window's passages are written as soon as they are embedded, and
 *   only passages with no context are asked about, so a retried job resumes where it stopped. A
 *   row is updated only while the document still has the text the job read and the row still
 *   holds the same passage.
 * - **Cost.** Every call is a `knowledge.context` `ai_usage` row (cache reads and writes kept),
 *   the re-embed `knowledge.embeddings`. The daily knowledge cap pauses the job for the next UTC day
 *   (`knowledgeExtractionAllowed`) — before each document, never mid-document.
 *
 * Reached lazily from `ingest.ts` (`afterTextIndexed`), like knowledge-fact extraction, so the
 * module `@/plugins/api` loads gains no static path to the feature registry.
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import { KNOWLEDGE_USAGE_FEATURES } from '@rocketflare/shared/ai/usage'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { chunks, documents } from '../../../db/schema'
import { activeSpan, traceEmbed, traceStep } from '../../observability/context'
import type { Tracer } from '../../observability/tracer'
import { traceChatClient, withAgentTrace } from '../../observability/tracing'
import type { Logger } from '../../utils/core/logger'
import { stripControlChars } from '../../utils/core/text'
import { type AccessScope, visibleDocuments } from '../access'
import { tenantFeatures } from '../features'
import { enqueueJob, enqueueJobs, type JobsQueue } from '../jobs'
import { resolvePrompt } from '../prompts'
import { SITUATING_CONTEXT_MAX_CHARS, storedEmbeddingInput } from './chunking'
import { AiNotConfiguredError } from './errors'
import { embedInBatches } from './ingest'
import {
  type ResolvedChat,
  type ResolvedEmbeddings,
  resolveChat,
  resolveEmbeddings,
} from './resolve'
import type { AiEnv, ChatClient } from './types'
import {
  embedCounted,
  knowledgeExtractionAllowed,
  recordKnowledgeUsage,
  recordUsage,
  secondsUntilNextUtcDay,
} from './usage'

export const KNOWLEDGE_CONTEXT_FEATURE = 'knowledge-context'
/** The most document text one call is shown (~12 000 tokens); a longer document is windowed. */
export const CONTEXT_WINDOW_CHARS = 48_000
/** How far a window reaches back before its segment, so a passage near a seam keeps its lead-in. */
const WINDOW_LEAD_CHARS = 4_000
/** Calls in flight per window once the first has written the cache. */
export const CONTEXT_CONCURRENCY = 4
/** Room for "one or two sentences"; a longer answer is cut to `SITUATING_CONTEXT_MAX_CHARS`. */
const CONTEXT_MAX_TOKENS = 200

export interface ContextualizeInput {
  tenantId: string
  documentId: string
  contentHash?: string
}

export interface ContextualizeDeps {
  jobs?: JobsQueue | null
  tracer?: Tracer
  logger?: Pick<Logger, 'info' | 'warn'>
  now?: () => Date
}

export type ContextualizeStatus = 'contextualized' | 'skipped' | 'paused'

export interface ContextualizeReport {
  status: ContextualizeStatus
  reason?:
    | 'document_missing'
    | 'not_indexed'
    | 'content_changed'
    | 'feature_off'
    | 'no_chat_model'
    | 'nothing_to_do'
    | 'daily_cap'
  /** Passages that had no context when the job started. */
  pending: number
  /** Passages given a context and re-embedded. */
  written: number
  /** Passages the model answered with nothing usable (left without a context). */
  empty: number
  model?: string
  delaySeconds?: number
}

const report = (
  status: ContextualizeStatus,
  reason?: ContextualizeReport['reason']
): ContextualizeReport => ({ status, reason, pending: 0, written: 0, empty: 0 })

/**
 * The window of document text a passage starting at `charStart` is situated against: the whole
 * document when it fits, else the `CONTEXT_WINDOW_CHARS` segment it falls in plus a short lead-in.
 * Passages of one segment share a window, so they share the provider's prompt cache.
 */
export function contextWindow(
  content: string,
  charStart: number
): { key: number; start: number; end: number } {
  if (content.length <= CONTEXT_WINDOW_CHARS) return { key: 0, start: 0, end: content.length }
  const span = CONTEXT_WINDOW_CHARS - WINDOW_LEAD_CHARS
  const key = Math.floor(Math.max(0, charStart) / span)
  const start = Math.max(0, key * span - WINDOW_LEAD_CHARS)
  return { key, start, end: Math.min(content.length, start + CONTEXT_WINDOW_CHARS) }
}

/** What a model answered, as a stored context: plain, one paragraph, bounded; '' = nothing. */
export function cleanContext(text: string): string {
  return stripControlChars(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
    .slice(0, SITUATING_CONTEXT_MAX_CHARS)
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** `document.contextualize`: situate every passage of one document that has no context yet. */
export async function contextualizeDocument(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  input: ContextualizeInput,
  deps: ContextualizeDeps = {}
): Promise<ContextualizeReport> {
  const run = () => runContextualize(db, cfg, env, input, deps)
  const describe = (r: ContextualizeReport) => ({
    output: { status: r.status, reason: r.reason, pending: r.pending, written: r.written },
  })
  if (activeSpan() || !deps.tracer) {
    return traceStep(
      { name: 'knowledge context', kind: 'span', input: { documentId: input.documentId } },
      run,
      describe
    )
  }
  return withAgentTrace(
    'knowledge.context',
    {
      tracer: deps.tracer,
      tenantId: input.tenantId,
      kind: 'job',
      spanName: 'invoke_workflow knowledge.context',
      metadata: { documentId: input.documentId },
    },
    async () => run()
  )
}

interface PendingChunk {
  id: string
  seq: number
  text: string
  headingPath: string | null
  tableHeader: string | null
  charStart: number | null
}

async function runContextualize(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  input: ContextualizeInput,
  deps: ContextualizeDeps
): Promise<ContextualizeReport> {
  const { tenantId, documentId } = input
  const now = deps.now?.() ?? new Date()
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)),
  })
  if (!doc) return report('skipped', 'document_missing')
  if (doc.status !== 'indexed' || doc.content === null) return report('skipped', 'not_indexed')
  if (input.contentHash && doc.contentHash !== input.contentHash) {
    return report('skipped', 'content_changed')
  }
  if (!(await tenantFeatures(db, cfg, tenantId)).includes(KNOWLEDGE_CONTEXT_FEATURE)) {
    return report('skipped', 'feature_off')
  }
  const pending: PendingChunk[] = await db
    .select({
      id: chunks.id,
      seq: chunks.seq,
      text: chunks.text,
      headingPath: chunks.headingPath,
      tableHeader: chunks.tableHeader,
      charStart: chunks.charStart,
    })
    .from(chunks)
    .where(
      and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, documentId), isNull(chunks.context))
    )
    .orderBy(asc(chunks.seq))
  if (pending.length === 0) return report('skipped', 'nothing_to_do')
  if (!(await knowledgeExtractionAllowed(db, cfg, tenantId, now))) {
    const delaySeconds = secondsUntilNextUtcDay(now)
    await enqueueJob(
      deps.jobs,
      {
        type: 'document.contextualize',
        payload: { tenantId, documentId, contentHash: doc.contentHash ?? undefined },
      },
      { delaySeconds }
    )
    deps.logger?.info({ tenantId, documentId, delaySeconds }, 'document.contextualize: daily cap')
    return { ...report('paused', 'daily_cap'), pending: pending.length, delaySeconds }
  }

  let chat: ResolvedChat
  try {
    chat = await resolveChat(db, cfg, env, tenantId, { promptKey: 'knowledge-context' })
  } catch (err) {
    if (err instanceof AiNotConfiguredError) return report('skipped', 'no_chat_model')
    throw err
  }
  // No embedder is the 503 an index would have hit too: let the queue retry it.
  const embeddings = await resolveEmbeddings(db, cfg, env, tenantId)
  const tenant = await db.query.tenants.findFirst({ where: (t, { eq }) => eq(t.id, tenantId) })
  const instructions = await resolvePrompt(db, tenantId, 'knowledge-context', {
    appName: cfg.APP_NAME,
    tenantName: tenant?.name ?? '',
  })

  const out: ContextualizeReport = {
    ...report('contextualized'),
    pending: pending.length,
    model: chat.model,
  }
  const content = doc.content
  const windows = new Map<number, { start: number; end: number; items: PendingChunk[] }>()
  for (const c of pending) {
    const w = contextWindow(content, c.charStart ?? 0)
    const entry = windows.get(w.key) ?? { start: w.start, end: w.end, items: [] }
    entry.items.push(c)
    windows.set(w.key, entry)
  }
  const title = stripControlChars(doc.title).slice(0, 200)
  for (const window of windows.values()) {
    const excerpt = content.slice(window.start, window.end)
    const partial = window.start > 0 || window.end < content.length
    const system = {
      stable: `${instructions}\n\n<document title="${title.replace(/"/g, "'")}"${partial ? ' excerpt="true"' : ''}>\n${excerpt}\n</document>`,
    }
    const ask = (c: PendingChunk) =>
      situate(db, chat, system, c, { tenantId, userId: doc.ownerUserId })
    const [first, ...rest] = window.items
    const answers = first
      ? [await ask(first), ...(await mapLimited(rest, CONTEXT_CONCURRENCY, ask))]
      : []
    const written = await writeWindow(db, embeddings, {
      tenantId,
      documentId,
      contentHash: doc.contentHash,
      userId: doc.ownerUserId,
      model: chat.model,
      items: window.items.map((c, i) => ({ chunk: c, context: answers[i] ?? '' })),
    })
    out.written += written.written
    out.empty += written.empty
  }
  return out
}

/** One passage's context ('' when the model said nothing usable). Records the call's usage. */
async function situate(
  db: Database,
  chat: ResolvedChat,
  system: { stable: string },
  chunk: PendingChunk,
  who: { tenantId: string; userId: string | null }
): Promise<string> {
  const parent = activeSpan()
  const client: ChatClient = parent
    ? traceChatClient(chat.client, parent, { provider: chat.provider })
    : chat.client
  const result = await client.complete({
    model: chat.model,
    system,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `<passage>\n${chunk.text}\n</passage>` }],
      },
    ],
    maxTokens: Math.min(CONTEXT_MAX_TOKENS, chat.maxOutputTokens),
  })
  await recordContextUsage(db, who, chat, result.usage)
  const text = result.content.map(b => (b.type === 'text' ? b.text : '')).join(' ')
  return cleanContext(text)
}

/**
 * Embed one window's passages with their new contexts and write both, in one transaction, only
 * while the document still has the text the job read and each row still holds the same passage.
 */
async function writeWindow(
  db: Database,
  embeddings: ResolvedEmbeddings,
  input: {
    tenantId: string
    documentId: string
    contentHash: string | null
    userId: string | null
    model: string
    items: { chunk: PendingChunk; context: string }[]
  }
): Promise<{ written: number; empty: number }> {
  const usable = input.items.filter(i => i.context !== '')
  const empty = input.items.length - usable.length
  if (usable.length === 0) return { written: 0, empty }
  let embeddedTokens = 0
  let vectors: number[][]
  try {
    vectors = await embedInBatches(
      texts =>
        traceEmbed(embeddings, texts, async () => {
          const counted = await embedCounted(embeddings.client, texts)
          embeddedTokens += counted.inputTokens
          return counted.vectors
        }),
      usable.map(i => storedEmbeddingInput({ ...i.chunk, context: i.context }))
    )
  } finally {
    if (embeddedTokens > 0) {
      await recordKnowledgeUsage(db, [
        {
          tenantId: input.tenantId,
          userId: input.userId,
          feature: KNOWLEDGE_USAGE_FEATURES.embeddings,
          provider: embeddings.provider,
          model: embeddings.model,
          inputTokens: embeddedTokens,
        },
      ])
    }
  }
  const written = await db.transaction(async tx => {
    const [current] = await tx
      .select({ contentHash: documents.contentHash, status: documents.status })
      .from(documents)
      .where(and(eq(documents.id, input.documentId), eq(documents.tenantId, input.tenantId)))
      .for('update')
    if (current?.status !== 'indexed' || current.contentHash !== input.contentHash) {
      return 0
    }
    let n = 0
    for (const [i, item] of usable.entries()) {
      const updated = await tx
        .update(chunks)
        .set({
          context: item.context,
          contextModel: input.model,
          embedding: vectors[i] as number[],
          embeddingModel: embeddings.model,
        })
        .where(
          and(
            eq(chunks.tenantId, input.tenantId),
            eq(chunks.id, item.chunk.id),
            eq(chunks.text, item.chunk.text),
            isNull(chunks.context)
          )
        )
        .returning({ id: chunks.id })
      n += updated.length
    }
    return n
  })
  return { written, empty }
}

async function recordContextUsage(
  db: Database,
  who: { tenantId: string; userId: string | null },
  chat: ResolvedChat,
  usage: TokenUsage
): Promise<void> {
  try {
    await recordUsage(db, {
      tenantId: who.tenantId,
      userId: who.userId,
      feature: KNOWLEDGE_USAGE_FEATURES.context,
      provider: chat.provider,
      model: chat.model,
      usage,
    })
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'knowledge context usage not recorded',
        tenantId: who.tenantId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      })
    )
  }
}

/**
 * The producer half, after an index whose text changed: enqueue `document.contextualize` when
 * the tenant has the flag. **Never throws** — the document is already indexed and searchable, and
 * a context is an improvement to it, not a condition of it.
 */
export async function enqueueContextualize(
  db: Database,
  cfg: AppConfig,
  jobs: JobsQueue | null | undefined,
  input: { tenantId: string; documentId: string; contentHash: string | null }
): Promise<boolean> {
  try {
    if (!(await tenantFeatures(db, cfg, input.tenantId)).includes(KNOWLEDGE_CONTEXT_FEATURE)) {
      return false
    }
    if (!jobs) {
      console.warn(
        JSON.stringify({
          msg: 'document.contextualize not enqueued: JOBS_QUEUE is not configured',
          tenantId: input.tenantId,
          documentId: input.documentId,
        })
      )
      return false
    }
    await enqueueJob(jobs, {
      type: 'document.contextualize',
      payload: {
        tenantId: input.tenantId,
        documentId: input.documentId,
        contentHash: input.contentHash ?? undefined,
      },
    })
    return true
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'document.contextualize not enqueued',
        tenantId: input.tenantId,
        documentId: input.documentId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      })
    )
    return false
  }
}

/**
 * The indexed documents THIS reader may see with no contextual prefix on any passage — the Search
 * page's "Add context" notice. A document whose model left one passage empty has others, so it is
 * not counted, and the notice can reach 0. Tenant AND visibility, like every read.
 */
export async function countVisibleWithoutContext(
  db: Database,
  scope: AccessScope
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, scope.tenantId),
        eq(documents.status, 'indexed'),
        sql`${documents.content} is not null`,
        visibleDocuments(scope),
        sql`exists (select 1 from ${chunks} c where c.tenant_id = ${scope.tenantId} and c.document_id = ${documents.id})`,
        sql`not exists (select 1 from ${chunks} c where c.tenant_id = ${scope.tenantId} and c.document_id = ${documents.id} and c.context is not null)`
      )
    )
  return Number(row?.n ?? 0)
}

/**
 * The backfill: one job per indexed document of the tenant with a passage that has no context,
 * oldest first, at most `max`. Answers how many were enqueued and how many are left. The caller
 * checks the flag and proves the queue; a send failure throws (the route's 5xx).
 */
export async function enqueueContextualizeBackfill(
  db: Database,
  jobs: JobsQueue,
  tenantId: string,
  max: number
): Promise<{ enqueued: number; remaining: number }> {
  const missing = sql`exists (select 1 from ${chunks} c where c.tenant_id = ${tenantId} and c.document_id = ${documents.id} and c.context is null)`
  const where = and(
    eq(documents.tenantId, tenantId),
    eq(documents.status, 'indexed'),
    sql`${documents.content} is not null`,
    missing
  )
  const [rows, [total]] = await Promise.all([
    db
      .select({ id: documents.id, contentHash: documents.contentHash })
      .from(documents)
      .where(where)
      .orderBy(asc(documents.createdAt))
      .limit(max),
    db.select({ n: sql<number>`count(*)::int` }).from(documents).where(where),
  ])
  if (rows.length > 0) {
    await enqueueJobs(
      jobs,
      rows.map(r => ({
        type: 'document.contextualize' as const,
        payload: { tenantId, documentId: r.id, contentHash: r.contentHash ?? undefined },
      }))
    )
  }
  return { enqueued: rows.length, remaining: Math.max(0, Number(total?.n ?? 0) - rows.length) }
}

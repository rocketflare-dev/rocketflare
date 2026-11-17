/**
 * Keeping a tenant's knowledge base indexed: the health counts, the stale-embeddings re-embed and
 * the retry of a failed document. All three reuse `indexDocument` (or the `document.index` /
 * `document.convert` jobs that call it) — nothing here chunks or embeds on its own.
 *
 * **Stale.** A document's embeddings are stale when it is `indexed`, has stored text, and at least
 * one of its chunks was embedded by a model other than the one `resolveEmbeddingsModel` picks for
 * the tenant today (a null `embedding_model` counts). Dense search filters on the query vector's
 * model, so such a document is still found lexically but is absent from the dense leg until it is
 * re-embedded. `failed` and `pending` documents are not stale: the retry and the running job own
 * them. No embedder at all = nothing is stale (there is no "today's model" to compare with).
 *
 * **Re-embed** (`document.reembed`): one bounded batch per message — at most
 * `REEMBED_BATCH_DOCUMENTS` documents and, past the first, `REEMBED_BATCH_CHUNKS` chunks — then the
 * handler re-enqueues itself while stale documents remain. Each document is rebuilt by
 * `indexDocument(…, { markFailedOnError: false })`: its vectors are computed before the replacing
 * transaction opens, so a failure leaves the old chunks searchable. A provider refusal of the
 * document itself (`invalid_request`) marks that one `failed` and the batch moves on; anything
 * else throws, the consumer retries with backoff and the next attempt resumes where this one
 * stopped (the stale predicate IS the cursor). No claim row: the message names the model it was
 * started for and is acked once the tenant resolves another, and two deliveries re-indexing one
 * document cannot duplicate chunks — the replace is one transaction and `(document_id, seq)` is
 * unique, so the loser fails and is retried.
 */
import type { DocumentsHealth } from '@rocketflare/shared/ai/embeddings'
import { and, asc, count, eq, exists, isNotNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { chunks, type DocumentRow, documents } from '../../../db/schema'
import type { Logger } from '../../utils/core/logger'
import { enqueueJob, type JobsQueue, JobsQueueNotConfiguredError, requireJobsQueue } from '../jobs'
import { normalizeAiError } from './errors'
import { indexDocument, markDocumentFailed } from './ingest'
import { resolveEmbeddings, resolveEmbeddingsModel } from './resolve'
import type { AiEnv } from './types'

/** All this module logs: a warning. Both the job's logger and a route's satisfy it. */
type WarnLogger = Pick<Logger, 'warn'>

/** Documents one `document.reembed` message rebuilds at most. */
export const REEMBED_BATCH_DOCUMENTS = 20
/** Chunks one message embeds at most — past its first document, which always runs. */
export const REEMBED_BATCH_CHUNKS = 400

/** A chunk of this tenant embedded by anything but `model` (null included). */
function staleChunk(tenantId: string, model: string) {
  return and(eq(chunks.tenantId, tenantId), sql`${chunks.embeddingModel} is distinct from ${model}`)
}

/** The documents a re-embed rebuilds: indexed, with text, holding at least one stale chunk. */
function staleDocument(db: Database, tenantId: string, model: string) {
  return and(
    eq(documents.tenantId, tenantId),
    eq(documents.status, 'indexed'),
    isNotNull(documents.content),
    exists(
      db
        .select({ one: sql`1` })
        .from(chunks)
        .where(and(staleChunk(tenantId, model), eq(chunks.documentId, documents.id)))
    )
  )
}

export interface StaleCounts {
  staleEmbeddings: number
  staleChunks: number
}

/** How many documents (and their chunks) are not embedded by `model`. */
export async function countStaleEmbeddings(
  db: Database,
  tenantId: string,
  model: string
): Promise<StaleCounts> {
  const [[docs], [pieces]] = await Promise.all([
    db
      .select({ n: count() })
      .from(documents)
      .where(staleDocument(db, tenantId, model)),
    db
      .select({ n: count() })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(
        and(
          staleChunk(tenantId, model),
          eq(documents.tenantId, tenantId),
          eq(documents.status, 'indexed'),
          isNotNull(documents.content)
        )
      ),
  ])
  return { staleEmbeddings: docs?.n ?? 0, staleChunks: pieces?.n ?? 0 }
}

/** `GET /api/ai/documents/health`: documents by status, today's model and what is stale. */
export async function documentsHealth(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string
): Promise<DocumentsHealth> {
  const [model, byStatus] = await Promise.all([
    resolveEmbeddingsModel(db, cfg, env, tenantId),
    db
      .select({ status: documents.status, n: count() })
      .from(documents)
      .where(eq(documents.tenantId, tenantId))
      .groupBy(documents.status),
  ])
  const counts = { total: 0, pending: 0, indexed: 0, failed: 0 }
  for (const row of byStatus) {
    counts[row.status] = row.n
    counts.total += row.n
  }
  const stale = model
    ? await countStaleEmbeddings(db, tenantId, model)
    : { staleEmbeddings: 0, staleChunks: 0 }
  return { documents: counts, embeddingModel: model, ...stale }
}

/** Start (or continue) a tenant's re-embed toward `model`. */
export function enqueueReembed(
  jobs: JobsQueue | undefined | null,
  tenantId: string,
  model: string
) {
  return enqueueJob(jobs, { type: 'document.reembed', payload: { tenantId, model } })
}

export interface ReembedBatchResult {
  /** `superseded` = the tenant no longer resolves `model`; a newer chain owns the work. */
  status: 'superseded' | 'done' | 'more'
  reembedded: number
  failed: number
}

/** One `document.reembed` message's worth of work. Throws on a transient failure (retry). */
export async function reembedBatch(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  logger: WarnLogger,
  tenantId: string,
  model: string
): Promise<ReembedBatchResult> {
  const current = await resolveEmbeddingsModel(db, cfg, env, tenantId)
  if (current !== model) return { status: 'superseded', reembedded: 0, failed: 0 }
  const embeddings = await resolveEmbeddings(db, cfg, env, tenantId)
  const candidates = await db
    .select({ id: documents.id, chunkCount: documents.chunkCount })
    .from(documents)
    .where(staleDocument(db, tenantId, model))
    .orderBy(asc(documents.createdAt), asc(documents.id))
    .limit(REEMBED_BATCH_DOCUMENTS)

  let reembedded = 0
  let failed = 0
  let budget = 0
  for (const doc of candidates) {
    if (reembedded + failed > 0 && budget + doc.chunkCount > REEMBED_BATCH_CHUNKS) break
    budget += doc.chunkCount
    try {
      await indexDocument(db, cfg, env, tenantId, doc.id, { embeddings, markFailedOnError: false })
      reembedded++
    } catch (err) {
      // The provider refused THIS document (too long, bad input): retrying cannot help, and it
      // must not stall every document after it. Anything else is transient — retry the message.
      if (normalizeAiError(err, embeddings.provider).code !== 'invalid_request') throw err
      await markDocumentFailed(db, tenantId, doc.id, err)
      logger.warn({ tenantId, documentId: doc.id }, 'document.reembed: provider refused document')
      failed++
    }
  }
  const { staleEmbeddings } = await countStaleEmbeddings(db, tenantId, model)
  return { status: staleEmbeddings > 0 ? 'more' : 'done', reembedded, failed }
}

/**
 * After an `ai_configs` write has COMMITTED: if the embeddings model the tenant resolves changed
 * from `before`, and anything is stale against the new one, start a re-embed. Never throws — the
 * config change already happened, and the health endpoint still shows what is stale: a missing
 * `JOBS_QUEUE` (or a failed send) is logged and `POST /api/ai/documents/reembed` is the way back.
 */
export async function reembedAfterEmbeddingsChange(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  logger: WarnLogger,
  jobs: JobsQueue | undefined | null,
  tenantId: string,
  before: string | null
): Promise<'unchanged' | 'nothing_stale' | 'enqueued' | 'not_enqueued'> {
  const after = await resolveEmbeddingsModel(db, cfg, env, tenantId)
  if (!after || after === before) return 'unchanged'
  const { staleEmbeddings } = await countStaleEmbeddings(db, tenantId, after)
  if (staleEmbeddings === 0) return 'nothing_stale'
  try {
    await enqueueReembed(jobs, tenantId, after)
    return 'enqueued'
  } catch (err) {
    logger.warn(
      {
        tenantId,
        model: after,
        staleEmbeddings,
        reason: err instanceof JobsQueueNotConfiguredError ? 'no_jobs_queue' : String(err),
      },
      'ai-config: embeddings model changed but the re-embed could not be enqueued'
    )
    return 'not_enqueued'
  }
}

export interface RetryResult {
  document: DocumentRow
  job: 'document.convert' | 'document.index'
}

/**
 * Put a `failed` document back on the queue: no text yet (an upload whose conversion failed) →
 * `document.convert`, text → `document.index`. The flip to `pending` is a compare-and-set on
 * `status = 'failed'`, so a double click enqueues once; null = it was not failed. The queue is
 * proved BEFORE the write, and a send that throws puts the row back as it was.
 */
export async function retryFailedDocument(
  db: Database,
  jobs: JobsQueue | undefined | null,
  row: DocumentRow
): Promise<RetryResult | null> {
  const queue = requireJobsQueue(jobs)
  const tenantId = row.tenantId
  if (!tenantId) throw new Error(`documents: ${row.id} is a platform document`)
  const job = row.content === null ? 'document.convert' : 'document.index'
  const where = and(eq(documents.id, row.id), eq(documents.tenantId, tenantId))
  const [pending] = await db
    .update(documents)
    .set({ status: 'pending', error: null })
    .where(and(where, eq(documents.status, 'failed')))
    .returning()
  if (!pending) return null
  try {
    await enqueueJob(queue, { type: job, payload: { tenantId, documentId: row.id } })
  } catch (err) {
    await db
      .update(documents)
      .set({ status: 'failed', error: row.error })
      .where(and(where, eq(documents.status, 'pending')))
    throw err
  }
  return { document: pending, job }
}

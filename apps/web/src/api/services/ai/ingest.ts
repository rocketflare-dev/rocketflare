/**
 * The ONE ingest path (D18, 00 §1.3 — retrieval must ship with a way to put text in): `ingestText`
 * writes a `documents` row (`pending`, raw `content`), chunks it, and either indexes INLINE (≤
 * `INLINE_CHUNK_LIMIT` chunks — one embeddings call or two, well inside a request) or enqueues a
 * `document.index` job that calls the same `indexDocument`. Indexing = `resolveEmbeddings` →
 * embed in batches of `EMBED_BATCH_SIZE` → replace the document's chunks → `indexed` (with
 * `chunkCount`/`embeddingModel`) or `failed` with a redacted error. Both paths re-read the text
 * from the row, never from a message. Missing `JOBS_QUEUE` for a large document throws
 * `JobsQueueNotConfiguredError` — never a silent inline fallback (D7).
 */
import type { Document } from '@gmgo/shared/ai/embeddings'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { chunks, type DocumentRow, documents } from '../../../db/schema'
import { enqueueJob, type JobsQueue } from '../jobs'
import { chunkText, type TextChunk } from './chunking'
import { normalizeAiError, redactSecrets } from './errors'
import { type ResolvedEmbeddings, resolveEmbeddings } from './resolve'
import type { AiEnv } from './types'

/** Documents with more chunks than this are indexed by the `document.index` job. */
export const INLINE_CHUNK_LIMIT = 50
/** Texts per embeddings request. */
export const EMBED_BATCH_SIZE = 32

export interface IngestTextInput {
  tenantId: string
  userId: string | null
  title: string
  text: string
  source?: string | null
  contentType?: string
}

export interface IngestDeps {
  /** `env.JOBS_QUEUE` — required only when the text exceeds the inline limit. */
  jobs?: JobsQueue | null
}

export function toDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerUserId: row.ownerUserId,
    title: row.title,
    source: row.source,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    chunkCount: row.chunkCount,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Embed `texts` in batches so a large document never sends one oversized request. */
export async function embedInBatches(
  embed: (texts: string[]) => Promise<number[][]>,
  texts: string[],
  batchSize = EMBED_BATCH_SIZE
): Promise<number[][]> {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const vectors = await embed(texts.slice(i, i + batchSize))
    if (vectors.length !== Math.min(batchSize, texts.length - i)) {
      throw new Error('Embeddings provider returned the wrong number of vectors')
    }
    out.push(...vectors)
  }
  return out
}

/**
 * (Re)index one document from its stored `content`: chunk → embed → replace chunks → `indexed`.
 * Idempotent (existing chunks are deleted first). A provider failure marks the row `failed` and
 * RETHROWS so a queue consumer retries; the route path catches and reports the row instead.
 */
export async function indexDocument(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  documentId: string,
  options: { chunks?: TextChunk[]; embeddings?: ResolvedEmbeddings } = {}
): Promise<DocumentRow> {
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)),
  })
  if (!row) throw new Error(`documents: ${documentId} not found in tenant`)
  const pieces = options.chunks ?? chunkText(row.content ?? '')
  try {
    const embeddings = options.embeddings ?? (await resolveEmbeddings(db, cfg, env, tenantId))
    const vectors = await embedInBatches(
      texts => embeddings.client.embed(texts),
      pieces.map(p => p.text)
    )
    const [updated] = await db.transaction(async tx => {
      await tx
        .delete(chunks)
        .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, documentId)))
      if (pieces.length > 0) {
        await tx.insert(chunks).values(
          pieces.map((p, i) => ({
            documentId,
            tenantId,
            seq: p.seq,
            text: p.text,
            tokenCount: p.tokenCount,
            embedding: vectors[i] as number[],
          }))
        )
      }
      return tx
        .update(documents)
        .set({
          status: 'indexed',
          chunkCount: pieces.length,
          embeddingModel: embeddings.model,
          error: null,
        })
        .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
        .returning()
    })
    if (!updated) throw new Error('documents: update returned no row')
    return updated
  } catch (err) {
    const message = redactSecrets(
      err instanceof Error ? normalizeAiError(err, 'openai').message : String(err)
    )
    await db
      .update(documents)
      .set({ status: 'failed', error: message.slice(0, 500) })
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
      .catch(() => {})
    throw err
  }
}

export interface IngestResult {
  document: DocumentRow
  /** `inline` = indexed in this call; `queued` = a `document.index` job will. */
  mode: 'inline' | 'queued'
}

/**
 * Store text as a document and index it. Inline when small; otherwise the `documents` row is
 * returned `pending` and a `document.index` job finishes it. The embeddings client is resolved
 * BEFORE any write (no provider → 503 `ai_not_configured`, no orphan row); an inline provider
 * failure after that returns the `failed` row (with `error`) rather than throwing — the document
 * exists and says why.
 */
export async function ingestText(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  input: IngestTextInput,
  deps: IngestDeps = {}
): Promise<IngestResult> {
  const pieces = chunkText(input.text)
  const embeddings = await resolveEmbeddings(db, cfg, env, input.tenantId)
  const [row] = await db
    .insert(documents)
    .values({
      tenantId: input.tenantId,
      ownerUserId: input.userId,
      title: input.title,
      source: input.source ?? null,
      contentType: input.contentType ?? 'text/plain',
      sizeBytes: new TextEncoder().encode(input.text).byteLength,
      content: input.text,
      status: 'pending',
    })
    .returning()
  if (!row) throw new Error('documents: insert returned no row')

  if (pieces.length > INLINE_CHUNK_LIMIT) {
    await enqueueJob(deps.jobs, {
      type: 'document.index',
      payload: { tenantId: input.tenantId, documentId: row.id },
    })
    return { document: row, mode: 'queued' }
  }
  try {
    const document = await indexDocument(db, cfg, env, input.tenantId, row.id, {
      chunks: pieces,
      embeddings,
    })
    return { document, mode: 'inline' }
  } catch {
    const failed = await db.query.documents.findFirst({
      where: and(eq(documents.id, row.id), eq(documents.tenantId, input.tenantId)),
    })
    return { document: failed ?? row, mode: 'inline' }
  }
}

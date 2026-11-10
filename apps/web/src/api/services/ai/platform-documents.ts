/**
 * PLATFORM documents — knowledge about the app itself (a plugin's user guide), stored in the
 * ordinary `documents` / `chunks` tables with `tenant_id` NULL. Three properties make them safe to
 * share with every tenant:
 *
 * - **Written by the owner connection only.** RLS gives the app role a SELECT policy for a null
 *   tenant (`platformReadable`) and nothing else; `tenantIsolation`'s `WITH CHECK` refuses a
 *   null-tenant write. The functions here run from a job or a cron task (`@/plugins/api`'s
 *   `ingestPlatformDocument` accepts nothing else), never from a request.
 * - **Always embedded, by the PLATFORM embedder** (`resolvePlatformEmbeddings`), so a query from
 *   any tenant is compared against vectors of one model. No embedder → `PlatformEmbeddingsError`
 *   BEFORE anything is written; the chunks are embedded before the transaction opens, so a
 *   provider failure leaves the previous revision intact. A platform chunk without a vector is
 *   impossible by construction (and `chunks.embedding` is `NOT NULL` besides).
 * - **Read only when asked for by source.** Every tenant-facing document view keeps its
 *   `tenant_id = $t` predicate; only `searchChunks`' `platformSources` reaches these rows.
 *
 * Identity is `(source, externalId)` (`documents_platform_source_external_uq`): the same pair with
 * the same title and text, already indexed by today's platform model, is a no-op — so a cron that
 * re-syncs a whole guide costs one read per page and no embeddings call.
 */
import { INGEST_TEXT_MAX_CHARS } from '@rocketflare/shared/ai/embeddings'
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { chunks, documents } from '../../../db/schema'
import { traceEmbed } from '../../observability/context'
import { BadRequestError, ServiceUnavailableError } from '../../utils/core/errors'
import { stripControlChars } from '../../utils/core/text'
import { chunkText } from './chunking'
import type { FetchLike } from './client'
import { embedInBatches } from './ingest'
import { resolvePlatformEmbeddings } from './resolve'
import type { AiEnv } from './types'

/** 503 `platform_embeddings_not_configured`: no `EMBEDDINGS_API_KEY` and no `[ai]` binding. */
export class PlatformEmbeddingsError extends ServiceUnavailableError {
  constructor() {
    super(
      'Platform documents need a platform embeddings provider: set EMBEDDINGS_API_KEY or the [ai] binding',
      'platform_embeddings_not_configured'
    )
    this.name = 'PlatformEmbeddingsError'
  }
}

export interface PlatformDocumentInput {
  source: string
  externalId: string
  title: string
  text: string
}

export interface PlatformDocumentResult {
  documentId: string
  /** `unchanged` = same title and text, already embedded by today's platform model: nothing written. */
  status: 'created' | 'updated' | 'unchanged'
  chunkCount: number
}

/** Upsert one platform document and its chunks, embedded synchronously. See the module comment. */
export async function ingestPlatformText(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  input: PlatformDocumentInput,
  options: { fetch?: FetchLike } = {}
): Promise<PlatformDocumentResult> {
  const externalId = input.externalId.trim()
  const title = input.title.trim()
  const text = stripControlChars(input.text)
  if (!externalId) throw new BadRequestError('externalId is required', 'invalid_external_id')
  if (!title) throw new BadRequestError('title is required', 'invalid_title')
  if (!text.trim()) throw new BadRequestError('text is empty', 'empty_document')
  if (text.length > INGEST_TEXT_MAX_CHARS) {
    throw new BadRequestError(
      `text is ${text.length} characters; the limit is ${INGEST_TEXT_MAX_CHARS}`,
      'document_too_large'
    )
  }
  const embeddings = resolvePlatformEmbeddings(cfg, env, options)
  if (!embeddings) throw new PlatformEmbeddingsError()

  const [existing] = await db
    .select({
      id: documents.id,
      title: documents.title,
      content: documents.content,
      embeddingModel: documents.embeddingModel,
      status: documents.status,
      chunkCount: documents.chunkCount,
    })
    .from(documents)
    .where(
      and(
        isNull(documents.tenantId),
        eq(documents.source, input.source),
        eq(documents.externalId, externalId)
      )
    )
  if (
    existing &&
    existing.status === 'indexed' &&
    existing.title === title &&
    existing.content === text &&
    existing.embeddingModel === embeddings.model
  ) {
    return { documentId: existing.id, status: 'unchanged', chunkCount: existing.chunkCount }
  }

  // Embed BEFORE any write: a provider failure throws with nothing changed.
  const pieces = chunkText(text)
  const vectors = await embedInBatches(
    texts => traceEmbed(embeddings, texts, () => embeddings.client.embed(texts)),
    pieces.map(p => p.text)
  )

  const values = {
    tenantId: null,
    ownerUserId: null,
    title,
    source: input.source,
    externalId,
    contentType: 'text/markdown',
    sizeBytes: new TextEncoder().encode(text).byteLength,
    content: text,
    fileId: null,
    chunkCount: pieces.length,
    embeddingModel: embeddings.model,
    status: 'indexed' as const,
    error: null,
  }
  const documentId = await db.transaction(async tx => {
    const [row] = await tx
      .insert(documents)
      .values(values)
      .onConflictDoUpdate({
        target: [documents.source, documents.externalId],
        targetWhere: sql`${documents.tenantId} is null`,
        set: {
          title: values.title,
          contentType: values.contentType,
          sizeBytes: values.sizeBytes,
          content: values.content,
          chunkCount: values.chunkCount,
          embeddingModel: values.embeddingModel,
          status: values.status,
          error: null,
        },
      })
      .returning({ id: documents.id })
    if (!row) throw new Error('documents: platform upsert returned no row')
    await tx.delete(chunks).where(and(isNull(chunks.tenantId), eq(chunks.documentId, row.id)))
    if (pieces.length > 0) {
      await tx.insert(chunks).values(
        pieces.map((p, i) => ({
          documentId: row.id,
          tenantId: null,
          seq: p.seq,
          text: stripControlChars(p.text),
          tokenCount: p.tokenCount,
          embedding: vectors[i] as number[],
        }))
      )
    }
    return row.id
  })
  return { documentId, status: existing ? 'updated' : 'created', chunkCount: pieces.length }
}

/**
 * Delete the platform documents of `source` whose `externalId` is NOT in `keepExternalIds` (a page
 * removed from the guide). Chunks cascade. Answers how many documents were deleted. An empty keep
 * list deletes the whole source.
 */
export async function prunePlatformText(
  db: Database,
  input: { source: string; keepExternalIds: readonly string[] }
): Promise<number> {
  const keep = [...new Set(input.keepExternalIds)]
  const deleted = await db
    .delete(documents)
    .where(
      and(
        isNull(documents.tenantId),
        eq(documents.source, input.source),
        keep.length > 0 ? notInArray(documents.externalId, keep) : undefined
      )
    )
    .returning({ id: documents.id })
  return deleted.length
}

/**
 * The ingest paths (D18, 00 §1.3 — retrieval must ship with a way to put text in). Two entry
 * points, one insertion + indexing path:
 *
 * - `ingestText` — pasted text: write a `documents` row (`pending`, raw `content`), chunk it, then
 *   `indexOrEnqueue`: index INLINE when ≤ `INLINE_CHUNK_LIMIT` chunks (one embeddings call or
 *   two, well inside a request) or enqueue a `document.index` job that calls the same
 *   `indexDocument`.
 * - `ingestFile` — an upload: store the original in R2 as a `files` row (scope `documents`), write
 *   the `documents` row with `fileId` and the ORIGINAL `contentType`; text-like types are decoded
 *   here and follow `indexOrEnqueue` like pasted text, binary types are left `content: null` and a
 *   `document.convert` job runs `convertAndIndexDocument` (Workers AI `toMarkdown` → the same
 *   `indexDocument`).
 *
 * Indexing = `resolveEmbeddings` → embed in batches of `EMBED_BATCH_SIZE` → replace the document's
 * chunks → `indexed` (with `chunkCount`/`embeddingModel`) or `failed` with a redacted error. Both
 * paths re-read the text from the row, never from a message. Everything that can 503 (no
 * embeddings provider, no converter for a binary type) is checked BEFORE any byte or row is
 * written — no orphans. A missing `JOBS_QUEUE` throws `JobsQueueNotConfiguredError` — never a
 * silent inline fallback (D7).
 */
import {
  type Document,
  type DocumentUploadType,
  INGEST_TEXT_MAX_CHARS,
  resolveDocumentUploadType,
} from '@rocketflare/shared/ai/embeddings'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { chunks, type DocumentRow, documents, files } from '../../../db/schema'
import { enqueueJob, type JobsQueue } from '../jobs'
import { deleteStoredFile, type StorageService, storeUploadedFile } from '../storage'
import { chunkText, type TextChunk } from './chunking'
import { ConversionFailedError, canConvert, convertToText, decodeText } from './convert'
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

/** Thrown by `ingestFile` for a binary upload on a Worker whose `AI` binding cannot convert. */
export class ConversionNotConfiguredError extends Error {
  constructor() {
    super(
      'Document conversion is not configured: binary uploads need the `[ai]` binding (Workers AI Markdown Conversion)'
    )
    this.name = 'ConversionNotConfiguredError'
  }
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
    fileId: row.fileId,
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

/** Record why a document could not be indexed (redacted, bounded). Never throws. */
async function markFailed(
  db: Database,
  tenantId: string,
  documentId: string,
  err: unknown
): Promise<void> {
  const message = redactSecrets(
    err instanceof Error ? normalizeAiError(err, 'openai').message : String(err)
  )
  await db
    .update(documents)
    .set({ status: 'failed', error: message.slice(0, 500) })
    .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
    .catch(() => {})
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
    await markFailed(db, tenantId, documentId, err)
    throw err
  }
}

export interface IngestResult {
  document: DocumentRow
  /** `inline` = indexed in this call; `queued` = a `document.index` / `document.convert` job will. */
  mode: 'inline' | 'queued'
}

/**
 * The shared decision after a `pending` row exists and its text is known: index now when small,
 * else hand it to the `document.index` job. An inline provider failure after the row exists
 * returns the `failed` row (with `error`) rather than throwing — the document exists and says why.
 */
async function indexOrEnqueue(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  row: DocumentRow,
  pieces: TextChunk[],
  embeddings: ResolvedEmbeddings,
  deps: IngestDeps
): Promise<IngestResult> {
  if (pieces.length > INLINE_CHUNK_LIMIT) {
    await enqueueJob(deps.jobs, {
      type: 'document.index',
      payload: { tenantId: row.tenantId, documentId: row.id },
    })
    return { document: row, mode: 'queued' }
  }
  try {
    const document = await indexDocument(db, cfg, env, row.tenantId, row.id, {
      chunks: pieces,
      embeddings,
    })
    return { document, mode: 'inline' }
  } catch {
    const failed = await db.query.documents.findFirst({
      where: and(eq(documents.id, row.id), eq(documents.tenantId, row.tenantId)),
    })
    return { document: failed ?? row, mode: 'inline' }
  }
}

/**
 * Store text as a document and index it. Inline when small; otherwise the `documents` row is
 * returned `pending` and a `document.index` job finishes it. The embeddings client is resolved
 * BEFORE any write (no provider → 503 `ai_not_configured`, no orphan row).
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
  return indexOrEnqueue(db, cfg, env, row, pieces, embeddings, deps)
}

// ---- Uploads -----------------------------------------------------------------------------------

export interface IngestFileInput {
  tenantId: string
  userId: string
  /** The multipart part (a Blob carries the length R2 needs). */
  file: Blob
  /** The client's filename — the storage key, the default title and the default source derive from it. */
  filename: string
  /** Resolved by `resolveDocumentUploadType` at the route (415 before this is called). */
  type: DocumentUploadType
  title?: string | null
  source?: string | null
}

export interface IngestFileDeps extends IngestDeps {
  /** `createR2Storage(env.FILES)` — the route answers 503 `storage_not_configured` without it. */
  storage: StorageService
}

/** `report.pdf` → `report`; a bare extension or empty name → `Untitled`. */
export function titleFromFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim()
  return stem.length > 0 ? stem.slice(0, 200) : 'Untitled'
}

/** Thrown when a decoded or converted text is longer than the ingest cap. */
function tooLong(chars: number): ConversionFailedError {
  return new ConversionFailedError(
    `Converted text is ${chars.toLocaleString()} characters; the limit is ${INGEST_TEXT_MAX_CHARS.toLocaleString()}`
  )
}

/**
 * Store an uploaded file and index it. Order: resolve embeddings and check the converter (both can
 * 503 — nothing written yet) → object + `files` row → `documents` row (`pending`, `fileId`, the
 * original media type). Text-like types are decoded now and follow `ingestText`'s inline/queued
 * decision; binary types return `pending` and a `document.convert` job converts + indexes them.
 * The `files` row and object are rolled back if the `documents` row cannot be written.
 */
export async function ingestFile(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  input: IngestFileInput,
  deps: IngestFileDeps
): Promise<IngestResult> {
  const embeddings = await resolveEmbeddings(db, cfg, env, input.tenantId)
  if (input.type.kind === 'convert' && !canConvert(env)) throw new ConversionNotConfiguredError()

  const stored = await storeUploadedFile(db, deps.storage, {
    tenantId: input.tenantId,
    ownerUserId: input.userId,
    scope: 'documents',
    file: input.file,
    filename: input.filename,
    contentType: input.type.contentType,
  })

  let text: string | null = null
  let pieces: TextChunk[] = []
  if (input.type.kind === 'text') {
    text = await decodeText(input.file)
    pieces = chunkText(text)
  }

  let row: DocumentRow | undefined
  try {
    ;[row] = await db
      .insert(documents)
      .values({
        tenantId: input.tenantId,
        ownerUserId: input.userId,
        title: input.title?.trim() || titleFromFilename(input.filename),
        source: input.source?.trim() || stored.filename,
        contentType: input.type.contentType,
        sizeBytes: input.file.size,
        content: text,
        fileId: stored.id,
        status: 'pending',
      })
      .returning()
    if (!row) throw new Error('documents: insert returned no row')
  } catch (err) {
    await deleteStoredFile(db, deps.storage, stored).catch(() => {})
    throw err
  }

  if (input.type.kind === 'convert') {
    await enqueueJob(deps.jobs, {
      type: 'document.convert',
      payload: { tenantId: input.tenantId, documentId: row.id },
    })
    return { document: row, mode: 'queued' }
  }
  if ((text ?? '').length > INGEST_TEXT_MAX_CHARS) {
    await markFailed(db, input.tenantId, row.id, tooLong((text ?? '').length))
    const failed = await db.query.documents.findFirst({
      where: and(eq(documents.id, row.id), eq(documents.tenantId, input.tenantId)),
    })
    return { document: failed ?? row, mode: 'inline' }
  }
  return indexOrEnqueue(db, cfg, env, row, pieces, embeddings, deps)
}

/**
 * The `document.convert` job body: read the original from R2, convert it to text, store the text
 * on the row and run `indexDocument`. `ConversionFailedError` (permanent: the platform refused the
 * file, the text is over the cap, the original is gone) marks the row `failed` and is rethrown for
 * the handler to ACK; anything else (binding outage, provider error) marks it `failed` and is
 * rethrown for a retry.
 */
export async function convertAndIndexDocument(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  storage: StorageService,
  tenantId: string,
  documentId: string
): Promise<DocumentRow> {
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)),
  })
  if (!row) throw new Error(`documents: ${documentId} not found in tenant`)
  try {
    if (!row.fileId)
      throw new ConversionFailedError('This document has no uploaded file to convert')
    const file = await db.query.files.findFirst({
      where: and(eq(files.id, row.fileId), eq(files.tenantId, tenantId)),
    })
    const object = file ? await storage.get(file.key) : null
    if (!file || !object)
      throw new ConversionFailedError('The uploaded file is no longer in storage')
    const type = resolveDocumentUploadType(file.filename, row.contentType)
    if (!type) throw new ConversionFailedError(`Unsupported media type ${row.contentType}`)

    const blob = new Blob([await new Response(object.body).arrayBuffer()], {
      type: type.contentType,
    })
    const { text } = await convertToText(env, {
      name: file.filename,
      blob,
      contentType: type.contentType,
    })
    if (text.length > INGEST_TEXT_MAX_CHARS) throw tooLong(text.length)
    await db
      .update(documents)
      .set({ content: text })
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
  } catch (err) {
    await markFailed(db, tenantId, documentId, err)
    throw err
  }
  return indexDocument(db, cfg, env, tenantId, documentId)
}

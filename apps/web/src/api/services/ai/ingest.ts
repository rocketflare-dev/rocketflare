/**
 * The ingest paths (retrieval must ship with a way to put text in). Two entry
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
 * Indexing = `resolveEmbeddings` → embed in batches of `EMBED_BATCH_SIZE` (each chunk's
 * `embeddingInput`: heading path + table header + text) → replace the document's chunks (each with
 * its offsets, heading path and `embeddingModel`) → `indexed` (with `chunkCount`/`embeddingModel`/
 * `contentHash`) or `failed` with a redacted error. Both
 * paths re-read the text from the row, never from a message. Everything that can 503 (no
 * embeddings provider, no converter for a binary type) is checked BEFORE any byte or row is
 * written — no orphans. A missing `JOBS_QUEUE` throws `JobsQueueNotConfiguredError` — never a
 * silent inline fallback.
 *
 * **Content hash.** Stored text is normalised (control characters stripped, CRLF → LF) and
 * hashed (`contentHash`, sha-256 over the trimmed text). An external-id upsert whose hash, status
 * and chunk model all still match is `unchanged`: no chunking, no embedding, no chunk delete —
 * only the row's metadata and grants follow the source. A plain ingest (no external id) whose
 * hash matches a document of the same tenant and source answers that document
 * (`deduplicated: true`) — only between two TENANT-wide documents, so a dedupe can never hand
 * back, or reveal, a document restricted to groups the caller may not be in.
 */
import {
  type Document,
  type DocumentUploadType,
  INGEST_TEXT_MAX_CHARS,
  resolveDocumentUploadType,
} from '@rocketflare/shared/ai/embeddings'
import { KNOWLEDGE_USAGE_FEATURES } from '@rocketflare/shared/ai/usage'
import type { GroupRef, ResourceVisibility } from '@rocketflare/shared/groups'
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import {
  chunks,
  type DocumentOrigin,
  type DocumentRow,
  documentGroups,
  documents,
  files,
} from '../../../db/schema'
import { activeSpan, traceEmbed, traceStep } from '../../observability/context'
import type { Tracer } from '../../observability/tracer'
import { withAgentTrace } from '../../observability/tracing'
import { stripControlChars } from '../../utils/core/text'
import { enqueueJob, type JobsQueue } from '../jobs'
import { deleteDocumentsWithFacts } from '../knowledge/remove'
import {
  deleteStoredFile,
  type StorageService,
  sanitizeFilename,
  storeUploadedFile,
} from '../storage'
import {
  chunkText,
  embeddingInput,
  headingPathLabel,
  normalizeLineEndings,
  type TextChunk,
} from './chunking'
import { ConversionFailedError, canConvert, convertToText, decodeText } from './convert'
import { normalizeAiError, redactSecrets } from './errors'
import { type ResolvedEmbeddings, resolveEmbeddings } from './resolve'
import type { AiEnv } from './types'
import { embedCounted, recordKnowledgeUsage } from './usage'

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
  /**
   * Who may read it. Defaults to `tenant`: a document an AGENT writes, or an ingest that
   * says nothing, belongs to the organisation rather than inheriting anything. `groupIds` must
   * already have been validated against the tenant (`resolveRequestedVisibility` at the route).
   */
  visibility?: ResourceVisibility
  groupIds?: readonly string[]
  /**
   * The item's id in `source`. With one, an existing row for `(tenantId, source, externalId)`
   * is UPDATED and re-indexed rather than a second row added — how a connector re-syncs an edited
   * message or file. Requires `source`.
   */
  externalId?: string | null
  /**
   * `integration` when a plugin syncs it (`@/plugins/api` `ingestDocument` sets it): the facts read
   * from it are weaker evidence (D43). Default `upload`.
   */
  origin?: DocumentOrigin
  /** Who reviews the doubtful facts read from it — the person who connected the integration. */
  reviewerUserId?: string | null
}

export interface IngestDeps {
  /** `env.JOBS_QUEUE` — required only when the text exceeds the inline limit. */
  jobs?: JobsQueue | null
  /** R2 — only to remove an original that an external-id re-ingest replaced. */
  storage?: StorageService | null
  /**
   * The request's tracer (`withAuth(c).tracer`). INLINE indexing is one `ingest document` span —
   * under the active span when there is one (an agent run, a job), else a trace of its own on this
   * tracer — so its embeddings batches nest under something. Absent and nothing active = untraced.
   */
  tracer?: Tracer
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

/**
 * The tenant a document row belongs to. A PLATFORM row (`tenant_id` null) is never a tenant's
 * document, so reaching one here is a missing `tenant_id = $t` predicate upstream — fail loudly
 * rather than hand a platform document to a tenant view.
 */
export function documentTenantId(row: Pick<DocumentRow, 'id' | 'tenantId'>): string {
  if (!row.tenantId) throw new Error(`documents: ${row.id} is a platform document, not a tenant's`)
  return row.tenantId
}

/** `groups` comes from `grantsForResources` — the row alone cannot know it. */
export function toDocument(row: DocumentRow, groups: GroupRef[] = []): Document {
  return {
    id: row.id,
    tenantId: documentTenantId(row),
    ownerUserId: row.ownerUserId,
    title: row.title,
    source: row.source,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    fileId: row.fileId,
    chunkCount: row.chunkCount,
    status: row.status,
    error: row.error,
    visibility: row.visibility,
    groups,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * The text a document is stored as: control characters stripped (Postgres refuses a NUL), line
 * endings normalised, so `documents.content` is exactly what was chunked and every chunk's
 * `charStart`/`charEnd` indexes into it.
 */
export function normalizeDocumentText(text: string): string {
  return normalizeLineEndings(stripControlChars(text))
}

/** sha-256 (lowercase hex) of the normalised text: CRLF → LF, then trimmed. Web Crypto only. */
export async function contentHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeLineEndings(text).trim())
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
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
export async function markDocumentFailed(
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
 * `markFailedOnError: false` (the re-embed job) leaves the row and its old chunks exactly as they
 * were on a failure — every vector is computed before the replacing transaction opens, so a
 * failed re-embed never costs a document the search it still had.
 */
export async function indexDocument(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  documentId: string,
  options: {
    chunks?: TextChunk[]
    embeddings?: ResolvedEmbeddings
    markFailedOnError?: boolean
  } = {}
): Promise<DocumentRow> {
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)),
  })
  if (!row) throw new Error(`documents: ${documentId} not found in tenant`)
  const pieces = options.chunks ?? chunkText(row.content ?? '')
  // Tokens the provider was sent, batch by batch — recorded as `knowledge.embeddings` whether the
  // index then succeeds or not (a batch that answered was billed).
  let embeddedTokens = 0
  let embedder: ResolvedEmbeddings | undefined
  try {
    const hash = await contentHash(row.content ?? '')
    const embeddings = options.embeddings ?? (await resolveEmbeddings(db, cfg, env, tenantId))
    embedder = embeddings
    const vectors = await embedInBatches(
      // One `embeddings <model>` span per batch, under the active span (an agent run, the
      // `document.index` job) — untraced where nothing is active.
      texts =>
        traceEmbed(embeddings, texts, async () => {
          const counted = await embedCounted(embeddings.client, texts)
          embeddedTokens += counted.inputTokens
          return counted.vectors
        }),
      pieces.map(p => embeddingInput(p))
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
            // A row written before the strip existed may still hold a NUL; never let it fail here.
            text: stripControlChars(p.text),
            tokenCount: p.tokenCount,
            embedding: vectors[i] as number[],
            embeddingModel: embeddings.model,
            headingPath: headingPathLabel(p.headingPath),
            tableHeader: p.tableHeader,
            page: p.page,
            charStart: p.charStart,
            charEnd: p.charEnd,
          }))
        )
      }
      return tx
        .update(documents)
        .set({
          status: 'indexed',
          chunkCount: pieces.length,
          embeddingModel: embeddings.model,
          contentHash: hash,
          error: null,
        })
        .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
        .returning()
    })
    if (!updated) throw new Error('documents: update returned no row')
    return updated
  } catch (err) {
    if (options.markFailedOnError !== false) await markDocumentFailed(db, tenantId, documentId, err)
    throw err
  } finally {
    // Never fails the index: `recordKnowledgeUsage` logs and swallows a ledger failure.
    if (embedder && embeddedTokens > 0) {
      await recordKnowledgeUsage(db, [
        {
          tenantId,
          userId: row.ownerUserId,
          feature: KNOWLEDGE_USAGE_FEATURES.embeddings,
          provider: embedder.provider,
          model: embedder.model,
          inputTokens: embeddedTokens,
        },
      ])
    }
  }
}

/**
 * Grants for a freshly inserted document. Written after the row rather than inside it because the
 * junction has an FK to it; a `tenant` document has no grants, so this is a no-op for most rows.
 */
async function grantDocumentGroups(
  db: Database,
  tenantId: string,
  row: DocumentRow,
  groupIds: readonly string[] | undefined,
  options: { replace?: boolean } = {}
): Promise<void> {
  // An external-id re-ingest REPLACES the grants: stale rows would silently keep sharing a
  // document with a group the source no longer shares it with.
  if (options.replace) {
    await db
      .delete(documentGroups)
      .where(and(eq(documentGroups.tenantId, tenantId), eq(documentGroups.documentId, row.id)))
  }
  if (row.visibility !== 'groups' || !groupIds || groupIds.length === 0) return
  await db
    .insert(documentGroups)
    .values(
      [...new Set(groupIds)].map(groupId => ({
        tenantId,
        documentId: row.id,
        groupId,
      }))
    )
    .onConflictDoNothing()
}

export interface IngestResult {
  document: DocumentRow
  /**
   * `inline` = indexed in this call; `queued` = a `document.index` / `document.convert` job will;
   * `unchanged` = the text was already indexed (an upsert with the same hash, or a dedupe) and
   * nothing was chunked or embedded.
   */
  mode: 'inline' | 'queued' | 'unchanged'
  /** A plain ingest answered an EXISTING document with the same text instead of creating one. */
  deduplicated: boolean
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
  tenantId: string,
  row: DocumentRow,
  pieces: TextChunk[],
  embeddings: ResolvedEmbeddings,
  deps: IngestDeps,
  textChanged: boolean
): Promise<IngestResult> {
  if (pieces.length > INLINE_CHUNK_LIMIT) {
    await enqueueJob(deps.jobs, {
      type: 'document.index',
      payload: {
        tenantId,
        documentId: row.id,
        ...(textChanged ? {} : { skipExtraction: true }),
      },
    })
    return { document: row, mode: 'queued', deduplicated: false }
  }
  try {
    const document = await traceInlineIndex(deps.tracer, tenantId, row, pieces.length, () =>
      indexDocument(db, cfg, env, tenantId, row.id, { chunks: pieces, embeddings })
    )
    if (textChanged) await afterTextIndexed(db, cfg, deps.jobs, document)
    return { document, mode: 'inline', deduplicated: false }
  } catch {
    const failed = await db.query.documents.findFirst({
      where: and(eq(documents.id, row.id), eq(documents.tenantId, tenantId)),
    })
    return { document: failed ?? row, mode: 'inline', deduplicated: false }
  }
}

/**
 * Enqueue knowledge-fact extraction (D43) for a document whose TEXT just changed and indexed —
 * never after a re-embed, an unchanged upsert or a dedupe. The module is loaded at call time so
 * this file, which `@/plugins/api` reaches, gets no static path to the plugin barrel; it never
 * throws (`services/knowledge/enqueue.ts`).
 */
export async function afterTextIndexed(
  db: Database,
  cfg: AppConfig,
  jobs: JobsQueue | null | undefined,
  document: Pick<DocumentRow, 'id' | 'tenantId' | 'status' | 'contentHash'>
): Promise<void> {
  if (document.status !== 'indexed' || !document.tenantId) return
  const { enqueueKnowledgeExtraction } = await import('../knowledge/enqueue')
  await enqueueKnowledgeExtraction(db, cfg, jobs, {
    tenantId: document.tenantId,
    documentId: document.id,
    contentHash: document.contentHash,
  })
}

/**
 * The inline index as ONE span, so its `embeddings <model>` batches nest: a child of the active
 * span when there is one (`traceStep` — an agent run's ingest tool, a job), else the root of a
 * trace on the request's tracer (`withAgentTrace`). Untraced with neither.
 */
async function traceInlineIndex(
  tracer: Tracer | undefined,
  tenantId: string,
  row: DocumentRow,
  chunkCount: number,
  fn: () => Promise<DocumentRow>
): Promise<DocumentRow> {
  const name = 'ingest document'
  const input = { documentId: row.id, chunks: chunkCount }
  // The span's output is the outcome, never the row — the row carries the document's text.
  const outcome = (indexed: DocumentRow) => ({
    status: indexed.status,
    chunkCount: indexed.chunkCount,
  })
  if (activeSpan() || !tracer) {
    return traceStep({ name, kind: 'span', input }, fn, indexed => ({ output: outcome(indexed) }))
  }
  let indexed: DocumentRow | undefined
  await withAgentTrace(
    'document.ingest',
    {
      tracer,
      tenantId,
      userId: row.ownerUserId ?? undefined,
      kind: 'span',
      spanName: name,
      input,
      metadata: { documentId: row.id },
    },
    async () => {
      indexed = await fn()
      return outcome(indexed)
    }
  )
  if (!indexed) throw new Error('documents: inline index returned no row')
  return indexed
}

/**
 * A plain ingest's duplicate: a document of this tenant with the same `source` (null matches
 * null) and hash that is not `failed`. Only between TENANT-wide documents — answering a restricted
 * one would reveal a document the caller may not be able to read.
 */
async function findDuplicate(
  db: Database,
  tenantId: string,
  source: string | null,
  hash: string,
  visibility: ResourceVisibility
): Promise<DocumentRow | undefined> {
  if (visibility !== 'tenant') return undefined
  const [row] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        source === null ? isNull(documents.source) : eq(documents.source, source),
        eq(documents.contentHash, hash),
        eq(documents.visibility, 'tenant'),
        ne(documents.status, 'failed')
      )
    )
    .orderBy(asc(documents.createdAt))
    .limit(1)
  return row
}

/**
 * Is an external-id upsert a no-op for the TEXT? Same hash, `indexed`, and every chunk embedded by
 * the model that would embed it now. (Phase 2's extraction will be skipped on this path too.)
 */
async function isUnchanged(
  db: Database,
  tenantId: string,
  previous: DocumentRow | undefined,
  hash: string,
  model: string
): Promise<boolean> {
  if (previous?.status !== 'indexed' || previous.contentHash !== hash) return false
  const [stale] = await db
    .select({ id: chunks.id })
    .from(chunks)
    .where(
      and(
        eq(chunks.tenantId, tenantId),
        eq(chunks.documentId, previous.id),
        sql`${chunks.embeddingModel} is distinct from ${model}`
      )
    )
    .limit(1)
  return !stale
}

/**
 * The unchanged upsert: the text and chunks stay; the metadata the source owns (title, owner,
 * visibility, its grants) still follows it — a source that stops sharing an item must not be
 * ignored because the text did not change.
 */
async function touchUnchanged(
  db: Database,
  tenantId: string,
  previous: DocumentRow,
  values: Pick<DocumentRow, 'title' | 'ownerUserId' | 'visibility' | 'contentType'> &
    Partial<Pick<DocumentRow, 'reviewerUserId'>>,
  groupIds: readonly string[] | undefined
): Promise<DocumentRow> {
  return db.transaction(async tx => {
    const [row] = await tx
      .update(documents)
      // Named, not spread: a caller's wider `values` (content, status…) must never reach the row.
      .set({
        title: values.title,
        ownerUserId: values.ownerUserId,
        visibility: values.visibility,
        contentType: values.contentType,
        ...(values.reviewerUserId !== undefined ? { reviewerUserId: values.reviewerUserId } : {}),
      })
      .where(and(eq(documents.id, previous.id), eq(documents.tenantId, tenantId)))
      .returning()
    const updated = row ?? previous
    await grantDocumentGroups(tx, tenantId, updated, groupIds, { replace: true })
    return updated
  })
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
  const text = normalizeDocumentText(input.text)
  const embeddings = await resolveEmbeddings(db, cfg, env, input.tenantId)
  const hash = await contentHash(text)
  const values = {
    tenantId: input.tenantId,
    ownerUserId: input.userId,
    title: input.title,
    source: input.source ?? null,
    contentType: input.contentType ?? 'text/plain',
    sizeBytes: new TextEncoder().encode(text).byteLength,
    content: text,
    contentHash: hash,
    fileId: null,
    status: 'pending' as const,
    visibility: input.visibility ?? 'tenant',
    origin: input.origin ?? 'upload',
    reviewerUserId: input.reviewerUserId ?? null,
  }
  const external = externalKey(input)
  const previous = external ? await findExternal(db, input.tenantId, external) : undefined
  // A re-sync of an item that USED to be a file takes the full path below, which sheds the file.
  if (
    previous &&
    !previous.fileId &&
    (await isUnchanged(db, input.tenantId, previous, hash, embeddings.model))
  ) {
    const document = await touchUnchanged(db, input.tenantId, previous, values, input.groupIds)
    return { document, mode: 'unchanged', deduplicated: false }
  }
  if (!external) {
    const duplicate = await findDuplicate(
      db,
      input.tenantId,
      values.source,
      hash,
      values.visibility
    )
    if (duplicate) return { document: duplicate, mode: 'unchanged', deduplicated: true }
  }
  const pieces = chunkText(text)
  const row = external
    ? await upsertExternal(
        db,
        input.tenantId,
        { ...values, externalId: external.externalId },
        input.groupIds
      )
    : (await db.insert(documents).values(values).returning())[0]
  if (!row) throw new Error('documents: insert returned no row')
  if (!external) await grantDocumentGroups(db, input.tenantId, row, input.groupIds)
  // A re-sync of an item that USED to be a file and is now text leaves its old object behind.
  if (previous?.fileId && deps.storage)
    await dropStoredFile(db, deps.storage, input.tenantId, previous.fileId)
  // Same text, re-indexed only because its chunks are another model's: no new facts to read.
  const textChanged = previous?.contentHash !== hash
  return indexOrEnqueue(db, cfg, env, input.tenantId, row, pieces, embeddings, deps, textChanged)
}

// ---- External ids ----------------------------------------------------------------------

interface ExternalKey {
  source: string
  externalId: string
}

function externalKey(input: {
  source?: string | null
  externalId?: string | null
}): ExternalKey | null {
  if (!input.externalId) return null
  const source = input.source?.trim()
  if (!source) throw new Error('documents: an externalId needs a source to be unique within')
  return { source, externalId: input.externalId }
}

async function findExternal(
  db: Database,
  tenantId: string,
  key: ExternalKey
): Promise<DocumentRow | undefined> {
  return db.query.documents.findFirst({
    where: and(
      eq(documents.tenantId, tenantId),
      eq(documents.source, key.source),
      eq(documents.externalId, key.externalId)
    ),
  })
}

/**
 * Insert, or overwrite the row this `(tenant, source, externalId)` already has — ONE statement, so
 * two syncs of the same item racing each other converge on one row rather than failing on the
 * unique index. `ownerUserId`, visibility and the text all move: the source is the truth.
 */
async function upsertExternal(
  db: Database,
  tenantId: string,
  values: typeof documents.$inferInsert & { externalId: string },
  groupIds: readonly string[] | undefined
): Promise<DocumentRow | undefined> {
  const { tenantId: _t, source: _s, externalId: _e, ...update } = values
  // Text, grants and searchable copy change as one: a re-index that is pending or fails must not
  // leave the replaced revision's chunks readable under the new row's visibility.
  return db.transaction(async tx => {
    const [row] = await tx
      .insert(documents)
      .values(values)
      .onConflictDoUpdate({
        target: [documents.tenantId, documents.source, documents.externalId],
        targetWhere: sql`${documents.externalId} is not null`,
        set: { ...update, chunkCount: 0, embeddingModel: null, error: null },
      })
      .returning()
    if (!row) return undefined
    await tx.delete(chunks).where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, row.id)))
    await grantDocumentGroups(tx, tenantId, row, groupIds, { replace: true })
    return row
  })
}

/** Best-effort removal of a replaced original — the new row no longer points at it. */
async function dropStoredFile(
  db: Database,
  storage: StorageService,
  tenantId: string,
  fileId: string
) {
  const file = await db.query.files.findFirst({
    where: and(eq(files.id, fileId), eq(files.tenantId, tenantId)),
  })
  if (file) await deleteStoredFile(db, storage, file).catch(() => {})
}

/**
 * Delete what a source once ingested under `externalId` — the connector saw the item deleted
 * upstream. Its facts go first, undoing what they did to other facts (`deleteDocumentsWithFacts`);
 * chunks and grants cascade from the row; the uploaded original, if any, is removed from
 * storage too. Answers whether there was anything to delete.
 */
export async function deleteExternalDocument(
  db: Database,
  input: { tenantId: string; source: string; externalId: string },
  deps: { storage?: StorageService | null } = {}
): Promise<boolean> {
  const [row] = await deleteDocumentsWithFacts(
    db,
    input.tenantId,
    eq(documents.source, input.source),
    eq(documents.externalId, input.externalId)
  )
  if (!row) return false
  if (row.fileId && deps.storage) await dropStoredFile(db, deps.storage, input.tenantId, row.fileId)
  return true
}

// ---- Uploads -----------------------------------------------------------------------------------

export interface IngestFileInput {
  tenantId: string
  /** Required: a `files` row always has an owner (it cascades from the user). */
  userId: string
  /** The multipart part (a Blob carries the length R2 needs). */
  file: Blob
  /** The client's filename — the storage key, the default title and the default source derive from it. */
  filename: string
  /** Resolved by `resolveDocumentUploadType` at the route (415 before this is called). */
  type: DocumentUploadType
  title?: string | null
  source?: string | null
  /** As `IngestTextInput`: validated at the route, defaults to tenant-wide. */
  visibility?: ResourceVisibility
  groupIds?: readonly string[]
  /** As `IngestTextInput`; the replaced original is removed from storage. */
  externalId?: string | null
  /** As `IngestTextInput` (D43). */
  origin?: DocumentOrigin
  reviewerUserId?: string | null
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
 * 503 — nothing written yet) → for a text-like type, decode and hash it and answer an unchanged
 * upsert or a duplicate from the existing row (nothing stored) → object + `files` row → `documents` row (`pending`, `fileId`, the
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

  // A text-like upload is decoded BEFORE anything is stored, so an unchanged re-sync or a
  // duplicate answers the existing document without an R2 object or `files` row to clean up.
  let text: string | null = null
  let hash: string | null = null
  if (input.type.kind === 'text') {
    text = normalizeDocumentText(await decodeText(input.file))
    hash = await contentHash(text)
    const source = input.source?.trim() || sanitizeFilename(input.filename || 'file')
    const visibility = input.visibility ?? 'tenant'
    const external = externalKey(input)
    if (external) {
      const existing = await findExternal(db, input.tenantId, external)
      if (existing && (await isUnchanged(db, input.tenantId, existing, hash, embeddings.model))) {
        const document = await touchUnchanged(
          db,
          input.tenantId,
          existing,
          {
            title: input.title?.trim() || titleFromFilename(input.filename),
            ownerUserId: input.userId,
            visibility,
            contentType: input.type.contentType,
            reviewerUserId: input.reviewerUserId ?? null,
          },
          input.groupIds
        )
        return { document, mode: 'unchanged', deduplicated: false }
      }
    } else {
      const duplicate = await findDuplicate(db, input.tenantId, source, hash, visibility)
      if (duplicate) return { document: duplicate, mode: 'unchanged', deduplicated: true }
    }
  }

  const stored = await storeUploadedFile(db, deps.storage, {
    tenantId: input.tenantId,
    ownerUserId: input.userId,
    scope: 'documents',
    file: input.file,
    filename: input.filename,
    contentType: input.type.contentType,
  })
  const pieces: TextChunk[] = text !== null ? chunkText(text) : []

  let row: DocumentRow | undefined
  let previous: DocumentRow | undefined
  try {
    const values = {
      tenantId: input.tenantId,
      ownerUserId: input.userId,
      title: input.title?.trim() || titleFromFilename(input.filename),
      source: input.source?.trim() || stored.filename,
      contentType: input.type.contentType,
      sizeBytes: input.file.size,
      content: text,
      contentHash: hash,
      fileId: stored.id,
      status: 'pending' as const,
      visibility: input.visibility ?? 'tenant',
      origin: input.origin ?? 'upload',
      reviewerUserId: input.reviewerUserId ?? null,
    }
    const external = externalKey(input)
    previous = external ? await findExternal(db, input.tenantId, external) : undefined
    ;[row] = external
      ? [
          await upsertExternal(
            db,
            input.tenantId,
            { ...values, externalId: external.externalId },
            input.groupIds
          ),
        ]
      : await db.insert(documents).values(values).returning()
    if (!row) throw new Error('documents: insert returned no row')
    if (!external) await grantDocumentGroups(db, input.tenantId, row, input.groupIds)
  } catch (err) {
    await deleteStoredFile(db, deps.storage, stored).catch(() => {})
    throw err
  }
  if (previous?.fileId && previous.fileId !== stored.id) {
    await dropStoredFile(db, deps.storage, input.tenantId, previous.fileId)
  }

  if (input.type.kind === 'convert') {
    await enqueueJob(deps.jobs, {
      type: 'document.convert',
      payload: { tenantId: input.tenantId, documentId: row.id },
    })
    return { document: row, mode: 'queued', deduplicated: false }
  }
  if ((text ?? '').length > INGEST_TEXT_MAX_CHARS) {
    await markDocumentFailed(db, input.tenantId, row.id, tooLong((text ?? '').length))
    const failed = await db.query.documents.findFirst({
      where: and(eq(documents.id, row.id), eq(documents.tenantId, input.tenantId)),
    })
    return { document: failed ?? row, mode: 'inline', deduplicated: false }
  }
  return indexOrEnqueue(
    db,
    cfg,
    env,
    input.tenantId,
    row,
    pieces,
    embeddings,
    deps,
    previous?.contentHash !== hash
  )
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
    const converted = await convertToText(env, {
      name: file.filename,
      blob,
      contentType: type.contentType,
    })
    // Some PDFs convert with NULs in the text, which Postgres refuses (22021) — strip before the
    // write; line endings are normalised so the chunks' offsets index the stored text exactly.
    // `indexDocument` sets `contentHash` (a binary upload is never deduplicated at ingest).
    const text = normalizeDocumentText(converted.text)
    if (text.length > INGEST_TEXT_MAX_CHARS) throw tooLong(text.length)
    await db
      .update(documents)
      .set({ content: text })
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
  } catch (err) {
    await markDocumentFailed(db, tenantId, documentId, err)
    throw err
  }
  return indexDocument(db, cfg, env, tenantId, documentId)
}

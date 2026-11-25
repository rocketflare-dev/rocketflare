/**
 * `/api/ai/documents`: the tenant knowledge base — ingest text, upload files, list/read/
 * delete documents, hybrid search. Documents are tenant-wide by default and can be restricted to
 * GROUPS: every read path here ANDs `visibleDocuments(scope)` with the tenant predicate, and
 * a document the caller may not see answers **404**, the same body as one that does not exist. Two ways in, one path: `POST /ingest` (JSON text) and
 * `POST /upload` (multipart — the original goes to R2 as a `files` row, scope `documents`). Small
 * texts index inline (201 `indexed`); the same text again as a tenant-wide document of the same
 * source answers the existing one (200, `deduplicated: true`); large texts and every binary upload return `pending` and a
 * `document.index` / `document.convert` job finishes them. Deleting someone else's document needs
 * `delete Document` (admin+) — own-document delete is the `ownerUserId` check here. Deleting a
 * document deletes its original. The raw text and the vectors never leave the server.
 * `GET /facets` lists the sources and types the search filters can offer, over the same visible set.
 * Upkeep: `GET /health` and `POST /reembed` (admin+, `manage Document`) report and rebuild stale
 * embeddings; `POST /:id/retry` (owner or `manage Document`) re-enqueues a failed document.
 */
import {
  CONTEXTUALIZE_BACKFILL_MAX,
  type ContextualizeBackfillResponse,
  type DocumentFacets,
  type DocumentsHealth,
  documentContentQuerySchema,
  documentListQuerySchema,
  type IngestDocumentResponse,
  ingestTextRequestSchema,
  type ReembedResponse,
  type RetryDocumentResponse,
  resolveDocumentUploadType,
  type SearchResponse,
  searchRequestSchema,
  uploadDocumentFieldsSchema,
} from '@rocketflare/shared/ai/embeddings'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { MAX_UPLOAD_BYTES } from '@rocketflare/shared/files'
import { type GroupRef, setVisibilityRequestSchema } from '@rocketflare/shared/groups'
import { paginationQuerySchema } from '@rocketflare/shared/pagination'
import { and, count, desc, eq, isNotNull, max, min } from 'drizzle-orm'
import { type DocumentRow, documents, files } from '../../db/schema'
import { hasFeature } from '../../permissions/features'
import { uploadBodyLimit } from '../middleware/body-limit'
import { can, guardPermission } from '../middleware/permissions'
import {
  accessScopeOf,
  grantsForResources,
  resolveRequestedVisibility,
  setResourceGroups,
  visibleDocuments,
} from '../services/access'
import { recordActivity } from '../services/activity'
import {
  countVisibleWithoutContext,
  enqueueContextualizeBackfill,
  KNOWLEDGE_CONTEXT_FEATURE,
} from '../services/ai/contextualize'
import {
  listDocumentPassages,
  readDocumentCard,
  readDocumentWindow,
} from '../services/ai/document-content'
import { AiNotConfiguredError } from '../services/ai/errors'
import {
  ConversionNotConfiguredError,
  ingestFile,
  ingestText,
  toDocument,
} from '../services/ai/ingest'
import {
  countVisibleStaleDocuments,
  documentsHealth,
  enqueueReembed,
  retryFailedDocument,
} from '../services/ai/reindex'
import { resolveEmbeddingsModel } from '../services/ai/resolve'
import { searchKnowledgeChunks } from '../services/ai/retrieval'
import { requireJobsQueue } from '../services/jobs'
import { deleteDocumentsWithFacts } from '../services/knowledge/remove'
import { nudge, realtimeEvent } from '../services/realtime'
import { createR2Storage, deleteStoredFile, type StorageService } from '../services/storage'
import type { AppContext } from '../types'
import {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../utils/core/errors'
import { pageWindow, paginated } from '../utils/routes/pagination'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const aiDocumentsRouter = createRouter()

/** The document, or the 404 that an invisible one and an absent one share. */
async function findVisibleDocument(
  db: ReturnType<typeof withAuthAndDb>['db'],
  scope: ReturnType<typeof accessScopeOf>,
  id: string
) {
  const row = await db.query.documents.findFirst({
    where: and(
      eq(documents.id, id),
      eq(documents.tenantId, scope.tenantId),
      visibleDocuments(scope)
    ),
  })
  if (!row) throw new NotFoundError('Document not found')
  return row
}

/** The groups one document is shared with — the list route batches this instead. */
async function groupsOf(
  db: ReturnType<typeof withAuthAndDb>['db'],
  tenantId: string,
  documentId: string
) {
  return (await grantsForResources(db, tenantId, 'document', [documentId])).get(documentId) ?? []
}

/** The R2 binding or a 503 — same rule as `/api/files`: a deployment without `FILES` fails loudly. */
function storageFor(c: AppContext): StorageService {
  if (!c.env.FILES) {
    throw new ServiceUnavailableError('File storage is not configured', 'storage_not_configured')
  }
  return createR2Storage(c.env.FILES)
}

/** The binding may be absent (a delete still succeeds; the object is logged as left behind). */
function optionalStorage(c: AppContext): StorageService | null {
  return c.env.FILES ? createR2Storage(c.env.FILES) : null
}

// ---- POST /api/ai/documents/ingest ----------------------------------------------------------------

aiDocumentsRouter.post('/ingest', validate('json', ingestTextRequestSchema), async c => {
  const { db, tenantId, user, cfg, auth, defer, tracer } = withAuthAndDb(c)
  guardPermission(c, 'create', 'Document')
  const body = c.req.valid('json')
  const access = await resolveRequestedVisibility(db, accessScopeOf(auth), body)
  const { document, mode, deduplicated } = await ingestText(
    db,
    cfg,
    c.env,
    {
      tenantId,
      userId: user.id,
      title: body.title,
      text: body.text,
      source: body.source ?? 'upload',
      visibility: access.visibility,
      groupIds: access.groupIds,
    },
    { jobs: c.env.JOBS_QUEUE, tracer }
  )
  // A duplicate wrote nothing, so there is nothing to record: the document's own ingest was.
  if (!deduplicated) {
    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: 'document.ingested',
        subjectType: 'Document',
        subjectId: document.id,
        metadata: {
          mode,
          status: document.status,
          chunkCount: document.chunkCount,
          visibility: document.visibility,
        },
      })
    )
  }
  return ingestResponse(c, document, deduplicated, await groupsOf(db, tenantId, document.id))
})

// ---- POST /api/ai/documents/upload ----------------------------------------------------------------

aiDocumentsRouter.post('/upload', uploadBodyLimit, async c => {
  const { db, tenantId, user, cfg, auth, defer, tracer } = withAuthAndDb(c)
  guardPermission(c, 'create', 'Document')
  const storage = storageFor(c)

  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    throw new BadRequestError('Expected multipart form data with a `file` field', 'file_required')
  }
  if (file.size === 0) throw new BadRequestError('The file is empty', 'file_empty')
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      413,
      `File exceeds the ${MAX_UPLOAD_BYTES} byte limit`,
      'payload_too_large',
      {
        maxBytes: MAX_UPLOAD_BYTES,
        sizeBytes: file.size,
      }
    )
  }
  const type = resolveDocumentUploadType(file.name ?? '', file.type)
  if (!type) {
    throw new ApiError(
      415,
      'Unsupported document type: upload a PDF, Word, Excel, OpenDocument, HTML, XML, CSV, JSON, Markdown or text file',
      'unsupported_media_type',
      { contentType: file.type || null, filename: file.name ?? null }
    )
  }
  const fields = uploadDocumentFieldsSchema.safeParse({
    title: stringField(form, 'title'),
    source: stringField(form, 'source'),
    visibility: stringField(form, 'visibility'),
    groupIds: jsonArrayField(form, 'groupIds'),
  })
  if (!fields.success) throw new ValidationError(fields.error.issues, 'Invalid form')
  const access = await resolveRequestedVisibility(db, accessScopeOf(auth), fields.data)

  let result: Awaited<ReturnType<typeof ingestFile>>
  try {
    result = await ingestFile(
      db,
      cfg,
      c.env,
      {
        tenantId,
        userId: user.id,
        file,
        filename: file.name || 'file',
        type,
        title: fields.data.title,
        source: fields.data.source,
        visibility: access.visibility,
        groupIds: access.groupIds,
      },
      { jobs: c.env.JOBS_QUEUE, storage, tracer }
    )
  } catch (err) {
    if (err instanceof ConversionNotConfiguredError) {
      throw new ServiceUnavailableError(
        'Document conversion is not configured on this server; upload text, Markdown, CSV or JSON instead',
        'conversion_not_configured'
      )
    }
    throw err
  }
  const { document, mode, deduplicated } = result
  if (!deduplicated)
    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: 'document.ingested',
        subjectType: 'Document',
        subjectId: document.id,
        metadata: {
          mode,
          status: document.status,
          chunkCount: document.chunkCount,
          contentType: document.contentType,
          sizeBytes: document.sizeBytes,
          fileId: document.fileId,
          visibility: document.visibility,
        },
      })
    )
  return ingestResponse(c, document, deduplicated, await groupsOf(db, tenantId, document.id))
})

/**
 * `201` with the new document, or `200` with the EXISTING one when the same text was already a
 * tenant-wide document of the same source (`deduplicated: true`).
 */
function ingestResponse(
  c: AppContext,
  document: DocumentRow,
  deduplicated: boolean,
  groups: GroupRef[]
) {
  const body: IngestDocumentResponse = { ...toDocument(document, groups), deduplicated }
  return c.json(body, deduplicated ? 200 : 201)
}

/** `groupIds` travels through multipart as a JSON array; anything unparseable is left to zod. */
function jsonArrayField(form: FormData | null, name: string): unknown {
  const raw = stringField(form, name)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** A text part of the form, or undefined when absent/blank (a `File` in a text field is ignored). */
function stringField(form: FormData | null, name: string): string | undefined {
  const value = form?.get(name)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

// ---- GET /api/ai/documents ------------------------------------------------------------------------

aiDocumentsRouter.get('/', validate('query', documentListQuerySchema), async c => {
  const { db, tenantId, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const scope = accessScopeOf(auth)
  const query = c.req.valid('query')
  const { limit, offset } = pageWindow(query)
  const where = and(
    eq(documents.tenantId, tenantId),
    visibleDocuments(scope),
    query.status ? eq(documents.status, query.status) : undefined
  )
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(documents)
      .where(where)
      .orderBy(desc(documents.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(documents).where(where),
  ])
  // One extra round trip for the whole page, not one per row.
  const grants = await grantsForResources(
    db,
    tenantId,
    'document',
    rows.map(r => r.id)
  )
  return c.json(
    paginated(
      rows.map(row => toDocument(row, grants.get(row.id) ?? [])),
      total?.n ?? 0,
      query
    )
  )
})

// ---- POST /api/ai/documents/search ----------------------------------------------------------------

aiDocumentsRouter.post('/search', validate('json', searchRequestSchema), async c => {
  const { db, cfg, auth, defer } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const request = c.req.valid('json')
  // The usage rows (query embedding, rerank) are written after the response, in `waitUntil`.
  const { hits, lexical } = await searchKnowledgeChunks(db, cfg, c.env, accessScopeOf(auth), {
    ...request,
    defer,
  })
  // The provenance fields are for tools; the HTTP contract is `SearchHit`.
  const body: SearchResponse = {
    query: request.query,
    hits: hits.map(({ source: _s, externalId: _e, platform: _p, ...hit }) => hit),
    lexical,
  }
  return c.json(body)
})

// ---- GET /api/ai/documents/facets ----------------------------------------------------------------

/**
 * What the Search page's filters can offer: the distinct sources and content types of the indexed
 * documents THIS reader may see (tenant AND `visibleDocuments`, like every read here), with
 * counts, the range of their dates, and how many of them are embedded by another model than
 * today's (`staleEmbeddings` — `/health` is admin-only, this is any reader's), and how many have no
 * contextual prefix yet (`withoutContext`, 0 without the `knowledge-context` flag). Never lists a value
 * only an invisible document carries.
 */
aiDocumentsRouter.get('/facets', async c => {
  const { db, tenantId, auth, cfg } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const scope = accessScopeOf(auth)
  const where = and(
    eq(documents.tenantId, tenantId),
    visibleDocuments(scope),
    eq(documents.status, 'indexed')
  )
  const n = count()
  const staleCount = async () => {
    const model = await resolveEmbeddingsModel(db, cfg, c.env, tenantId)
    return model ? countVisibleStaleDocuments(db, scope, model) : 0
  }
  const withoutContext = () =>
    hasFeature(auth.features, KNOWLEDGE_CONTEXT_FEATURE)
      ? countVisibleWithoutContext(db, scope)
      : Promise.resolve(0)
  const [sources, contentTypes, [span], staleEmbeddings, missingContext] = await Promise.all([
    db
      .select({ value: documents.source, count: n })
      .from(documents)
      .where(and(where, isNotNull(documents.source)))
      .groupBy(documents.source)
      .orderBy(desc(n), documents.source),
    db
      .select({ value: documents.contentType, count: n })
      .from(documents)
      .where(where)
      .groupBy(documents.contentType)
      .orderBy(desc(n), documents.contentType),
    db
      .select({ total: n, oldest: min(documents.createdAt), newest: max(documents.createdAt) })
      .from(documents)
      .where(where),
    staleCount(),
    withoutContext(),
  ])
  const body: DocumentFacets = {
    total: span?.total ?? 0,
    sources: sources.flatMap(r => (r.value === null ? [] : [{ value: r.value, count: r.count }])),
    contentTypes,
    oldest: span?.oldest ?? null,
    newest: span?.newest ?? null,
    staleEmbeddings,
    withoutContext: missingContext,
  }
  return c.json(body)
})

// ---- GET /api/ai/documents/health -----------------------------------------------------------------

/** Documents by status, the embeddings model today and how much is stale against it (admin+). */
aiDocumentsRouter.get('/health', async c => {
  const { db, tenantId, cfg } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Document')
  const body: DocumentsHealth = await documentsHealth(db, cfg, c.env, tenantId)
  return c.json(body)
})

// ---- POST /api/ai/documents/reembed ---------------------------------------------------------------

/**
 * Re-embed every stale document with today's model: a `document.reembed` chain (202). Nothing
 * stale → 202 with `enqueued: false`. No embedder → 503 `ai_not_configured` before anything is
 * enqueued; no `JOBS_QUEUE` → `JobsQueueNotConfiguredError`, as every other enqueue.
 */
aiDocumentsRouter.post('/reembed', async c => {
  const { db, tenantId, user, cfg, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Document')
  const model = await resolveEmbeddingsModel(db, cfg, c.env, tenantId)
  if (!model) throw new AiNotConfiguredError('embeddings')
  const health = await documentsHealth(db, cfg, c.env, tenantId)
  const enqueued = health.staleEmbeddings > 0
  if (enqueued) await enqueueReembed(c.env.JOBS_QUEUE, tenantId, model)
  if (enqueued)
    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: 'document.reembed_requested',
        subjectType: 'Document',
        subjectId: null,
        metadata: { model, staleEmbeddings: health.staleEmbeddings },
      })
    )
  const body: ReembedResponse = {
    embeddingModel: model,
    staleEmbeddings: health.staleEmbeddings,
    staleChunks: health.staleChunks,
    enqueued,
  }
  return c.json(body, 202)
})

// ---- POST /api/ai/documents/contextualize ---------------------------------------------------------

/**
 * Backfill contextual prefixes (`knowledge-context` flag): one `document.contextualize` job per
 * indexed document that still has a passage without one, oldest first, at most
 * `CONTEXTUALIZE_BACKFILL_MAX` per call (202 with `enqueued` and `remaining` — call again until
 * `remaining` is 0). Flag off → 404 `feature_disabled`, as the mount gate answers; no `JOBS_QUEUE`
 * → `JobsQueueNotConfiguredError` before anything is read.
 */
aiDocumentsRouter.post('/contextualize', async c => {
  const { db, tenantId, user, auth, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Document')
  if (!hasFeature(auth.features, KNOWLEDGE_CONTEXT_FEATURE)) {
    throw new NotFoundError(
      `Not found: ${new URL(c.req.url).pathname}`,
      ERROR_CODES.featureDisabled
    )
  }
  const jobs = requireJobsQueue(c.env.JOBS_QUEUE)
  const body: ContextualizeBackfillResponse = await enqueueContextualizeBackfill(
    db,
    jobs,
    tenantId,
    CONTEXTUALIZE_BACKFILL_MAX
  )
  if (body.enqueued > 0)
    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: 'document.contextualize_requested',
        subjectType: 'Document',
        subjectId: null,
        metadata: { enqueued: body.enqueued, remaining: body.remaining },
      })
    )
  return c.json(body, 202)
})

// ---- GET /api/ai/documents/:id --------------------------------------------------------------------

aiDocumentsRouter.get('/:id', async c => {
  const { db, tenantId, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const row = await findVisibleDocument(db, accessScopeOf(auth), uuidParam(c, 'id'))
  return c.json(toDocument(row, await groupsOf(db, tenantId, row.id)))
})

// ---- GET /api/ai/documents/:id/content ------------------------------------------------------------

/**
 * A character window over the document's text (pasted text, or the converted markdown of an
 * upload). The window is cut in Postgres, so a 500 000-character document is paged rather than
 * loaded. A document with no text yet is a 409 rather than an empty window — "not converted" and
 * "empty" are different answers, and the viewer renders a different thing for each.
 */
aiDocumentsRouter.get('/:id/content', validate('query', documentContentQuerySchema), async c => {
  const { db, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const { offset, maxChars } = c.req.valid('query')
  const window = await readDocumentWindow(db, accessScopeOf(auth), {
    documentId: uuidParam(c, 'id'),
    offset,
    maxChars,
  })
  if (window.ok) return c.json(window.content)
  // Unknown and cross-tenant are the SAME body: the API is not an existence oracle.
  if (window.reason === 'document_not_found') throw new NotFoundError('Document not found')
  if (window.reason === 'conversion_failed') {
    throw new ConflictError(
      `This document could not be indexed (${window.error ?? 'unknown error'}), so it has no text`,
      'document_conversion_failed'
    )
  }
  throw new ConflictError(
    'This document is still being converted and has no text yet',
    'document_not_converted'
  )
})

// ---- GET /api/ai/documents/:id/passages -----------------------------------------------------------

/** The stored passages in `seq` order. The query names its columns, so `embedding` never leaks. */
aiDocumentsRouter.get('/:id/passages', validate('query', paginationQuerySchema), async c => {
  const { db, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const query = c.req.valid('query')
  const page = await listDocumentPassages(db, accessScopeOf(auth), uuidParam(c, 'id'), query)
  if (!page) throw new NotFoundError('Document not found')
  return c.json(paginated(page.items, page.total, query))
})

// ---- GET /api/ai/documents/:id/card ---------------------------------------------------------------

/** The compact citation form: metadata plus an EXCERPT of the text — never a summary. */
aiDocumentsRouter.get('/:id/card', async c => {
  const { db, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const card = await readDocumentCard(db, accessScopeOf(auth), uuidParam(c, 'id'))
  if (!card) throw new NotFoundError('Document not found')
  return c.json(card)
})

// ---- DELETE /api/ai/documents/:id -----------------------------------------------------------------

aiDocumentsRouter.delete('/:id', async c => {
  const { db, tenantId, user, auth, defer, logger } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const id = uuidParam(c, 'id')
  const row = await findVisibleDocument(db, accessScopeOf(auth), id)
  if (row.ownerUserId !== user.id && !can(c, 'delete', 'Document')) {
    throw new ForbiddenError('You can only delete documents you added')
  }
  // Chunks cascade from the document row; its facts go first, undoing what they did to other
  // facts; the uploaded original (object + `files` row) goes with it.
  await deleteDocumentsWithFacts(db, tenantId, eq(documents.id, id))
  if (row.fileId) {
    const file = await db.query.files.findFirst({
      where: and(eq(files.id, row.fileId), eq(files.tenantId, tenantId)),
    })
    if (file) {
      const storage = optionalStorage(c)
      if (!storage) logger.warn({ key: file.key }, 'documents: FILES not bound, object left behind')
      await deleteStoredFile(db, storage, file)
    }
  }
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'document.deleted',
      subjectType: 'Document',
      subjectId: id,
      metadata: { title: row.title, fileId: row.fileId },
    })
  )
  return c.body(null, 204)
})

// ---- POST /api/ai/documents/:id/retry -------------------------------------------------------------

/**
 * Re-enqueue a `failed` document (owner or `manage Document`, the visibility rule): no text yet →
 * `document.convert`, text → `document.index`; 202 with the row, now `pending`. Not failed → 409
 * `document_not_failed`; hidden or absent → the shared 404.
 */
aiDocumentsRouter.post('/:id/retry', async c => {
  const { db, tenantId, user, auth, defer } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const id = uuidParam(c, 'id')
  const row = await findVisibleDocument(db, accessScopeOf(auth), id)
  if (row.ownerUserId !== user.id && !can(c, 'manage', 'Document')) {
    throw new ForbiddenError('You can only retry documents you added')
  }
  const notFailed = () =>
    new ConflictError(`This document is ${row.status}, not failed`, 'document_not_failed')
  if (row.status !== 'failed') throw notFailed()
  const result = await retryFailedDocument(db, c.env.JOBS_QUEUE, row)
  if (!result) throw notFailed()
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'document.retried',
      subjectType: 'Document',
      subjectId: id,
      metadata: { job: result.job },
    })
  )
  const body: RetryDocumentResponse = {
    ...toDocument(result.document, await groupsOf(db, tenantId, id)),
    job: result.job,
  }
  return c.json(body, 202)
})

// ---- PUT /api/ai/documents/:id/visibility ----------------------------------------------------

/**
 * Who may read this document. Allowed to the document's OWNER or to `manage Document` (admin+) —
 * the same rule as deleting it, because both are decisions about a document rather than about its
 * contents. A member may only name groups they belong to (`resolveRequestedVisibility`).
 *
 * Note what this deliberately does NOT do: it never checks whether the caller will still be able
 * to see the document afterwards. Restricting a document to a group you are not in is a legitimate
 * thing for an admin to do, and the UI warns rather than the API refusing.
 */
aiDocumentsRouter.put('/:id/visibility', validate('json', setVisibilityRequestSchema), async c => {
  const { db, tenantId, user, auth, realtime, defer } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const scope = accessScopeOf(auth)
  const id = uuidParam(c, 'id')
  const row = await findVisibleDocument(db, scope, id)
  if (row.ownerUserId !== user.id && !can(c, 'manage', 'Document')) {
    throw new ForbiddenError('You can only change the visibility of documents you added')
  }
  const requested = await resolveRequestedVisibility(db, scope, c.req.valid('json'))
  await setResourceGroups(db, scope, 'document', id, requested)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'document.visibility_changed',
      subjectType: 'Document',
      subjectId: id,
      metadata: { visibility: requested.visibility, groupIds: requested.groupIds },
    })
  )
  nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity: 'documents', id }))
  const updated = await findVisibleDocument(db, { ...scope, bypass: true }, id)
  return c.json(toDocument(updated, await groupsOf(db, tenantId, id)))
})

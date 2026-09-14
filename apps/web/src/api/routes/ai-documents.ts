/**
 * `/api/ai/documents` (D18): the tenant knowledge base — ingest text, upload files, list/read/
 * delete documents, hybrid search. Documents are tenant-wide by default and can be restricted to
 * GROUPS (D29): every read path here ANDs `visibleDocuments(scope)` with the tenant predicate, and
 * a document the caller may not see answers **404**, the same body as one that does not exist. Two ways in, one path (00 §1.3): `POST /ingest` (JSON text) and
 * `POST /upload` (multipart — the original goes to R2 as a `files` row, scope `documents`). Small
 * texts index inline (201 `indexed`); large texts and every binary upload return `pending` and a
 * `document.index` / `document.convert` job finishes them. Deleting someone else's document needs
 * `delete Document` (admin+) — own-document delete is the `ownerUserId` check here. Deleting a
 * document deletes its original. The raw text and the vectors never leave the server.
 */
import {
  documentContentQuerySchema,
  documentListQuerySchema,
  ingestTextRequestSchema,
  resolveDocumentUploadType,
  type SearchResponse,
  searchRequestSchema,
  uploadDocumentFieldsSchema,
} from '@rocketflare/shared/ai/embeddings'
import { MAX_UPLOAD_BYTES } from '@rocketflare/shared/files'
import { setVisibilityRequestSchema } from '@rocketflare/shared/groups'
import { paginationQuerySchema } from '@rocketflare/shared/pagination'
import { and, count, desc, eq } from 'drizzle-orm'
import { documents, files } from '../../db/schema'
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
  listDocumentPassages,
  readDocumentCard,
  readDocumentWindow,
} from '../services/ai/document-content'
import {
  ConversionNotConfiguredError,
  ingestFile,
  ingestText,
  toDocument,
} from '../services/ai/ingest'
import { searchChunks } from '../services/ai/retrieval'
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
  const { db, tenantId, user, cfg, auth, defer } = withAuthAndDb(c)
  guardPermission(c, 'create', 'Document')
  const body = c.req.valid('json')
  const access = await resolveRequestedVisibility(db, accessScopeOf(auth), body)
  const { document, mode } = await ingestText(
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
    { jobs: c.env.JOBS_QUEUE }
  )
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
  return c.json(toDocument(document, await groupsOf(db, tenantId, document.id)), 201)
})

// ---- POST /api/ai/documents/upload ----------------------------------------------------------------

aiDocumentsRouter.post('/upload', uploadBodyLimit, async c => {
  const { db, tenantId, user, cfg, auth, defer } = withAuthAndDb(c)
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
      { jobs: c.env.JOBS_QUEUE, storage }
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
  const { document, mode } = result
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
  return c.json(toDocument(document, await groupsOf(db, tenantId, document.id)), 201)
})

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
  const { db, cfg, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const request = c.req.valid('json')
  const hits = await searchChunks(db, cfg, c.env, accessScopeOf(auth), request)
  const body: SearchResponse = { query: request.query, hits }
  return c.json(body)
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

/** The compact citation form: metadata plus an EXCERPT of the text — never a summary (D18). */
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
  // Chunks cascade from the document row; the uploaded original (object + `files` row) goes with it.
  await db.delete(documents).where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)))
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

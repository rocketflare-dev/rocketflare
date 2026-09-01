/**
 * `/api/ai/documents` (D18): the tenant knowledge base — ingest text, upload files, list/read/
 * delete documents, hybrid search. Two ways in, one path (00 §1.3): `POST /ingest` (JSON text) and
 * `POST /upload` (multipart — the original goes to R2 as a `files` row, scope `documents`). Small
 * texts index inline (201 `indexed`); large texts and every binary upload return `pending` and a
 * `document.index` / `document.convert` job finishes them. Documents are tenant-shared (every
 * member may read and search); deleting someone else's needs `delete Document` (admin+) —
 * own-document delete is the `ownerUserId` check here. Deleting a document deletes its original.
 * The raw text and the vectors never leave the server. Every query carries the tenant predicate.
 */
import {
  documentListQuerySchema,
  ingestTextRequestSchema,
  resolveDocumentUploadType,
  type SearchResponse,
  searchRequestSchema,
  uploadDocumentFieldsSchema,
} from '@rocketflare/shared/ai/embeddings'
import { MAX_UPLOAD_BYTES } from '@rocketflare/shared/files'
import { and, count, desc, eq } from 'drizzle-orm'
import { documents, files } from '../../db/schema'
import { uploadBodyLimit } from '../middleware/body-limit'
import { can, guardPermission } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import {
  ConversionNotConfiguredError,
  ingestFile,
  ingestText,
  toDocument,
} from '../services/ai/ingest'
import { searchChunks } from '../services/ai/retrieval'
import { createR2Storage, deleteStoredFile, type StorageService } from '../services/storage'
import type { AppContext } from '../types'
import {
  ApiError,
  BadRequestError,
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
  const { db, tenantId, user, cfg, defer } = withAuthAndDb(c)
  guardPermission(c, 'create', 'Document')
  const body = c.req.valid('json')
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
      metadata: { mode, status: document.status, chunkCount: document.chunkCount },
    })
  )
  return c.json(toDocument(document), 201)
})

// ---- POST /api/ai/documents/upload ----------------------------------------------------------------

aiDocumentsRouter.post('/upload', uploadBodyLimit, async c => {
  const { db, tenantId, user, cfg, defer } = withAuthAndDb(c)
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
  })
  if (!fields.success) throw new ValidationError(fields.error.issues, 'Invalid form')

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
      },
    })
  )
  return c.json(toDocument(document), 201)
})

/** A text part of the form, or undefined when absent/blank (a `File` in a text field is ignored). */
function stringField(form: FormData | null, name: string): string | undefined {
  const value = form?.get(name)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

// ---- GET /api/ai/documents ------------------------------------------------------------------------

aiDocumentsRouter.get('/', validate('query', documentListQuerySchema), async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const query = c.req.valid('query')
  const { limit, offset } = pageWindow(query)
  const where = and(
    eq(documents.tenantId, tenantId),
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
  return c.json(paginated(rows.map(toDocument), total?.n ?? 0, query))
})

// ---- POST /api/ai/documents/search ----------------------------------------------------------------

aiDocumentsRouter.post('/search', validate('json', searchRequestSchema), async c => {
  const { db, tenantId, cfg } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const request = c.req.valid('json')
  const hits = await searchChunks(db, cfg, c.env, tenantId, request)
  const body: SearchResponse = { query: request.query, hits }
  return c.json(body)
})

// ---- GET /api/ai/documents/:id --------------------------------------------------------------------

aiDocumentsRouter.get('/:id', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.id, uuidParam(c, 'id')), eq(documents.tenantId, tenantId)),
  })
  if (!row) throw new NotFoundError('Document not found')
  return c.json(toDocument(row))
})

// ---- DELETE /api/ai/documents/:id -----------------------------------------------------------------

aiDocumentsRouter.delete('/:id', async c => {
  const { db, tenantId, user, defer, logger } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const id = uuidParam(c, 'id')
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.id, id), eq(documents.tenantId, tenantId)),
  })
  if (!row) throw new NotFoundError('Document not found')
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

/**
 * `/api/ai/documents` (D18): the tenant knowledge base — ingest text, list/read/delete documents,
 * hybrid search. `POST /ingest` is the ONE way text gets in (00 §1.3): small texts index inline
 * (201 `indexed`), large ones return `pending` and a `document.index` job finishes them. Documents
 * are tenant-shared (every member may read and search); deleting someone else's needs `delete
 * Document` (admin+) — own-document delete is the `ownerUserId` check here. The raw text and the
 * vectors never leave the server. Every query carries the tenant predicate.
 */
import {
  documentListQuerySchema,
  ingestTextRequestSchema,
  type SearchResponse,
  searchRequestSchema,
} from '@gmgo/shared/ai/embeddings'
import { and, count, desc, eq } from 'drizzle-orm'
import { documents } from '../../db/schema'
import { can, guardPermission } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import { ingestText, toDocument } from '../services/ai/ingest'
import { searchChunks } from '../services/ai/retrieval'
import { ForbiddenError, NotFoundError } from '../utils/core/errors'
import { pageWindow, paginated } from '../utils/routes/pagination'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const aiDocumentsRouter = createRouter()

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
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Document')
  const id = uuidParam(c, 'id')
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.id, id), eq(documents.tenantId, tenantId)),
  })
  if (!row) throw new NotFoundError('Document not found')
  if (row.ownerUserId !== user.id && !can(c, 'delete', 'Document')) {
    throw new ForbiddenError('You can only delete documents you added')
  }
  // Chunks cascade from the document row.
  await db.delete(documents).where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)))
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'document.deleted',
      subjectType: 'Document',
      subjectId: id,
      metadata: { title: row.title },
    })
  )
  return c.body(null, 204)
})

/**
 * `/api/files`: download / delete over the `StorageService` seam (an upload is `/api/uploads`,
 * straight to storage — targets `avatars`, `uploads`, `documents`). Objects live in
 * R2 under a tenant prefix; the `files` row is the index and the ONLY thing the browser can name
 * (`/api/files/:id`). Every query filters by the auth context's `tenantId` — a file uploaded in
 * one organisation is a 404 in another, including avatars (known gap: the person's `avatarUrl`
 * is global, the object is not). Bytes stream through the Worker with `Cache-Control: private`.
 *
 * `avatars` target: image MIME allowlist, and the caller's `users.avatarUrl` is set to the new URL.
 * Images and PDFs (`INLINE_MIME_TYPES`) are served `inline`; anything else is an attachment, so a
 * stored `text/html` or SVG can never execute on this origin. A PDF additionally opts into being
 * FRAMED (`c.set('embeddable', true)` → `SAMEORIGIN` + `frame-ancestors 'self'`, see
 * `middleware/security-headers.ts`) so the document viewer can embed it — a separate list from the
 * inline one on purpose, because inline and framable are not the same property. `documents` scope
 * rows are created by the `documents` upload target and only deleted with their document (409
 * `owned_by_document` here).
 */
import { filePath, isEmbeddableMimeType, isInlineMimeType } from '@rocketflare/shared/files'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { documents, files, users } from '../../db/schema'
import { can, guardPermission } from '../middleware/permissions'
import { type AccessScope, accessScopeOf, visibleDocuments } from '../services/access'
import { recordActivity } from '../services/activity'
import { createR2Storage, type StorageService } from '../services/storage'
import type { AppContext } from '../types'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const filesRouter = createRouter()

/**
 * May this reader open the document this object belongs to? A `documents`-scope object always has
 * one; an orphan (the document was deleted but the row survived a failure) reads as NOT visible,
 * which is the safe direction.
 */
async function canReadOwningDocument(
  db: Database,
  scope: AccessScope,
  fileId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.fileId, fileId),
        eq(documents.tenantId, scope.tenantId),
        visibleDocuments(scope)
      )
    )
    .limit(1)
  return Boolean(row)
}

/** The R2 binding or a 503 — a deployment without `FILES` must fail loudly, not 500 on `undefined`. */
function storageFor(c: AppContext): StorageService {
  if (!c.env.FILES) {
    throw new ServiceUnavailableError('File storage is not configured', 'storage_not_configured')
  }
  return createR2Storage(c.env.FILES)
}

// ---- GET /api/files/:id ----------------------------------------------------------------

filesRouter.get('/:id', async c => {
  const { db, tenantId, auth, logger } = withAuthAndDb(c)
  guardPermission(c, 'read', 'File')
  const id = uuidParam(c, 'id')
  const row = await db.query.files.findFirst({
    where: and(eq(files.id, id), eq(files.tenantId, tenantId)),
  })
  if (!row) throw new NotFoundError('File not found')
  // A `documents`-scope object is the ORIGINAL behind a knowledge document, so it inherits
  // that document's visibility. Without this the restriction is one `/api/files/:id` away from
  // being nothing at all — the id is on the document card of anyone who ever could see it.
  if (
    row.scope === 'documents' &&
    !(await canReadOwningDocument(db, accessScopeOf(auth), row.id))
  ) {
    throw new NotFoundError('File not found')
  }

  const object = await storageFor(c).get(row.key)
  if (!object) {
    logger.warn({ fileId: row.id, key: row.key }, 'files: row exists but the object is missing')
    throw new NotFoundError('File not found')
  }

  // BEFORE the 304: a revalidation from inside the viewer's `<object>` must carry the relaxed
  // framing headers too, or the embed dies on its second view with nothing in the log.
  if (isEmbeddableMimeType(row.contentType)) c.set('embeddable', true)

  const headers: Record<string, string> = {
    'Cache-Control': 'private, max-age=3600',
    ETag: object.etag,
  }
  if (c.req.header('If-None-Match') === object.etag) {
    await object.body.cancel().catch(() => {})
    return c.body(null, 304, headers)
  }
  headers['Content-Type'] = row.contentType
  headers['Content-Length'] = String(object.size)
  // Images and PDFs render inline; everything else downloads, so a stored `text/html` or SVG can
  // never execute script on this origin. A PDF is safe because the browser hands it to its own
  // viewer, which does not run the file's script in this document's context.
  headers['Content-Disposition'] = isInlineMimeType(row.contentType)
    ? 'inline'
    : `attachment; filename="${row.filename.replace(/"/g, '')}"`
  return c.body(object.body, 200, headers)
})

// ---- DELETE /api/files/:id -------------------------------------------------------------

filesRouter.delete('/:id', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'read', 'File')
  const id = uuidParam(c, 'id')
  const row = await db.query.files.findFirst({
    where: and(eq(files.id, id), eq(files.tenantId, tenantId)),
  })
  if (!row) throw new NotFoundError('File not found')
  // A knowledge-base original belongs to its `documents` row: delete the document instead.
  if (row.scope === 'documents') {
    throw new ConflictError(
      'This file is the original of a knowledge document; delete the document instead',
      'owned_by_document'
    )
  }
  // "Owner or admin+": the uploader may always delete their own file; others need `delete File`.
  if (row.ownerUserId !== user.id && !can(c, 'delete', 'File')) {
    throw new ForbiddenError('You can only delete your own files')
  }

  await storageFor(c).delete(row.key)
  await db.delete(files).where(and(eq(files.id, row.id), eq(files.tenantId, tenantId)))
  if (user.avatarUrl === filePath(row.id)) {
    await db.update(users).set({ avatarUrl: null }).where(eq(users.id, user.id))
  }
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'file.deleted',
      subjectType: 'File',
      subjectId: row.id,
      metadata: { scope: row.scope, ownerUserId: row.ownerUserId },
    })
  )
  return c.body(null, 204)
})

/**
 * `/api/files` (D23): upload / download / delete over the `StorageService` seam. Objects live in
 * R2 under a tenant prefix; the `files` row is the index and the ONLY thing the browser can name
 * (`/api/files/:id`). Every query filters by the auth context's `tenantId` — a file uploaded in
 * one organisation is a 404 in another, including avatars (known gap: the person's `avatarUrl`
 * is global, the object is not). Bytes stream through the Worker with `Cache-Control: private`.
 *
 * `avatars` scope: image MIME allowlist, and the caller's `users.avatarUrl` is set to the new URL.
 * Anything not on the image allowlist is served as an attachment so a stored `text/html` can
 * never execute on this origin.
 */
import {
  AVATAR_MIME_TYPES,
  type FileScope,
  filePath,
  isAvatarMimeType,
  MAX_UPLOAD_BYTES,
  type StoredFile,
  uploadQuerySchema,
} from '@rocketflare/shared/files'
import { and, eq } from 'drizzle-orm'
import { type FileRow, files, users } from '../../db/schema'
import { uploadBodyLimit } from '../middleware/body-limit'
import { can, guardPermission } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import {
  buildStorageKey,
  createR2Storage,
  type StorageService,
  sanitizeFilename,
} from '../services/storage'
import type { AppContext } from '../types'
import {
  ApiError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const filesRouter = createRouter()

/** The R2 binding or a 503 — a deployment without `FILES` must fail loudly, not 500 on `undefined`. */
function storageFor(c: AppContext): StorageService {
  if (!c.env.FILES) {
    throw new ServiceUnavailableError('File storage is not configured', 'storage_not_configured')
  }
  return createR2Storage(c.env.FILES)
}

export function toStoredFile(row: FileRow): StoredFile {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerUserId: row.ownerUserId,
    scope: row.scope,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    url: filePath(row.id),
    createdAt: row.createdAt,
  }
}

/** Per-scope acceptance. `uploads` takes anything (served as attachment unless it is an image). */
function checkContentType(scope: FileScope, contentType: string): void {
  if (scope === 'avatars' && !isAvatarMimeType(contentType)) {
    throw new ApiError(
      415,
      'Avatars must be a PNG, JPEG, GIF or WebP image',
      'unsupported_media_type',
      {
        allowed: AVATAR_MIME_TYPES,
      }
    )
  }
}

// ---- POST /api/files?scope= --------------------------------------------------------------

filesRouter.post('/', uploadBodyLimit, validate('query', uploadQuerySchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'create', 'File')
  const { scope } = c.req.valid('query')
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
  const contentType = file.type || 'application/octet-stream'
  checkContentType(scope, contentType)

  const filename = sanitizeFilename(file.name || 'file')
  const key = buildStorageKey({ tenantId, scope, name: filename })
  // A Blob carries its length; R2 needs one (a bare stream does not).
  await storage.put(key, file, {
    contentType,
    metadata: { tenantId, ownerUserId: user.id, scope },
  })

  let row: FileRow | undefined
  try {
    ;[row] = await db
      .insert(files)
      .values({
        tenantId,
        ownerUserId: user.id,
        scope,
        key,
        filename,
        contentType,
        sizeBytes: file.size,
      })
      .returning()
    if (!row) throw new Error('files: insert returned no row')
    if (scope === 'avatars') {
      await db
        .update(users)
        .set({ avatarUrl: filePath(row.id) })
        .where(eq(users.id, user.id))
    }
  } catch (err) {
    // No orphaned objects: the row is the index, so without it the bytes must go too.
    await storage.delete(key).catch(() => {})
    throw err
  }

  const stored = row
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'file.uploaded',
      subjectType: 'File',
      subjectId: stored.id,
      metadata: { scope, contentType, sizeBytes: stored.sizeBytes, filename },
    })
  )
  return c.json(toStoredFile(stored), 201)
})

// ---- GET /api/files/:id ----------------------------------------------------------------

filesRouter.get('/:id', async c => {
  const { db, tenantId, logger } = withAuthAndDb(c)
  guardPermission(c, 'read', 'File')
  const id = uuidParam(c, 'id')
  const row = await db.query.files.findFirst({
    where: and(eq(files.id, id), eq(files.tenantId, tenantId)),
  })
  if (!row) throw new NotFoundError('File not found')

  const object = await storageFor(c).get(row.key)
  if (!object) {
    logger.warn({ fileId: row.id, key: row.key }, 'files: row exists but the object is missing')
    throw new NotFoundError('File not found')
  }

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
  // Images render inline; anything else downloads, so stored HTML/SVG never executes here.
  headers['Content-Disposition'] = isAvatarMimeType(row.contentType)
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

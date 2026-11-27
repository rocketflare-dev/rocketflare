/**
 * Uploads, direct to storage when the R2 key pair is set (opt-in), through the Worker otherwise:
 *
 *   createUpload    every check the target makes, then a `pending_uploads` row and a presigned
 *                   `PUT` over R2's S3 API with `content-type`, `content-length` and
 *                   `if-none-match: *` SIGNED — another type, another length or a second write to
 *                   the key is refused by the store itself.
 *   confirmUpload   resolves the row's target and bucket, then claims the row (compare-and-set on
 *                   `confirmed_at`, so once), `head`s the object, checks it against what was
 *                   declared, and hands it to the target. A mismatch or a target that throws
 *                   deletes the object and un-claims the row.
 *   receiveLocal    the fallback when there are no R2 keys: the URL is the Worker's own
 *                   (`PUT /api/upload-content/:id?token=`), which writes through the binding with a
 *                   conditional put (only if absent). Same headers, same checks, same confirm — the
 *                   client cannot tell — and spent once the upload is confirmed. Deployed, it takes
 *                   at most `MAX_WORKER_UPLOAD_BYTES` (the Worker holds the body).
 *   prunePendingUploads   the nightly sweep: an upload whose URL died unconfirmed loses its object,
 *                   and so does a confirmed core upload whose key no `files` row records.
 *
 * Tenancy: the key is built on the server under `tenants/<tenantId>/` (asserted for every target; a
 * plugin's under its own `tenants/<tenantId>/<pluginId>/`, naming the upload id), and no URL is
 * handed out for a key that already holds an object. Confirm finds the row by id AND the caller's
 * tenant AND user, so another tenant's upload id is the same 404 as an unknown one.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import {
  CORE_UPLOAD_TARGETS,
  type CreateUploadRequest,
  type CreateUploadResponse,
  createUploadRequestSchema,
  UPLOAD_URL_TTL_SECONDS,
} from '@rocketflare/shared/uploads'
import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm'
import { r2SigningCredentials } from '../../../config'
import type { Database } from '../../../db/client'
import { files, type PendingUploadRow, pendingUploads } from '../../../db/schema'
import type { AppContext } from '../../types'
import {
  ApiError,
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../utils/core/errors'
import { hashToken, safeEqual } from '../../utils/core/hash'
import { newId, randomToken } from '../../utils/core/ids'
import { withAuthAndDb } from '../../utils/routes/route-helpers'
import {
  createR2Storage,
  PURGE_PAGE_SIZE,
  type StorageService,
  sanitizeFilename,
  tenantStoragePrefix,
} from '../storage'
import { presignUrl } from './sigv4'
import { type UploadTarget, uploadTargets } from './targets'

/**
 * How long after the URL dies a confirm is still accepted: the store checks expiry when the `PUT`
 * STARTS, so a large file begun at the last second may land minutes later.
 */
export const UPLOAD_CONFIRM_GRACE_SECONDS = 15 * 60

/**
 * The most a DEPLOYED Worker takes through its own upload URL — today's 10 MB, what a body may be
 * when the isolate holds it. A target allowing more needs direct uploads (the R2 key pair) there;
 * `development` is a local machine and takes the target's own `maxBytes`.
 */
export const MAX_WORKER_UPLOAD_BYTES = 10 * 1024 * 1024

/**
 * The Worker fallback's mount — NOT under `/api/uploads`, whose mount is authed: the token is this
 * route's only credential, as the signature is R2's. `apiBodyLimit` lets its body past 1 MB.
 */
export const LOCAL_UPLOAD_PREFIX = '/api/upload-content'
export const localUploadPath = (uploadId: string) => `${LOCAL_UPLOAD_PREFIX}/${uploadId}`

const STORAGE_NOT_CONFIGURED = 'storage_not_configured'

/** `Image/PNG; charset=x` → `image/png`. */
export function normaliseContentType(value: string | null | undefined): string {
  return (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

function bucketOf(c: AppContext, target: Pick<UploadTarget, 'binding'>): R2Bucket {
  const bucket = (c.env as unknown as Record<string, R2Bucket | undefined>)[target.binding]
  if (!bucket) {
    throw new ServiceUnavailableError('File storage is not configured', STORAGE_NOT_CONFIGURED)
  }
  return bucket
}

function lookupTarget(id: string): UploadTarget {
  const target = uploadTargets().get(id)
  if (!target) {
    throw new BadRequestError(`Unknown upload target: ${id}`, ERROR_CODES.unknownUploadTarget)
  }
  return target
}

// ---- POST /api/uploads ---------------------------------------------------------------------------

export async function createUpload(
  c: AppContext,
  request: CreateUploadRequest
): Promise<CreateUploadResponse> {
  const body = createUploadRequestSchema.parse(request)
  const { db, tenantId, user, cfg } = withAuthAndDb(c)
  const target = lookupTarget(body.target)
  const bucket = bucketOf(c, target)

  const credentials = r2SigningCredentials(cfg)
  const bucketName = target.bucketName(c)
  const direct = Boolean(credentials && bucketName)
  const maxBytes =
    direct || cfg.APP_ENV === 'development'
      ? target.maxBytes
      : Math.min(target.maxBytes, MAX_WORKER_UPLOAD_BYTES)

  if (body.size === 0) throw new BadRequestError('The file is empty', 'file_empty')
  if (body.size > maxBytes) {
    throw new ApiError(
      413,
      maxBytes < target.maxBytes
        ? `File exceeds the ${maxBytes} byte limit for uploads through the Worker; larger files need direct uploads (docs/DEPLOY.md § Direct uploads)`
        : `File exceeds the ${maxBytes} byte limit`,
      'payload_too_large',
      { maxBytes, sizeBytes: body.size, ...(direct ? {} : { directUploads: false }) }
    )
  }

  const uploadId = newId()
  const filename = sanitizeFilename(body.name)
  const prepared = await target.prepare(c, {
    uploadId,
    tenantId,
    userId: user.id,
    filename,
    contentType: normaliseContentType(body.contentType),
    size: body.size,
    fields: body.fields ?? {},
  })
  if (!prepared.key.startsWith(tenantStoragePrefix(tenantId))) {
    throw new ApiError(
      500,
      `Upload target ${target.id} answered a storage key outside the tenant's prefix`,
      ERROR_CODES.uploadKeyInvalid
    )
  }
  // The failed confirm, the expiry and the prune delete this key: never sign one that holds an
  // object already. (Every key names a fresh upload id, so this is the backstop, not the rule.)
  if (await bucket.head(prepared.key)) {
    throw new ApiError(
      409,
      'A file is already stored under this upload key; start a new upload',
      ERROR_CODES.uploadKeyExists
    )
  }

  const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000)
  const headers = { 'Content-Type': prepared.contentType, 'If-None-Match': '*' }
  let url: string
  let tokenHash: string | null = null
  if (credentials && bucketName) {
    url = await presignUrl({
      method: 'PUT',
      origin: `https://${credentials.accountId}.r2.cloudflarestorage.com`,
      path: `/${bucketName}/${prepared.key}`,
      region: 'auto',
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      headers: { ...headers, 'Content-Length': String(body.size) },
    })
  } else {
    const token = randomToken()
    tokenHash = await hashToken(token)
    const local = new URL(localUploadPath(uploadId), cfg.APP_URL)
    local.searchParams.set('token', token)
    url = local.toString()
  }

  await db.insert(pendingUploads).values({
    id: uploadId,
    tenantId,
    userId: user.id,
    target: target.id,
    bucket: target.binding,
    key: prepared.key,
    filename,
    contentType: prepared.contentType,
    sizeBytes: body.size,
    state: prepared.state ?? {},
    tokenHash,
    expiresAt,
  })
  return { uploadId, method: 'PUT', url, headers, expiresAt }
}

// ---- POST /api/uploads/:id/confirm ---------------------------------------------------------------

const confirmDeadline = (row: Pick<PendingUploadRow, 'expiresAt'>) =>
  row.expiresAt.getTime() + UPLOAD_CONFIRM_GRACE_SECONDS * 1000

/** Give the claim back: a failed confirm leaves the row for the prune, never an orphaned key. */
async function unclaim(db: Database, row: PendingUploadRow): Promise<void> {
  await db
    .update(pendingUploads)
    .set({ confirmedAt: null })
    .where(and(eq(pendingUploads.id, row.id), eq(pendingUploads.tenantId, row.tenantId)))
}

export async function confirmUpload(
  c: AppContext,
  uploadId: string
): Promise<{ status: 200 | 201; body: unknown }> {
  const { db, tenantId, user, logger } = withAuthAndDb(c)
  const mine = and(
    eq(pendingUploads.id, uploadId),
    eq(pendingUploads.tenantId, tenantId),
    eq(pendingUploads.userId, user.id),
    isNull(pendingUploads.confirmedAt)
  )
  // Unknown, another tenant's, another person's and already-confirmed are the same answer.
  const pending = await db.query.pendingUploads.findFirst({ where: mine })
  if (!pending) throw new NotFoundError('Upload not found')
  // Everything that can refuse before the target runs is resolved BEFORE the claim: a target since
  // uninstalled or a bucket since unbound leaves the row unclaimed, for a retry or the prune.
  const target = lookupTarget(pending.target)
  const bucket = bucketOf(c, { binding: pending.bucket })
  const storage = createR2Storage(bucket)

  const [row] = await db
    .update(pendingUploads)
    .set({ confirmedAt: new Date() })
    .where(mine)
    .returning()
  // A concurrent confirm claimed it between the read and here.
  if (!row) throw new NotFoundError('Upload not found')

  const fail = async (err: ApiError): Promise<never> => {
    await storage.delete(row.key).catch(() => {})
    await unclaim(db, row)
    throw err
  }

  if (Date.now() > confirmDeadline(row)) {
    await fail(new ApiError(410, 'This upload has expired', ERROR_CODES.uploadExpired))
  }
  const object = await storage.head(row.key)
  if (!object) {
    await unclaim(db, row)
    throw new BadRequestError('Nothing has been uploaded yet', ERROR_CODES.uploadMissing)
  }
  if (
    object.size !== row.sizeBytes ||
    normaliseContentType(object.contentType) !== row.contentType
  ) {
    await fail(
      new BadRequestError('The uploaded file is not the one declared', ERROR_CODES.uploadMismatch, {
        declared: { sizeBytes: row.sizeBytes, contentType: row.contentType },
        received: { sizeBytes: object.size, contentType: object.contentType },
      })
    )
  }

  try {
    return await target.confirm(c, {
      uploadId: row.id,
      key: row.key,
      filename: row.filename,
      contentType: row.contentType,
      size: row.sizeBytes,
      state: row.state,
      bucket,
      storage,
    })
  } catch (err) {
    // A core target that got as far as its `files` row owns the object now; anything else is ours.
    const owned = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.tenantId, tenantId), eq(files.key, row.key)))
      .limit(1)
    if (owned.length === 0) {
      await storage.delete(row.key).catch(() => {})
      await unclaim(db, row).catch(error =>
        logger.warn({ err: error, uploadId }, 'uploads: could not un-claim a failed confirm')
      )
    }
    throw err
  }
}

// ---- PUT /api/upload-content/:id (the Worker fallback) -------------------------------------------

/**
 * The Worker's stand-in for R2's presigned `PUT`, offered when the R2 key pair is not set (in
 * `development`, and deployed up to `MAX_WORKER_UPLOAD_BYTES`), with the store's rules: the token
 * proves the URL, the URL dies at `expiresAt`, the `Content-Type` and `Content-Length` must be the
 * declared ones, and the key is written once (a conditional put). Stricter than R2 in one way: the
 * URL is spent once the upload is confirmed. The body is read whole — it is bounded by the declared
 * size, which the target already capped.
 */
export async function receiveLocalUpload(c: AppContext, uploadId: string): Promise<void> {
  const db = c.get('db')
  const token = c.req.query('token') ?? ''
  // Pre-auth: the token is the credential, exactly as a signature is on R2. The id narrows to one
  // row; the token hash must then match it.
  const row = await db.query.pendingUploads.findFirst({ where: eq(pendingUploads.id, uploadId) })
  if (!row?.tokenHash || !safeEqual(row.tokenHash, await hashToken(token))) {
    throw new ApiError(403, 'Invalid upload URL', 'forbidden')
  }
  if (Date.now() > row.expiresAt.getTime()) {
    throw new ApiError(403, 'This upload URL has expired', ERROR_CODES.uploadExpired)
  }
  // Spent once confirmed — even if the confirmed object was deleted since, which would let an
  // "only if absent" write through. A row whose uploader was deleted is spent too.
  if (row.confirmedAt || !row.userId) {
    throw new ApiError(403, 'This upload URL has already been used', 'forbidden')
  }
  const declaredLength = Number(c.req.header('Content-Length'))
  if (
    normaliseContentType(c.req.header('Content-Type')) !== row.contentType ||
    declaredLength !== row.sizeBytes
  ) {
    throw new ApiError(403, 'The request does not match the signed upload', 'forbidden')
  }
  if (c.req.header('If-None-Match') !== '*') {
    throw new ApiError(403, 'The request does not match the signed upload', 'forbidden')
  }
  const bucket = bucketOf(c, { binding: row.bucket })
  const bytes = await c.req.arrayBuffer()
  if (bytes.byteLength !== row.sizeBytes) {
    throw new ApiError(400, 'The body is not the declared length', ERROR_CODES.uploadMismatch)
  }
  // ONE conditional write, as `If-None-Match: *` is on R2's own URL: a check-then-write would let
  // two concurrent PUTs both pass the check. R2 answers `null` when an object is there.
  const written = await bucket.put(row.key, bytes, {
    httpMetadata: { contentType: row.contentType },
    onlyIf: { etagDoesNotMatch: '*' },
  })
  if (!written) throw new ApiError(412, 'The object already exists', 'precondition_failed')
}

// ---- nightly prune --------------------------------------------------------------------------------

const CORE_TARGET_IDS: readonly string[] = CORE_UPLOAD_TARGETS

/**
 * Uploads whose URL and confirm window are both over. An UNCONFIRMED one loses its object (it was
 * never recorded, or its confirm failed). A CONFIRMED one is forgotten, and for a core target its
 * object goes too when no `files` row records the key: a core confirm always records one (a
 * deduplicated document deletes its bytes instead), so an unrecorded key is a file deleted since,
 * re-written through its still-live R2 URL. A plugin's confirmed object is its own — the kit cannot
 * tell which of its rows records the key (CONCEPTS §6, known gaps). A confirmed row waits until its
 * claim is past the grace too, so a confirm still running is never pruned under. One statement
 * each across every tenant, from the `(tenant_id, expires_at)` index.
 */
export async function prunePendingUploads(
  db: Database,
  env: Cloudflare.Env,
  now = new Date()
): Promise<{ objects: number; rows: number }> {
  const cutoff = new Date(now.getTime() - UPLOAD_CONFIRM_GRACE_SECONDS * 1000)
  const stale = await db
    .delete(pendingUploads)
    .where(and(lt(pendingUploads.expiresAt, cutoff), isNull(pendingUploads.confirmedAt)))
    .returning({ bucket: pendingUploads.bucket, key: pendingUploads.key })
  const confirmed = await db
    .delete(pendingUploads)
    .where(
      and(
        lt(pendingUploads.expiresAt, cutoff),
        isNotNull(pendingUploads.confirmedAt),
        lt(pendingUploads.confirmedAt, cutoff)
      )
    )
    .returning({
      target: pendingUploads.target,
      bucket: pendingUploads.bucket,
      key: pendingUploads.key,
    })

  const unrecorded: { bucket: string; key: string }[] = []
  const core = confirmed.filter(row => CORE_TARGET_IDS.includes(row.target))
  for (let i = 0; i < core.length; i += PURGE_PAGE_SIZE) {
    const page = core.slice(i, i + PURGE_PAGE_SIZE)
    // By key alone: a key embeds its tenant's prefix and is unique across `files`.
    const recorded = await db
      .select({ key: files.key })
      .from(files)
      .where(
        inArray(
          files.key,
          page.map(row => row.key)
        )
      )
    const kept = new Set(recorded.map(row => row.key))
    unrecorded.push(...page.filter(row => !kept.has(row.key)))
  }

  const byBucket = new Map<string, string[]>()
  for (const { bucket, key } of [...stale, ...unrecorded]) {
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), key])
  }
  for (const [binding, keys] of byBucket) {
    const bucket = (env as unknown as Record<string, R2Bucket | undefined>)[binding]
    if (!bucket) continue
    const storage: StorageService = createR2Storage(bucket)
    for (let i = 0; i < keys.length; i += PURGE_PAGE_SIZE) {
      await storage.deleteMany(keys.slice(i, i + PURGE_PAGE_SIZE))
    }
  }
  return { objects: stale.length + unrecorded.length, rows: stale.length + confirmed.length }
}

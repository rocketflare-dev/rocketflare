/**
 * Object storage seam over the native `FILES` R2 binding (D23). Routes and services depend on
 * `StorageService`, never on `R2Bucket`, so a test can pass an in-memory bucket and an app can
 * swap the backend without touching callers. Keys are tenant-prefixed
 * (`tenants/<tenantId>/<scope>/<uuid>-<name>`) so one prefix scopes a whole tenant for listing
 * or bulk deletion; the UUID makes every key unique regardless of the client's filename.
 *
 * Bytes stream THROUGH the Worker on download (no presigned URLs — the binding cannot mint them).
 * `wrangler dev` emulates R2 locally, so there is no filesystem adapter.
 */
import {
  AVATAR_MIME_TYPES,
  type FileScope,
  isAvatarMimeType,
  MAX_UPLOAD_BYTES,
} from '@rocketflare/shared/files'
import { eq } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { type FileRow, files } from '../../db/schema'
import { newId } from '../utils/core/ids'

export { AVATAR_MIME_TYPES, isAvatarMimeType, MAX_UPLOAD_BYTES }

/** Bodies `put` accepts. Prefer a `Blob`/`ArrayBuffer`: R2 needs a known length, streams do not carry one. */
export type StorageBody = ArrayBuffer | ArrayBufferView | Blob | string

export interface PutOptions {
  contentType: string
  /** Free-form key/value pairs stored with the object (R2 `customMetadata`). */
  metadata?: Record<string, string>
}

export interface StoredObjectMeta {
  key: string
  size: number
  contentType: string
  /** Quoted, HTTP-ready — usable as an `ETag` header verbatim. */
  etag: string
  uploaded: Date
  metadata: Record<string, string>
}

export interface StoredObject extends StoredObjectMeta {
  body: ReadableStream<Uint8Array>
}

/** One page of a listing: the objects, and the cursor to resume from when there are more. */
export interface StorageListPage {
  objects: StoredObjectMeta[]
  /** `undefined` when this page is the last one. */
  cursor?: string
}

export interface StorageService {
  put(key: string, body: StorageBody, options: PutOptions): Promise<StoredObjectMeta>
  /** `null` when the key does not exist. The body is a one-shot stream. */
  get(key: string): Promise<StoredObject | null>
  head(key: string): Promise<StoredObjectMeta | null>
  /** Idempotent — deleting a missing key is not an error. */
  delete(key: string): Promise<void>
  /**
   * Delete a batch in ONE call (R2 takes up to 1 000 keys). A caller purging a prefix would
   * otherwise spend a subrequest per object, and a Worker invocation has a bounded supply of them.
   */
  deleteMany(keys: readonly string[]): Promise<void>
  /**
   * ONE page of a prefix. The paged form is the primitive and `list` is the convenience over it:
   * a bulk delete must never hold every key of a large tenant in a 128 MiB isolate at once.
   */
  listPage(prefix: string, options?: { cursor?: string; limit?: number }): Promise<StorageListPage>
  /** Every object under a prefix, accumulated. Fine for a bounded prefix; `listPage` otherwise. */
  list(prefix: string): Promise<StoredObjectMeta[]>
}

const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

function toMeta(obj: R2Object): StoredObjectMeta {
  return {
    key: obj.key,
    size: obj.size,
    contentType: obj.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE,
    etag: obj.httpEtag,
    uploaded: obj.uploaded,
    metadata: obj.customMetadata ?? {},
  }
}

/** The kit's `StorageService`: a thin adapter over the R2 binding. */
export function createR2Storage(bucket: R2Bucket): StorageService {
  return {
    async put(key, body, options) {
      const obj = await bucket.put(key, body, {
        httpMetadata: { contentType: options.contentType },
        customMetadata: options.metadata,
      })
      if (!obj) throw new Error(`storage.put: R2 returned no object for ${key}`)
      return toMeta(obj)
    },
    async get(key) {
      const obj = await bucket.get(key)
      if (!obj) return null
      return { ...toMeta(obj), body: obj.body }
    },
    async head(key) {
      const obj = await bucket.head(key)
      return obj ? toMeta(obj) : null
    },
    async delete(key) {
      await bucket.delete(key)
    },
    async deleteMany(keys) {
      if (keys.length === 0) return
      await bucket.delete([...keys])
    },
    async listPage(prefix, options) {
      const page = await bucket.list({ prefix, cursor: options?.cursor, limit: options?.limit })
      return {
        objects: page.objects.map(toMeta),
        cursor: page.truncated ? page.cursor : undefined,
      }
    },
    async list(prefix) {
      const out: StoredObjectMeta[] = []
      let cursor: string | undefined
      do {
        const page = await bucket.list({ prefix, cursor })
        for (const obj of page.objects) out.push(toMeta(obj))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return out
    },
  }
}

// ---- Keys --------------------------------------------------------------------------------

export const MAX_FILENAME_LENGTH = 120

/**
 * Reduce a client filename to ONE safe path segment: no separators or traversal, only
 * `[A-Za-z0-9._-]`, bounded length, never empty. The extension survives so `Content-Disposition`
 * downloads keep a sensible name.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+/, '')
  if (cleaned.length === 0) return 'file'
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : ''
  return `${cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length)}${ext}`
}

export interface StorageKeyInput {
  tenantId: string
  scope: FileScope
  /** The client's filename; sanitised here. */
  name: string
  /** Supplied by tests for determinism; defaults to a fresh UUID. */
  id?: string
}

/** `tenants/<tenantId>/<scope>/<uuid>-<sanitised name>`. */
export function buildStorageKey({ tenantId, scope, name, id }: StorageKeyInput): string {
  return `tenants/${tenantId}/${scope}/${id ?? newId()}-${sanitizeFilename(name)}`
}

/** Keys deleted per round trip. Under R2's 1 000-key `delete` cap, with room to spare. */
export const PURGE_PAGE_SIZE = 500

/** The prefix that scopes every object of a tenant (or one scope of it). */
export function tenantStoragePrefix(tenantId: string, scope?: FileScope): string {
  return scope ? `tenants/${tenantId}/${scope}/` : `tenants/${tenantId}/`
}

/**
 * Delete every object of a tenant, a page at a time, and answer how many went (D31 tenant purge).
 *
 * This is the other half of what the FK cascade does in Postgres: `tenants/<tenantId>/` is the one
 * prefix that scopes an organisation's bytes, which is exactly why keys carry it. It is
 * **idempotent by construction** — a second run lists nothing and deletes nothing — so the
 * `tenant.purge` job may be retried, and a run that dies halfway resumes from what is left rather
 * than from the beginning.
 *
 * Paged rather than `list()`-then-delete: a large tenant's whole key set must not be held in a
 * 128 MiB isolate, and one `deleteMany` per page keeps the subrequest count to two per page
 * instead of one per object.
 */
export async function purgeTenantObjects(
  storage: StorageService,
  tenantId: string,
  options: { limit?: number } = {}
): Promise<number> {
  const prefix = tenantStoragePrefix(tenantId)
  const limit = options.limit ?? PURGE_PAGE_SIZE
  let deleted = 0
  let cursor: string | undefined
  for (;;) {
    const page: StorageListPage = await storage.listPage(prefix, { cursor, limit })
    if (page.objects.length === 0) return deleted
    await storage.deleteMany(page.objects.map(o => o.key))
    deleted += page.objects.length
    cursor = page.cursor
    if (!cursor) return deleted
  }
}

// ---- Upload = object + row ---------------------------------------------------------------------

export interface StoreUploadInput {
  tenantId: string
  ownerUserId: string
  scope: FileScope
  /** The multipart part — a Blob carries its length, which R2 needs. */
  file: Blob
  /** The client's filename (sanitised here). */
  filename: string
  contentType: string
}

/**
 * Put the bytes under a tenant-scoped key, then insert the `files` row that is the ONLY thing the
 * browser can name. No orphaned objects: if the row cannot be written the object is deleted again.
 * Shared by `/api/files` (avatars, generic uploads) and `/api/ai/documents/upload` (originals).
 */
export async function storeUploadedFile(
  db: Database,
  storage: StorageService,
  input: StoreUploadInput
): Promise<FileRow> {
  const filename = sanitizeFilename(input.filename || 'file')
  const key = buildStorageKey({ tenantId: input.tenantId, scope: input.scope, name: filename })
  await storage.put(key, input.file, {
    contentType: input.contentType,
    metadata: { tenantId: input.tenantId, ownerUserId: input.ownerUserId, scope: input.scope },
  })
  try {
    const [row] = await db
      .insert(files)
      .values({
        tenantId: input.tenantId,
        ownerUserId: input.ownerUserId,
        scope: input.scope,
        key,
        filename,
        contentType: input.contentType,
        sizeBytes: input.file.size,
      })
      .returning()
    if (!row) throw new Error('files: insert returned no row')
    return row
  } catch (err) {
    await storage.delete(key).catch(() => {})
    throw err
  }
}

/** Delete an object and its row together (idempotent on both sides). Tenant predicate on the row. */
export async function deleteStoredFile(
  db: Database,
  storage: StorageService | null,
  row: Pick<FileRow, 'id' | 'key'>
): Promise<void> {
  if (storage) await storage.delete(row.key)
  await db.delete(files).where(eq(files.id, row.id))
}

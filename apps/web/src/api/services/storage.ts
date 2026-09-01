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

export interface StorageService {
  put(key: string, body: StorageBody, options: PutOptions): Promise<StoredObjectMeta>
  /** `null` when the key does not exist. The body is a one-shot stream. */
  get(key: string): Promise<StoredObject | null>
  head(key: string): Promise<StoredObjectMeta | null>
  /** Idempotent — deleting a missing key is not an error. */
  delete(key: string): Promise<void>
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

/** The prefix that scopes every object of a tenant (or one scope of it). */
export function tenantStoragePrefix(tenantId: string, scope?: FileScope): string {
  return scope ? `tenants/${tenantId}/${scope}/` : `tenants/${tenantId}/`
}

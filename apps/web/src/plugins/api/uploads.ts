/**
 * A plugin's upload target (`ServerPlugin.uploadTargets`): a kind of file people upload STRAIGHT
 * to one of the plugin's R2 buckets. The host owns the whole flow — `POST /api/uploads`, the
 * presigned `PUT`, `POST /api/uploads/:id/confirm`, the expiry and the nightly prune — and calls
 * the target at two points:
 *
 * - `prepare` runs before any byte is stored. Throw here for everything that would refuse the
 *   upload (permission, a site the caller cannot edit, a bad `fields`): the client gets the error
 *   and never a URL. Answer the object key (under `tenants/<tenantId>/`, which the host checks) and
 *   the `state` `confirm` will need.
 * - `confirm` runs once the object has arrived and its size and `Content-Type` match what was
 *   declared. Write your rows and answer the response body. If it throws, the host deletes the
 *   object; read a few bytes (`bucket.get(key, { range })`) here to sniff a type, never the whole.
 *
 * The host enforces `maxBytes` (413), `contentTypes` (415), an empty file (400) and the tenant
 * prefix; the store enforces the signed type, length and single write.
 */
import type { z } from 'zod'
import type { RequestCtx } from './http'

export interface PluginUploadPrepareInput<F = unknown> {
  /** The upload's id — unique, so a key built from it never collides. */
  uploadId: string
  /** The client's filename, sanitised to one safe path segment. */
  filename: string
  /** The declared `Content-Type`, lowercased, parameters dropped. */
  contentType: string
  size: number
  /** `fields`, parsed by the target's schema. */
  fields: F
}

export interface PluginUploadPrepared {
  /** Defaults to `tenants/<tenantId>/<pluginId>/<uploadId>-<filename>`. */
  key?: string
  /** A canonical type to sign instead of the declared one (the client is told to send it). */
  contentType?: string
  /** JSON carried to `confirm` — never trust the client for it there. */
  state?: Record<string, unknown>
}

export interface PluginConfirmedUpload {
  uploadId: string
  key: string
  filename: string
  contentType: string
  size: number
  state: Record<string, unknown>
  /** The target's bucket — the object is in it. */
  bucket: R2Bucket
}

export interface PluginUploadTarget<F = unknown> {
  /** `<pluginId>.<name>` — what the client sends as `target`. */
  id: string
  /**
   * Omitted: the kit's `FILES` bucket, the one `ctx.storage()` reads (so `tenant.purge` covers it).
   * A bucket of the plugin's own: its R2 binding (declared in BOTH tomls) and the bucket's S3 name
   * — the binding cannot tell the Worker its own name, so the plugin reads it from a var of its own.
   */
  bucket?: {
    binding: string
    name: (env: Cloudflare.Env) => string | undefined
  }
  /** The largest file accepted, in bytes. */
  maxBytes: number
  /** Accepted types (exact, lowercase); omitted = any type. */
  contentTypes?: readonly string[]
  /** Validates the request's `fields`; omitted = `fields` must be absent or empty. */
  fields?: z.ZodType<F>
  prepare?(ctx: RequestCtx, input: PluginUploadPrepareInput<F>): Promise<PluginUploadPrepared>
  confirm(
    ctx: RequestCtx,
    upload: PluginConfirmedUpload
  ): Promise<{ status?: 200 | 201; body: unknown }>
}

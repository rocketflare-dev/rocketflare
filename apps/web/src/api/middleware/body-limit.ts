/**
 * Request body caps. Cloudflare already caps bodies at 100–500 MB; 1 MB of JSON is plenty
 * for every core route and protects the DB/LLM paths. The upload routes (`/api/files` and
 * `/api/ai/documents/upload`) are the exceptions: they get `MAX_UPLOAD_BYTES` plus multipart
 * overhead, and each handler enforces the exact per-file limit. A plugin's public mount may declare
 * its own `bodyLimitBytes` (≤ `MAX_PUBLIC_MOUNT_BODY_BYTES`), which REPLACES the 1 MB cap beneath
 * its prefix. Hono's `bodyLimit` counts bytes whatever the content type, so a cap covers JSON,
 * form-encoded and `application/scim+json` alike. Over-limit → 413 in the shared envelope.
 */
import { MAX_UPLOAD_BYTES } from '@rocketflare/shared/files'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

export const MAX_JSON_BODY_BYTES = 1024 * 1024

/** Multipart boundaries + part headers; a legitimate 5 MB file must not trip the transport cap. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024

const tooLarge = (c: Context) =>
  c.json({ error: 'Request body too large', statusCode: 413, code: 'payload_too_large' }, 413)

export const jsonBodyLimit = bodyLimit({ maxSize: MAX_JSON_BODY_BYTES, onError: tooLarge })

export const uploadBodyLimit = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES,
  onError: tooLarge,
})

/** Paths that mount `uploadBodyLimit` themselves and must be skipped by the JSON cap. */
export const UPLOAD_PATHS = ['/api/files', '/api/ai/documents/upload'] as const

export function isUploadPath(pathname: string): boolean {
  return UPLOAD_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

/** The most a public mount may ask for: a SCIM bulk request or a signed SAML POST, not a file. */
export const MAX_PUBLIC_MOUNT_BODY_BYTES = 10 * 1024 * 1024

/** `pathname` is `prefix` or beneath it — `/api/hooks/a` never claims `/api/hooks/ab`. */
export function isUnderPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** A prefix that replaces the JSON cap with its own — a public mount's `bodyLimitBytes`. */
export interface BodyLimitOverride {
  prefix: string
  maxBytes: number
}

/**
 * The `/api/*` body cap (middleware step 5): the upload paths, core's and a plugin's
 * `uploadPaths`, skip it (they mount their own on the route), an override prefix gets its own cap — the longest matching prefix wins, clamped to
 * `MAX_PUBLIC_MOUNT_BODY_BYTES` — and everything else gets `jsonBodyLimit`.
 */
export function apiBodyLimit(
  overrides: readonly BodyLimitOverride[] = [],
  pluginUploadPaths: readonly string[] = []
): MiddlewareHandler {
  const limits = [...overrides]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .map(o => ({
      prefix: o.prefix,
      limit: bodyLimit({
        maxSize: Math.min(Math.max(0, o.maxBytes), MAX_PUBLIC_MOUNT_BODY_BYTES),
        onError: tooLarge,
      }),
    }))
  return (c, next) => {
    const path = c.req.path
    if (isUploadPath(path) || pluginUploadPaths.some(p => isUnderPrefix(path, p))) return next()
    const own = limits.find(l => isUnderPrefix(path, l.prefix))
    return (own?.limit ?? jsonBodyLimit)(c, next)
  }
}

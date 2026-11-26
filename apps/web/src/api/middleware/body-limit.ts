/**
 * Request body caps. Cloudflare already caps bodies at 100–500 MB; 1 MB of JSON is plenty for
 * every route and protects the DB/LLM paths. **No core route takes a file**: uploads go through
 * `/api/uploads` (`services/uploads`), straight to storage when the R2 key pair is set. Without it,
 * the file comes to the Worker's own `PUT /api/upload-content/:id`, whose cap is picked per request:
 * the largest target's `maxBytes` in `development`, `MAX_WORKER_UPLOAD_BYTES` (10 MB) deployed —
 * the route then holds the body to the exact declared length.
 *
 * A plugin's public mount may declare its own `bodyLimitBytes` (≤ `MAX_PUBLIC_MOUNT_BODY_BYTES`),
 * which REPLACES the 1 MB cap beneath its prefix.
 *
 * **Deprecated plugin seam, kept so an installed plugin's upload route keeps working** until it
 * moves to `uploadTargets`: beneath a plugin's `uploadPaths` a NON-JSON body gets
 * `MAX_UPLOAD_PATH_BODY_BYTES` (10 MB + 64 KB multipart overhead) and a JSON body keeps 1 MB; a
 * plugin's `uploadLimits` names EXACT paths whose non-JSON body may go higher, up to
 * `MAX_PLUGIN_UPLOAD_LIMIT_BYTES` (50 MiB) plus overhead — checked first, for that path alone.
 *
 * Hono's `bodyLimit` counts bytes whatever the content type, so a cap covers JSON, form-encoded
 * and `application/scim+json` alike. Over-limit → 413 in the shared envelope.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

export const MAX_JSON_BODY_BYTES = 1024 * 1024

/** Multipart boundaries + part headers, for a plugin's deprecated multipart upload route. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024

/**
 * The most a public mount may ask for: a SCIM bulk request or a signed SAML POST, not a file.
 * Also the largest file a plugin's deprecated `uploadPaths` route may take.
 */
export const MAX_PUBLIC_MOUNT_BODY_BYTES = 10 * 1024 * 1024

const tooLarge = (c: Context) =>
  c.json({ error: 'Request body too large', statusCode: 413, code: 'payload_too_large' }, 413)

export const jsonBodyLimit = bodyLimit({ maxSize: MAX_JSON_BODY_BYTES, onError: tooLarge })

/**
 * @deprecated with `ServerPlugin.uploadPaths`: what a non-JSON body beneath a plugin's upload
 * prefix may carry before its route sees it. The route's own limit is the real one.
 */
export const MAX_UPLOAD_PATH_BODY_BYTES = MAX_PUBLIC_MOUNT_BODY_BYTES + MULTIPART_OVERHEAD_BYTES

/**
 * @deprecated with `ServerPlugin.uploadLimits`: the most an exact plugin upload path may ask for
 * (the Worker holds the whole body in memory). Values above it are clamped, and
 * `tests/config/plugins.test.ts` refuses them.
 */
export const MAX_PLUGIN_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024

/** One exact path with its own non-JSON cap — a plugin's (deprecated) `uploadLimits` entry. */
export interface UploadLimit {
  path: string
  maxBytes: number
}

/** `uploadLimits` records from every plugin, as the list `apiBodyLimit` takes. */
export function pluginUploadLimits(
  plugins: readonly { uploadLimits?: Readonly<Record<string, number>> }[]
): UploadLimit[] {
  return plugins.flatMap(p =>
    Object.entries(p.uploadLimits ?? {}).map(([path, maxBytes]) => ({ path, maxBytes }))
  )
}

/** `application/json`, `application/<x>+json` — a body a JSON route parses. */
function isJsonBody(c: Context): boolean {
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'))
}

/** `pathname` is `prefix` or beneath it — `/api/hooks/a` never claims `/api/hooks/ab`. */
export function isUnderPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** A prefix that replaces the JSON cap with its own — a public mount's `bodyLimitBytes`. */
export interface BodyLimitOverride {
  prefix: string
  maxBytes: number
}

/** The Worker's upload URL: its prefix and, per request, the largest body it may take. */
export interface WorkerUploadLimit {
  prefix: string
  maxBytes: (c: Context) => number
}

export interface ApiBodyLimitOptions {
  overrides?: readonly BodyLimitOverride[]
  workerUpload?: WorkerUploadLimit
  /** @deprecated — `ServerPlugin.uploadPaths`. */
  pluginUploadPaths?: readonly string[]
  /** @deprecated — `ServerPlugin.uploadLimits`. */
  uploadLimits?: readonly UploadLimit[]
}

/**
 * The `/api/*` body cap (middleware step 5), first match wins: an exact `uploadLimits` path (its
 * cap for a non-JSON body, clamped); beneath a plugin's `uploadPaths`,
 * `MAX_UPLOAD_PATH_BODY_BYTES` for a non-JSON body; beneath the Worker upload prefix, its
 * per-request cap; beneath an override prefix, its own cap — the longest matching prefix wins,
 * clamped to `MAX_PUBLIC_MOUNT_BODY_BYTES`; everything else (and every JSON body) `jsonBodyLimit`.
 */
export function apiBodyLimit(options: ApiBodyLimitOptions = {}): MiddlewareHandler {
  const { overrides = [], workerUpload, pluginUploadPaths = [], uploadLimits = [] } = options
  const exact = new Map(
    uploadLimits.map(u => [
      u.path,
      bodyLimit({
        maxSize:
          Math.min(Math.max(0, u.maxBytes), MAX_PLUGIN_UPLOAD_LIMIT_BYTES) +
          MULTIPART_OVERHEAD_BYTES,
        onError: tooLarge,
      }),
    ])
  )
  const uploadPathLimit = bodyLimit({ maxSize: MAX_UPLOAD_PATH_BODY_BYTES, onError: tooLarge })
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
    const sized = exact.get(path)
    if (sized) return (isJsonBody(c) ? jsonBodyLimit : sized)(c, next)
    if (pluginUploadPaths.some(p => isUnderPrefix(path, p))) {
      return (isJsonBody(c) ? jsonBodyLimit : uploadPathLimit)(c, next)
    }
    if (workerUpload && isUnderPrefix(path, workerUpload.prefix)) {
      const maxSize = Math.max(0, workerUpload.maxBytes(c))
      return bodyLimit({ maxSize, onError: tooLarge })(c, next)
    }
    const own = limits.find(l => isUnderPrefix(path, l.prefix))
    return (own?.limit ?? jsonBodyLimit)(c, next)
  }
}

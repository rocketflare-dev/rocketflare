/**
 * Request body caps (04 §4). Cloudflare already caps bodies at 100–500 MB; 1 MB of JSON is plenty
 * for every kit route and protects the DB/LLM paths. The upload route (`/api/files`, D23) is the
 * one exception: it gets `MAX_UPLOAD_BYTES` plus multipart overhead, and the handler enforces the
 * exact per-file limit. Over-limit → 413 in the shared envelope.
 */
import { MAX_UPLOAD_BYTES } from '@rocketflare/shared/files'
import type { Context } from 'hono'
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
export const UPLOAD_PATHS = ['/api/files'] as const

export function isUploadPath(pathname: string): boolean {
  return UPLOAD_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

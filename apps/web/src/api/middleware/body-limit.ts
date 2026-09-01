/**
 * Request body cap for `/api/*` and `/auth/*` (04 §4). Cloudflare already caps bodies at
 * 100–500 MB; 1 MB of JSON is plenty for every kit route and protects the DB/LLM paths.
 * Over-limit → 413 in the shared envelope. File uploads (Phase 2, R2) mount their own limit.
 */
import { bodyLimit } from 'hono/body-limit'

export const MAX_JSON_BODY_BYTES = 1024 * 1024

export const jsonBodyLimit = bodyLimit({
  maxSize: MAX_JSON_BODY_BYTES,
  onError: c =>
    c.json({ error: 'Request body too large', statusCode: 413, code: 'payload_too_large' }, 413),
})

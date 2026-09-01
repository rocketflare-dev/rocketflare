/**
 * Identifiers and random tokens via WebCrypto only (D12: no `node:crypto`). Works identically
 * in workerd, Node 24 and the browser bundle.
 */

/** A v4 UUID — the same shape Postgres `gen_random_uuid()` produces for primary keys. */
export function newId(): string {
  return crypto.randomUUID()
}

/** Cryptographically random bytes. */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/** RFC 4648 §5 base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * An opaque URL-safe token: `bytes` of entropy (default 32 = 256 bits) as base64url. Used for
 * session ids, magic-link and invitation tokens, API keys (Phase 1).
 */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes))
}

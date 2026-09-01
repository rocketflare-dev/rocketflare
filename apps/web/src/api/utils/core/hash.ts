/**
 * One-way hashing for credentials at rest (D12): session cookies, magic-link and invitation
 * tokens, API keys are all stored as SHA-256 hex of a random token, so a database read never
 * yields something usable. WebCrypto only — identical in workerd, Node 24 and the browser bundle.
 */
import { randomToken } from './ids'

const encoder = new TextEncoder()

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 of `token`, lower-case hex (64 chars). Deterministic; safe to use in a WHERE clause. */
export async function hashToken(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(token)))
}

/** Constant-time string equality for comparing two hashes (defensive; hashes are equal-length). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Default API-key prefix; parameterised, never from env (01 §6). */
export const API_KEY_PREFIX = 'rocketflare'
/** Characters of the plaintext kept as the human-readable handle in lists (`rocketflare_ab12cd34`). */
export const API_KEY_PREFIX_LENGTH = 20 // `rocketflare_` (12) + 8 chars — must exceed the prefix + `_`

export interface GeneratedApiKey {
  /** Plaintext — shown to the user ONCE, never stored. */
  key: string
  keyHash: string
  keyPrefix: string
}

/** `rocketflare_<43 base64url chars>`; stored as `{ keyHash, keyPrefix }`, returned as `key` once. */
export async function generateApiKey(prefix = API_KEY_PREFIX): Promise<GeneratedApiKey> {
  const key = `${prefix}_${randomToken(32)}`
  return { key, keyHash: await hashToken(key), keyPrefix: key.slice(0, API_KEY_PREFIX_LENGTH) }
}

/**
 * A tenant's credentials at rest, as a plugin stores them (D12, D31).
 *
 * The same AES-256-GCM the kit uses for OAuth tokens and `ai_configs.api_key_enc`, keyed by
 * `OAUTH_ENCRYPTION_KEY` — so a copy that rotates that key rotates every sealed value with it, and
 * a plugin never ships crypto of its own. The rules are the kit's:
 *
 * - **Store the sealed string, in a `*_enc` column.** Never the plaintext, not even briefly.
 * - **Never return it.** A route answers `hasCredential: row.keyEnc !== null`, and the browser
 *   learns nothing more; to change a key the reader supplies a new one.
 * - **Open it at the last moment**, where the outbound call is made — a tool's handler, not the
 *   `agentTools` builder that runs on every turn whether or not the tool is called.
 *
 * No `OAUTH_ENCRYPTION_KEY` → 503 `encryption_key_missing`, on both sides. There is no plaintext
 * fallback, deliberately.
 */

import { decrypt, encrypt } from '../../api/auth/oauth-encryption'
import { ServiceUnavailableError } from '../../api/utils/core/errors'
import type { PluginConfig } from './types'

function encryptionKey(config: PluginConfig): string {
  if (!config.OAUTH_ENCRYPTION_KEY) {
    throw new ServiceUnavailableError(
      'OAUTH_ENCRYPTION_KEY is not configured; credentials cannot be stored or read',
      'encryption_key_missing'
    )
  }
  return config.OAUTH_ENCRYPTION_KEY
}

/** Encrypt a credential for storage. The output is opaque base64; keep it in a `*_enc` column. */
export async function sealSecret(config: PluginConfig, plaintext: string): Promise<string> {
  return encrypt(plaintext, encryptionKey(config))
}

/** Decrypt what `sealSecret` produced. Throws on a value sealed under another key. */
export async function openSecret(config: PluginConfig, sealed: string): Promise<string> {
  return decrypt(sealed, encryptionKey(config))
}

// ---- Signed state ------------------------------------------------------------------------------

/**
 * A short-lived, tamper-evident token a plugin hands to a third party and gets back — the `state`
 * of an admin-consent round-trip, a webhook's per-subscription secret (D34).
 *
 * Why not a cookie, as the kit's own login does: a consent redirect may come back in a different
 * browser from the one that started it (an admin forwarded the link), and a webhook has no browser
 * at all. So the binding (`tenantId`, `userId`, whatever the plugin needs) travels IN the token,
 * and the signature is what makes it trustworthy. It is signed, NOT encrypted — never put a
 * secret in `payload`; the third party can read it.
 *
 * - `purpose` is part of the signed body and checked on the way back, so a token minted for one
 *   flow (`m365:consent`) can never be replayed into another (`m365:webhook`).
 * - Expiry is absolute (`ttlSeconds`, default 10 minutes, the same as the login flow's cookie).
 * - `verifyState` answers `null` for EVERY failure — bad signature, wrong purpose, expired,
 *   malformed — so a route cannot leak which one to a caller probing it. Log it if you need to.
 *
 * The HMAC key is HKDF-derived from `OAUTH_ENCRYPTION_KEY`, never the AES key itself: one secret,
 * two keys that cannot be confused. Rotating it invalidates every token in flight, which at a ten
 * minute lifetime is the right price.
 */

const STATE_KEY_INFO = 'rocketflare:signed-state:v1'
const DEFAULT_STATE_TTL_SECONDS = 600

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  return Uint8Array.from(atob(padded), ch => ch.charCodeAt(0))
}

async function stateKey(config: PluginConfig): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(encryptionKey(config)),
    'HKDF',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(STATE_KEY_INFO),
    },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify']
  )
}

/** Sign `payload` for `purpose`. The result is URL-safe: `<body>.<signature>`, both base64url. */
export async function signState(
  config: PluginConfig,
  purpose: string,
  payload: Record<string, unknown>,
  opts: { ttlSeconds?: number } = {}
): Promise<string> {
  const key = await stateKey(config)
  const exp = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? DEFAULT_STATE_TTL_SECONDS)
  const body = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ ...payload, p: purpose, exp }))
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return `${body}.${toBase64Url(sig)}`
}

/**
 * The payload `signState` signed for this `purpose`, or `null`. `p` and `exp` are stripped, so the
 * caller gets back exactly what it put in. Parse the result with zod before trusting its SHAPE —
 * the signature proves who wrote it, not that an older release wrote the fields you expect.
 */
export async function verifyState<T = Record<string, unknown>>(
  config: PluginConfig,
  purpose: string,
  token: string
): Promise<T | null> {
  const key = await stateKey(config)
  const [body, sig, extra] = token.split('.')
  if (!body || !sig || extra !== undefined) return null
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64Url(sig),
      new TextEncoder().encode(body)
    )
    if (!ok) return null
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as unknown
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null
    const { p, exp, ...payload } = decoded as Record<string, unknown>
    if (p !== purpose || typeof exp !== 'number' || exp < Math.floor(Date.now() / 1000)) return null
    return payload as T
  } catch {
    return null
  }
}

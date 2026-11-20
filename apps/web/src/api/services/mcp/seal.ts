/**
 * Sealing a refresh token's successor under the token itself.
 *
 * A refresh rotates: the presented token is spent and a new pair is issued. If the client's
 * request succeeded but the answer was lost (a dropped connection, a timeout), it retries with the
 * token it still holds — now spent — and a strict server would treat that as theft and kill the
 * connection. The retry grace answers it with the SAME successor pair instead. Only hashes of
 * tokens are stored, so the successor's plaintext has to be kept some other way for those
 * seconds; it is sealed (AES-256-GCM) under a key derived (HKDF-SHA-256) from the SPENT token's
 * plaintext — which the database never sees.
 *
 * What that buys: a database reader gets ciphertext it cannot open (it holds only the spent
 * token's SHA-256, and the key is derived with HKDF under its own salt and label, not the hash);
 * the only party who can open it is one presenting the spent token, which is exactly the party
 * the grace exists for. A thief holding a stolen spent token inside the same window gets the pair
 * too — that is the cost of any retry grace, which is why it is seconds long and why the sealed
 * value is cleared after it. No server secret is involved, so there is nothing new to provision
 * or rotate.
 */
import { toBase64Url } from '../../utils/core/ids'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const SALT = encoder.encode('mcp-refresh-successor-v1')
const INFO = encoder.encode('seal')

async function keyFrom(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, ch => ch.charCodeAt(0))
}

/** `<iv>.<ciphertext>`, both base64url. */
export async function sealWith(secret: string, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await keyFrom(secret),
    encoder.encode(JSON.stringify(payload))
  )
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`
}

/** The payload, or null when `sealed` was not sealed under `secret` (or is malformed). */
export async function openWith<T>(secret: string, sealed: string): Promise<T | null> {
  const [iv, ct] = sealed.split('.')
  if (!iv || !ct) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(iv) },
      await keyFrom(secret),
      fromBase64Url(ct)
    )
    return JSON.parse(decoder.decode(plain)) as T
  } catch {
    return null
  }
}

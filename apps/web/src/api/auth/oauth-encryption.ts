/**
 * AES-256-GCM for OAuth tokens at rest (D12). Format `base64(iv ‖ ciphertext ‖ tag)`, 12-byte IV.
 * `OAUTH_ENCRYPTION_KEY` is REQUIRED for any write — there is no plaintext pass-through (the Node
 * reference app had one; it is exactly the kind of "dev convenience" that ships). The key may be a
 * base64 32-byte value or any ≥32-char string (SHA-256-derived), so `openssl rand -hex 32` works.
 * Web Crypto only.
 */
import type { AppConfig } from '../../config'
import { ServiceUnavailableError } from '../utils/core/errors'

const IV_LENGTH = 12
const TAG_LENGTH = 16

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), ch => ch.charCodeAt(0))
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

async function importKey(key: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  let material: ArrayBuffer
  try {
    const decoded = fromBase64(key)
    if (decoded.length !== 32) throw new Error('not a 32-byte key')
    material = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + 32) as ArrayBuffer
  } catch {
    material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  }
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [usage])
}

export async function encrypt(plaintext: string, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const cryptoKey = await importKey(key, 'encrypt')
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      new TextEncoder().encode(plaintext)
    )
  )
  const out = new Uint8Array(IV_LENGTH + sealed.length)
  out.set(iv, 0)
  out.set(sealed, IV_LENGTH)
  return toBase64(out)
}

export async function decrypt(encrypted: string, key: string): Promise<string> {
  const data = fromBase64(encrypted)
  if (data.length < IV_LENGTH + TAG_LENGTH) throw new Error('Invalid ciphertext: too short')
  const cryptoKey = await importKey(key, 'decrypt')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.slice(0, IV_LENGTH) },
    cryptoKey,
    data.slice(IV_LENGTH)
  )
  return new TextDecoder().decode(plain)
}

/** The configured key, or a 503 `oauth_encryption_key_missing` — checked at USE time (D3). */
export function requireEncryptionKey(cfg: AppConfig): string {
  if (!cfg.OAUTH_ENCRYPTION_KEY) {
    throw new ServiceUnavailableError(
      'OAUTH_ENCRYPTION_KEY is not configured; OAuth login is unavailable',
      'oauth_encryption_key_missing'
    )
  }
  return cfg.OAUTH_ENCRYPTION_KEY
}

/** Null-safe wrappers used by the provider link writes. */
export async function encryptToken(cfg: AppConfig, token: string | null | undefined) {
  if (token === null || token === undefined) return null
  return encrypt(token, requireEncryptionKey(cfg))
}

export async function decryptToken(cfg: AppConfig, encrypted: string | null | undefined) {
  if (encrypted === null || encrypted === undefined) return null
  return decrypt(encrypted, requireEncryptionKey(cfg))
}

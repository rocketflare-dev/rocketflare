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

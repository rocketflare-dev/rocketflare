/**
 * Verifying a Standard Webhooks request (https://www.standardwebhooks.com/), the signing scheme the
 * OIDC issuer's identity events use (`routes/identity-events.ts`):
 *
 *   webhook-id:        the event id, the same on every retry
 *   webhook-timestamp: Unix seconds when this attempt was signed
 *   webhook-signature: `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`, space-separated
 *
 * The secret is `whsec_` and the base64 of the HMAC key. During a rotation the sender signs with the
 * old and the new secret, so a request carries two signatures and either verifies. A timestamp more
 * than five minutes from this server's clock is refused, which bounds a replay. Web Crypto only.
 */

/** How far `webhook-timestamp` may be from this server's clock. */
export const WEBHOOK_TOLERANCE_S = 5 * 60

const SECRET_PREFIX = 'whsec_'

/** Base64 to bytes with `atob` (no `Buffer` in a Worker); null when it is not valid base64. */
function base64Bytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** The `webhook-*` headers of a request, or null when one is missing. */
export function webhookHeaders(get: (name: string) => string | undefined) {
  const id = get('webhook-id')
  const timestamp = get('webhook-timestamp')
  const signature = get('webhook-signature')
  return id && timestamp && signature ? { id, timestamp, signature } : null
}

/** True when the body was signed with `secret` in the last five minutes (either way of `now`). */
export async function verifyStandardWebhook(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
  now: Date = new Date()
): Promise<boolean> {
  if (!secret.startsWith(SECRET_PREFIX)) return false
  if (!/^\d+$/.test(headers.timestamp)) return false
  const secretKey = base64Bytes(secret.slice(SECRET_PREFIX.length))
  if (!secretKey || secretKey.length === 0) return false
  const timestamp = Number(headers.timestamp)
  if (Math.abs(now.getTime() / 1000 - timestamp) > WEBHOOK_TOLERANCE_S) return false
  const key = await crypto.subtle.importKey(
    'raw',
    secretKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const content = new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${body}`)
  for (const entry of headers.signature.split(' ')) {
    const [version, value] = entry.split(',')
    if (version !== 'v1' || !value) continue
    const given = base64Bytes(value)
    if (!given) continue
    // `verify` compares in constant time.
    if (await crypto.subtle.verify('HMAC', key, given, content)) return true
  }
  return false
}

/**
 * The ONE redaction seam of the provisioning tooling. Every line the orchestrator prints, every
 * child-process output it echoes and every vendor response it debugs passes through `redact()`
 * first, so a connection string, a Resend `re_*` key, a Neon `napi_*` key, a bearer token or a
 * 40+ hex secret can never reach the terminal or a log file. Hyperdrive / KV ids are 32 hex and
 * stay readable on purpose — they are committed to the tomls.
 *
 * `sanitizeNeon()` strips the credential-bearing fields Neon puts in its responses
 * (`connection_uris[]`, `roles[].password`, `role.password`, `password`) BEFORE a payload is
 * handed to a debug printer; the values are still returned to the caller that asked for them.
 *
 * `registerSecrets()` adds EXACT values to the mask list — the tokens `config.ts` resolves from
 * the environment or `apps/web/.provision.env` — because a Cloudflare API token (40 chars of
 * base62) matches none of the shape patterns below unless it follows the header we set ourselves.
 */

const MASK = '<redacted>'

const REGISTERED: Set<string> = new Set()

/** Mask these exact values from now on (values shorter than 8 characters are ignored). */
export function registerSecrets(values: Iterable<string | undefined>): void {
  for (const v of values) if (v && v.length >= 8) REGISTERED.add(v)
}

/** Test seam. */
export function clearRegisteredSecrets(): void {
  REGISTERED.clear()
}

export const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // postgres://user:pass@host/db and postgresql://… — the whole URL goes, host included; the
  // orchestrator prints hosts through their own field, never through a URL.
  { name: 'postgres-url', pattern: /postgres(?:ql)?:\/\/[^\s"'`<>]+/g },
  { name: 'resend-key', pattern: /\bre_[A-Za-z0-9_-]{8,}/g },
  { name: 'neon-key', pattern: /\bnapi_[A-Za-z0-9_-]{8,}/g },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g },
  // 40+ hex: OAUTH_ENCRYPTION_KEY (64), Cloudflare API tokens are not hex but 40+ hex catches
  // AWS-style and generated keys. 32-hex resource ids deliberately survive.
  { name: 'long-hex', pattern: /\b[0-9a-fA-F]{40,}\b/g },
  // Cloudflare API tokens: 40 chars of [A-Za-z0-9_-] following the header we set ourselves.
  { name: 'cf-token-header', pattern: /(X-Auth-Key|CLOUDFLARE_API_TOKEN)[=:]\s*\S+/g },
]

/** Mask every secret-looking substring in `text`. Plain text is returned untouched. */
export function redact(text: string): string {
  let out = text
  for (const v of REGISTERED) out = out.split(v).join(MASK)
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (name === 'bearer') out = out.replace(pattern, `Bearer ${MASK}`)
    else if (name === 'cf-token-header') out = out.replace(pattern, `$1=${MASK}`)
    else out = out.replace(pattern, MASK)
  }
  return out
}

const NEON_SECRET_KEYS = new Set(['connection_uris', 'password', 'connection_uri'])

/**
 * Deep-copy a Neon API payload with every credential-bearing field removed. Safe on any JSON
 * value; arrays and nested objects are walked, primitives are returned as-is.
 */
export function sanitizeNeon<T>(value: T): T {
  if (Array.isArray(value)) return value.map(v => sanitizeNeon(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (NEON_SECRET_KEYS.has(k)) continue
      out[k] = sanitizeNeon(v)
    }
    return out as T
  }
  return value
}

/** `JSON.stringify` for debug output: sanitised first, then redacted as text. */
export function safeJson(value: unknown): string {
  return redact(JSON.stringify(sanitizeNeon(value), null, 2))
}

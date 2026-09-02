/**
 * Pure helpers for `apps/web/.provision.env` — the git-ignored `KEY=VALUE` file that holds the
 * provisioning tokens (and, optionally, the Worker secrets `pnpm provision secrets` copies).
 * Same line conventions as `.dev.vars`: `#` comments, blank lines, an optional `export ` prefix,
 * single or double quotes around a value. Nothing here touches the filesystem or `process.env`
 * (`config.ts` does the I/O), so the `config` test project exercises every branch.
 *
 * Precedence is `resolveToken`: the process environment wins (CI exports the variables), the file
 * is the fallback, an empty value in either counts as unset.
 */

export const PROVISION_ENV_BASENAME = '.provision.env'

/**
 * Keys whose values are identifiers, not credentials: they are printed by preflight (the account
 * id is in every dashboard URL; the admin email is the answer it echoes back) and must not be
 * registered with `redact()`.
 */
export const REDACT_EXEMPT_KEYS: ReadonlySet<string> = new Set([
  'CLOUDFLARE_ACCOUNT_ID',
  'BOOTSTRAP_ADMIN_EMAILS',
])

/** The values of `record` worth masking — every key except the exempt identifiers. */
export function secretValuesOf(record: Record<string, string | undefined>): string[] {
  return Object.entries(record)
    .filter(([k, v]) => v && !REDACT_EXEMPT_KEYS.has(k))
    .map(([, v]) => v as string)
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

/**
 * Strip one pair of matching quotes and surrounding whitespace; an unquoted value ends at an
 * inline ` # comment` (dotenv's rule, so a hand-edited file behaves as `.dev.vars` would).
 */
export function unquote(raw: string): string {
  const v = raw.trim()
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  )
    return v.slice(1, -1)
  return v.replace(/\s+#.*$/, '').trim()
}

/** `KEY=VALUE` lines → values; comments, blanks and malformed lines are skipped; last wins. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = LINE.exec(line)
    if (!m) continue
    const value = unquote(m[2])
    if (value) out[m[1]] = value
    else delete out[m[1]]
  }
  return out
}

/**
 * Return `text` with each key of `updates` set: an existing `KEY=` line (even `export KEY=`, even
 * one whose value is blank) is replaced in place, keeping its position; a key the file does not
 * mention is appended at the end. Comments and every other line are preserved byte for byte.
 */
export function upsertEnvFile(text: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates))
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const out = lines.map(line => {
    const m = LINE.exec(line.replace(/\r$/, ''))
    if (!m || !pending.has(m[1])) return line
    const value = pending.get(m[1]) as string
    pending.delete(m[1])
    return `${m[1]}=${quoteIfNeeded(value)}`
  })
  for (const [key, value] of pending) out.push(`${key}=${quoteIfNeeded(value)}`)
  return out.length ? `${out.join('\n')}\n` : ''
}

function quoteIfNeeded(value: string): string {
  return /[\s#'"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/** `re_abc…wxyz` — enough to recognise a value, never enough to use it. */
export function maskToken(value: string | undefined): string {
  if (!value) return '(not set)'
  if (value.length <= 10) return '••••'
  return `${value.slice(0, 3)}…${value.slice(-4)}`
}

export type TokenSource = 'env' | 'file'

export interface ResolvedToken {
  value: string
  source: TokenSource
}

/** Environment first (CI), then the file; whitespace trimmed; empty = unset. */
export function resolveToken(
  name: string,
  env: Record<string, string | undefined>,
  file: Record<string, string>
): ResolvedToken | undefined {
  const fromEnv = env[name]?.trim()
  if (fromEnv) return { value: fromEnv, source: 'env' }
  const fromFile = file[name]?.trim()
  if (fromFile) return { value: fromFile, source: 'file' }
  return undefined
}

/** The one sentence every "missing token" message ends with. */
export function missingTokenHint(name: string, help?: { url: string; scopes: string }): string {
  return (
    `${name} is not set — run \`pnpm provision tokens\` in your own terminal (it prompts, hidden input, ` +
    `and writes apps/web/${PROVISION_ENV_BASENAME}), or copy apps/web/${PROVISION_ENV_BASENAME}.example to ` +
    `apps/web/${PROVISION_ENV_BASENAME} and fill it in, or export the variable (CI)` +
    (help ? `. Mint: ${help.url} (${help.scopes})` : '')
  )
}

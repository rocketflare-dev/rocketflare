/**
 * Shared plumbing for `scripts/provision.ts`: paths, the git-ignored answer cache
 * (`apps/web/.provision.json` — NON-secret ids and answers only), token discovery
 * (`process.env` first, then the git-ignored `apps/web/.provision.env`), the redacting logger and
 * a child-process runner whose output is redacted before it is echoed. Nothing here reads
 * `.dev.vars` — that file is loaded into the Worker by `wrangler dev`, so account-level tokens
 * must never live there.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  missingTokenHint,
  PROVISION_ENV_BASENAME,
  parseEnvFile,
  REDACT_EXEMPT_KEYS,
  type ResolvedToken,
  resolveToken,
  secretValuesOf,
} from './env-file'
import { redact, registerSecrets } from './redact'

/** apps/web — resolved from this file, never from `process.cwd()`. */
export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const ROOT_DIR = path.resolve(WEB_DIR, '../..')
export const CACHE_FILE = path.join(WEB_DIR, '.provision.json')
/** `PROVISION_ENV_FILE` relocates the token file (tests, a one-off run); default apps/web/.provision.env. */
export const TOKEN_FILE =
  process.env.PROVISION_ENV_FILE?.trim() || path.join(WEB_DIR, PROVISION_ENV_BASENAME)
export const TOKEN_FILE_EXAMPLE = path.join(WEB_DIR, `${PROVISION_ENV_BASENAME}.example`)
/** How the token file is shown in messages: the default path relative to the repo, else the override verbatim. */
export const TOKEN_FILE_LABEL =
  process.env.PROVISION_ENV_FILE?.trim() || `apps/web/${PROVISION_ENV_BASENAME}`

export type EnvName = 'staging' | 'production'
export const ENV_NAMES: EnvName[] = ['staging', 'production']

export const tomlFor = (env: EnvName): string =>
  path.join(WEB_DIR, env === 'staging' ? 'wrangler.staging.toml' : 'wrangler.toml')
export const tomlBasename = (env: EnvName): string => path.basename(tomlFor(env))
/** `-c wrangler.staging.toml` for staging, nothing for production (wrangler's default file). */
export const wranglerConfigArgs = (env: EnvName): string[] =>
  env === 'staging' ? ['-c', 'wrangler.staging.toml'] : []

// ---- tokens -------------------------------------------------------------------------------

export const TOKEN_HELP: Record<string, { url: string; scopes: string }> = {
  CLOUDFLARE_API_TOKEN: {
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    scopes:
      'Account: Workers Scripts, Workers KV Storage, Queues, Workflows, Durable Objects, Hyperdrive, R2 — Edit; Workers AI, Account Analytics — Read. Zone: DNS — Edit (the zone holding your hosts and the sending domain)',
  },
  CLOUDFLARE_ACCOUNT_ID: {
    url: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages (the id is in the right-hand column / the URL)',
    scopes: 'the 32-hex account id',
  },
  NEON_API_KEY: {
    url: 'https://console.neon.tech/app/settings/api-keys',
    scopes: 'a personal or organisation API key (creates projects and branches)',
  },
  RESEND_API_KEY: {
    url: 'https://resend.com/api-keys',
    scopes: 'Full access (creates the domain and mints the per-environment sending key)',
  },
}

export const REQUIRED_TOKENS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'NEON_API_KEY',
  'RESEND_API_KEY',
] as const

/** Optional Worker secrets copied from the environment by `pnpm provision secrets`. */
export const OPTIONAL_WORKER_SECRETS = [
  'BOOTSTRAP_ADMIN_EMAILS',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'EMBEDDINGS_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
] as const

let tokenFileMemo: Record<string, string> | undefined

/**
 * The token file, parsed once per process (call `reloadTokenFile()` after writing it). A file
 * that is readable by the group or the world gets ONE warning and is still used. Every value it
 * yields is registered with `redact()` so it can never be echoed, whatever its shape — except the
 * identifiers in `REDACT_EXEMPT_KEYS` (account id, admin email), which preflight prints.
 */
export function readTokenFile(): Record<string, string> {
  if (tokenFileMemo) return tokenFileMemo
  tokenFileMemo = {}
  if (!fs.existsSync(TOKEN_FILE)) return tokenFileMemo
  if (process.platform !== 'win32') {
    const mode = fs.statSync(TOKEN_FILE).mode & 0o777
    if (mode & 0o077)
      warn(
        `${TOKEN_FILE_LABEL} is mode ${mode.toString(8).padStart(4, '0')} — it holds tokens; run \`chmod 600 ${TOKEN_FILE_LABEL}\``
      )
  }
  tokenFileMemo = parseEnvFile(fs.readFileSync(TOKEN_FILE, 'utf8'))
  registerSecrets(secretValuesOf(tokenFileMemo))
  return tokenFileMemo
}

export function reloadTokenFile(): void {
  tokenFileMemo = undefined
}

/** Where a token comes from: the process environment (CI) beats the file; empty counts as unset. */
export function tokenSource(name: string): ResolvedToken | undefined {
  const resolved = resolveToken(name, process.env, readTokenFile())
  if (resolved && !REDACT_EXEMPT_KEYS.has(name)) registerSecrets([resolved.value])
  return resolved
}

export function token(name: string): string | undefined {
  return tokenSource(name)?.value
}

/** The standard "missing token" sentence: `pnpm provision tokens`, the file, or an export. */
export function tokenHint(name: string): string {
  return missingTokenHint(name, TOKEN_HELP[name])
}

export function requireToken(name: string): string {
  const v = token(name)
  if (!v) throw new ProvisionError(tokenHint(name), 2)
  return v
}

// ---- errors -------------------------------------------------------------------------------

export class ProvisionError extends Error {
  constructor(
    message: string,
    public exitCode = 1
  ) {
    super(message)
  }
}

// ---- cache --------------------------------------------------------------------------------

export interface ProvisionCache {
  appName?: string
  region?: string
  sendingDomain?: string
  /** Per environment: a hostname, or the literal `workers.dev`. */
  hosts?: Partial<Record<EnvName, string>>
  adminEmails?: string
  neon?: {
    projectId?: string
    branches?: Partial<Record<EnvName, string>>
    hosts?: Partial<Record<EnvName, string>>
    database?: string
    role?: string
  }
  resend?: { domainId?: string; domainName?: string; region?: string }
  cloudflare?: {
    /** The first zone preflight resolved (kept for older caches); `zones` is the full map. */
    zoneId?: string
    zoneName?: string
    /** zone name → zone id, one entry per zone a host or the sending domain resolved to. */
    zones?: Record<string, string>
    workersSubdomain?: string
  }
}

const SECRET_SHAPE = /postgres(ql)?:\/\/|\bre_|\bnapi_|[0-9a-f]{40,}/i

export function readCache(): ProvisionCache {
  if (!fs.existsSync(CACHE_FILE)) return {}
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as ProvisionCache
  } catch {
    return {}
  }
}

export function writeCache(patch: ProvisionCache): ProvisionCache {
  const merged = deepMerge(readCache(), patch)
  const json = JSON.stringify(merged, null, 2)
  // Belt and braces: the cache holds ids and answers only. Refuse to persist anything secret-shaped.
  if (SECRET_SHAPE.test(json))
    throw new ProvisionError('refusing to write a secret-shaped value to .provision.json')
  fs.writeFileSync(CACHE_FILE, `${json}\n`)
  return merged
}

function deepMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): T {
  const out: Record<string, any> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object')
      out[k] = deepMerge(out[k], v)
    else out[k] = v
  }
  return out as T
}

// ---- logging ------------------------------------------------------------------------------

export const log = (msg: string): void => {
  console.log(redact(msg))
}
export const warn = (msg: string): void => {
  console.error(redact(`warning: ${msg}`))
}
export const verifyLine = (msg: string): void => {
  console.log(redact(`Verify: ${msg}`))
}
export const heading = (msg: string): void => {
  console.log(`\n== ${redact(msg)}`)
}

// ---- child processes ----------------------------------------------------------------------

export interface RunOptions {
  cwd?: string
  /** Extra environment for the child — how a connection string reaches a script without a log. */
  env?: Record<string, string | undefined>
  /** Piped to the child's stdin (secrets travel this way, never as arguments). */
  stdin?: string
  /** Echo the child's (redacted) output live. Default true; false = capture silently. */
  echo?: boolean
  /** Return instead of throwing on a non-zero exit. */
  allowFailure?: boolean
}

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/** Run a command, streaming redacted output; the raw (unredacted) capture is returned to the caller. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const echo = opts.echo ?? true
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? WEB_DIR,
      env: { ...process.env, ...opts.env },
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString()
      stdout += s
      if (echo) process.stdout.write(redact(s))
    })
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr += s
      if (echo) process.stderr.write(redact(s))
    })
    child.on('error', reject)
    child.on('close', code => {
      const status = code ?? 1
      if (status !== 0 && !opts.allowFailure) {
        reject(
          new ProvisionError(
            `${cmd} ${args.map(a => redact(a)).join(' ')} exited ${status}${echo ? '' : `\n${redact(stderr || stdout).trim()}`}`
          )
        )
        return
      }
      resolve({ status, stdout, stderr })
    })
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin)
    }
  })
}

/** Synchronous capture for cheap lookups (`git config user.email`, `node -v`). */
export function capture(cmd: string, args: string[], cwd = WEB_DIR): string | undefined {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: process.env })
  if (r.status !== 0) return undefined
  return r.stdout.trim()
}

/** `pnpm exec wrangler …` inside apps/web — never at the workspace root (docs/DEPLOY.md). */
export function wrangler(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run('pnpm', ['exec', 'wrangler', ...args], {
    ...opts,
    cwd: WEB_DIR,
    env: {
      CLOUDFLARE_API_TOKEN: token('CLOUDFLARE_API_TOKEN'),
      CLOUDFLARE_ACCOUNT_ID: token('CLOUDFLARE_ACCOUNT_ID'),
      ...opts.env,
    },
  })
}

/** The worker `name` from wrangler.toml (production) — never a literal (`/adapt` may have renamed it). */
export function readAppName(): string {
  const text = fs.readFileSync(tomlFor('production'), 'utf8')
  const m = /^name\s*=\s*"([^"]+)"/m.exec(text)
  if (!m) throw new ProvisionError('could not read `name` from apps/web/wrangler.toml')
  return m[1]
}

export const toUpperName = (app: string): string => app.toUpperCase().replace(/-/g, '_')

/** `https://app.example.com` → `example.com` (last two labels; a public-suffix table is not worth a dependency). */
export function apexOf(hostOrUrl: string): string {
  const host = hostOrUrl.replace(/^https?:\/\//, '').split('/')[0]
  const labels = host.split('.')
  return labels.length <= 2 ? host : labels.slice(-2).join('.')
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * The local dev ports, read in ONE place by every consumer: Vite (`apps/web/vite.config.ts`), the
 * dev supervisor (`apps/web/scripts/dev-server.mjs`), the bootstrap and the seed's sign-in hint.
 * Defaults are the kit's :3000 (Vite, the UI) and :3001 (`wrangler dev`, the API); a machine where
 * those are taken (a Cloudflare Sandbox holds :3000) sets `DEV_UI_PORT` / `DEV_API_PORT` in the
 * shell or in `apps/web/.dev.vars`. The shell wins, then `.dev.vars`, then the default. Types:
 * `dev-ports.d.mts`.
 *
 * `APP_URL` in `.dev.vars` must follow the UI port by hand — the Worker builds OAuth redirects,
 * magic links and its CORS/CSRF allow-list from it, and cannot read `process.env`.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDevVars } from './bootstrap-lib.mjs'

export const DEFAULT_UI_PORT = 3000
export const DEFAULT_API_PORT = 3001

const DEV_VARS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../apps/web/.dev.vars'
)

/** A TCP port from `raw`, or throws naming `key` — a typo must not quietly fall back to :3000. */
function parsePort(key, raw) {
  const text = String(raw).trim()
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${key}=${raw} is not a port (an integer 1-65535)`)
  }
  return port
}

/** The first non-blank value of `key`: `env`, then `devVars`. */
function pick(key, env, devVars) {
  for (const source of [env, devVars]) {
    const value = source?.[key]
    if (value !== undefined && String(value).trim() !== '') return String(value)
  }
  return undefined
}

/**
 * Pure: `{ ui, api }` from an environment and the parsed `.dev.vars` values. Throws on a value
 * that is not a port, or when both resolve to the same port.
 */
export function resolveDevPorts(env = {}, devVars = {}) {
  const uiRaw = pick('DEV_UI_PORT', env, devVars)
  const apiRaw = pick('DEV_API_PORT', env, devVars)
  const ui = uiRaw === undefined ? DEFAULT_UI_PORT : parsePort('DEV_UI_PORT', uiRaw)
  const api = apiRaw === undefined ? DEFAULT_API_PORT : parsePort('DEV_API_PORT', apiRaw)
  if (ui === api) throw new Error(`DEV_UI_PORT and DEV_API_PORT are both ${ui}; they must differ`)
  return { ui, api }
}

/** Pure: the extra hosts Vite should answer for, from a comma-separated `DEV_ALLOWED_HOSTS`. */
export function resolveDevAllowedHosts(env = {}, devVars = {}) {
  const raw = pick('DEV_ALLOWED_HOSTS', env, devVars) ?? ''
  return [
    ...new Set(
      raw
        .split(',')
        .map(h => h.trim())
        .filter(Boolean)
    ),
  ]
}

/** `apps/web/.dev.vars` parsed, or `{}` when there is none yet (a fresh clone). */
export function readDevVarsFile(file = DEV_VARS) {
  return existsSync(file) ? readDevVars(readFileSync(file, 'utf8')) : {}
}

/** `{ ui, api }` for this checkout: `process.env`, then `apps/web/.dev.vars`, then 3000/3001. */
export function devPorts({ env = process.env, devVarsFile = DEV_VARS } = {}) {
  return resolveDevPorts(env, readDevVarsFile(devVarsFile))
}

/** Hosts from `DEV_ALLOWED_HOSTS` (same precedence as `devPorts`); `[]` when unset. */
export function devAllowedHosts({ env = process.env, devVarsFile = DEV_VARS } = {}) {
  return resolveDevAllowedHosts(env, readDevVarsFile(devVarsFile))
}

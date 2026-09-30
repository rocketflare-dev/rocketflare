/**
 * What database the test suite may touch — pure, so `tests/config/db-safety.test.ts` can prove
 * every refusal without one. `safetyCheck()` in `./db.ts` runs it over `process.env`.
 *
 * **A local database, always.** `DATABASE_URL`'s HOST must be `localhost` / `127.0.0.1` / `::1`
 * (the host, not the whole string: a remote URL whose database or password merely contains
 * "localhost" is refused).
 *
 * **A remote one only as a throwaway gate branch** — the one case the kit allows, for a coding
 * sandbox that has no Docker and only 443 out (Launch's ship gate: `pnpm test` with the variables
 * below). Every
 * condition must hold, and each one closes a different accident:
 *
 * - `TEST_DATABASE_EPHEMERAL=1` — the run says it is the ephemeral profile (`scripts/test.mjs`
 *   sets it when `TEST_DATABASE_BRANCH` names a branch).
 * - `DATABASE_DRIVER=neon` — the only driver that reaches Neon over 443.
 * - the host is Neon's (`*.neon.tech`) — no other remote database is ever acceptable.
 * - `TEST_DATABASE_BRANCH` matches `gate-<short>-<attempt>` — the caller names a GATE branch,
 *   which the suite truncates and rewrites; a `main`/`dev`/`session-…` branch never matches.
 * - `TEST_DATABASE_ENDPOINT` is the endpoint id IN the URL (`ep-…`, `-pooler` ignored). The
 *   branch name is NOT in a Neon connection string, so the name alone is only a claim about some
 *   database; the endpoint id is, and binds that claim to THIS connection string. An opt-in left
 *   exported in a shell cannot bless a different `DATABASE_URL` later.
 *
 * `APP_DATABASE_URL` is a second way to reach a database: local, or on the same endpoint.
 */

export const GATE_BRANCH_RE = /^gate-[a-z0-9]+-\d+$/
const ENDPOINT_RE = /^ep-[a-z0-9-]+$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

type Env = { readonly [key: string]: string | undefined }

/** The run is the ephemeral-gate profile (`pnpm test` on a gate branch). Remote access needs more. */
export function isEphemeralTestRun(env: Env): boolean {
  return env.TEST_DATABASE_EPHEMERAL === '1'
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function isLocalDatabaseUrl(url: string): boolean {
  const host = hostOf(url)
  return host !== null && LOCAL_HOSTS.has(host)
}

/** `ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech` → `ep-cool-darkness-123456`. */
export function neonEndpointId(url: string): string | null {
  const host = hostOf(url)
  if (!host?.endsWith('.neon.tech')) return null
  const label = host.split('.')[0] ?? ''
  const id = label.replace(/-pooler$/, '')
  return ENDPOINT_RE.test(id) ? id : null
}

function fail(message: string): never {
  throw new Error(`SAFETY CHECK FAILED: ${message}`)
}

/** Why a non-local URL is refused, or null when the ephemeral gate opt-in accepts it. */
function ephemeralRefusal(env: Env, url: string, label: string): string | null {
  const hint =
    'Tests run against local Postgres only. A remote database is accepted solely as a throwaway ' +
    'Neon gate branch: pnpm test with TEST_DATABASE_BRANCH=gate-<short>-<attempt> and ' +
    'TEST_DATABASE_ENDPOINT=<the ep-… id in the URL> (docs/CONCEPTS.md, "Ephemeral test database")'
  if (!isEphemeralTestRun(env)) return `${label} must be local Postgres. ${hint}`
  if (env.DATABASE_DRIVER !== 'neon') {
    return `${label} is remote, which needs DATABASE_DRIVER=neon (got ${env.DATABASE_DRIVER ?? 'unset'}). ${hint}`
  }
  const endpoint = neonEndpointId(url)
  if (!endpoint) return `${label} is remote but not a Neon endpoint (*.neon.tech). ${hint}`
  const branch = env.TEST_DATABASE_BRANCH ?? ''
  if (!GATE_BRANCH_RE.test(branch)) {
    return `TEST_DATABASE_BRANCH must name a gate branch (gate-<short>-<attempt>), got '${branch}'. ${hint}`
  }
  if (env.TEST_DATABASE_ENDPOINT !== endpoint) {
    return `TEST_DATABASE_ENDPOINT ('${env.TEST_DATABASE_ENDPOINT ?? ''}') is not the endpoint in ${label} ('${endpoint}'). ${hint}`
  }
  return null
}

/** Host only: a refusal must never print a credential. */
function target(url: string): string {
  return hostOf(url) ?? '<not a URL>'
}

/**
 * 1. NODE_ENV must be 'test'; 2. DATABASE_URL local, or the gate-branch opt-in above;
 * 3. APP_DATABASE_URL, if set, local or on the same endpoint as DATABASE_URL.
 */
export function checkTestDatabaseEnv(env: Env): void {
  const { NODE_ENV, DATABASE_URL, APP_DATABASE_URL } = env
  if (NODE_ENV !== 'test') fail(`NODE_ENV must be 'test' (current: ${NODE_ENV ?? 'undefined'})`)
  if (!DATABASE_URL) fail('DATABASE_URL is not set')
  if (!isLocalDatabaseUrl(DATABASE_URL)) {
    const refusal = ephemeralRefusal(env, DATABASE_URL, 'DATABASE_URL')
    if (refusal) fail(`${refusal}. Current host: ${target(DATABASE_URL)}`)
  }
  if (APP_DATABASE_URL && !isLocalDatabaseUrl(APP_DATABASE_URL)) {
    const sameEndpoint =
      !isLocalDatabaseUrl(DATABASE_URL) &&
      neonEndpointId(APP_DATABASE_URL) !== null &&
      neonEndpointId(APP_DATABASE_URL) === neonEndpointId(DATABASE_URL)
    if (!sameEndpoint) {
      fail(
        `APP_DATABASE_URL must be local Postgres, or the gate branch's own endpoint. Current host: ${target(APP_DATABASE_URL)}`
      )
    }
  }
}

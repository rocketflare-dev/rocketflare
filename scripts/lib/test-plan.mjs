/**
 * What `pnpm test` runs, as data (docs/CONCEPTS.md §4, "The gate"). `scripts/test.mjs` executes
 * the plan; this file decides it, so the decision is unit-tested without spawning anything
 * (`apps/web/tests/config/gate.test.ts`).
 *
 * The TARGET is decided from the environment, never by probing a database:
 *
 * - **local** (the default): the compose Postgres on :5433 and the Neon proxy on :4433, started
 *   by the runner if they are not up. Every package's tests, the web suite under `postgres`, then
 *   the `driver` project again under `neon` through the proxy — the conformance pass that proves
 *   the driver seam (apps/web/src/db/CLAUDE.md).
 * - **remote**: `TEST_DATABASE_BRANCH` is set — a coding sandbox's throwaway Neon gate branch
 *   (Launch's ship gate), 443 only, no Docker. The whole web suite under `neon` straight to the
 *   branch; there is no TCP for `postgres`, so the conformance pass is skipped and says so.
 *   tests/helpers/db-safety.ts still refuses unless the branch name and the endpoint id match.
 *
 * `GATE_SUITE_DRIVER=neon` runs the local suite under `neon` through the proxy (and the
 * conformance pass under `postgres`): the kit's full-neon backstop (kit.yml) and a way to chase a
 * suspected seam hole by hand.
 */

export const PROXY_URL = 'http://localhost:4433'
export const COMPOSE_FILE = 'apps/web/docker-compose.test.yml'
export const WEB_DIR = 'apps/web'

const DRIVERS = ['postgres', 'neon']

/** The hint a refusal ends with: the two ways to give `pnpm test` a database. */
export const TARGET_HINT =
  'Run it locally with Docker (the runner starts the test Postgres and the Neon proxy itself), or ' +
  'against a Neon gate branch by setting DATABASE_URL, TEST_DATABASE_BRANCH=gate-<short>-<attempt> ' +
  'and TEST_DATABASE_ENDPOINT=<the ep-… id in the URL> (docs/CONCEPTS.md §4).'

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ target: 'local' | 'remote', suiteDriver: 'postgres' | 'neon' } | { error: string }}
 */
export function resolveTarget(env) {
  const branch = env.TEST_DATABASE_BRANCH ?? ''
  const override = env.GATE_SUITE_DRIVER ?? ''
  if (override && !DRIVERS.includes(override)) {
    return { error: `GATE_SUITE_DRIVER must be neon or postgres, got '${override}'.` }
  }
  if (branch) {
    if (override === 'postgres') {
      return {
        error:
          'GATE_SUITE_DRIVER=postgres cannot run on a remote target: a Neon gate branch is ' +
          'reached over 443, and postgres.js needs TCP.',
      }
    }
    return { target: 'remote', suiteDriver: 'neon' }
  }
  if (env.TEST_DATABASE_EPHEMERAL === '1') {
    return {
      error: `TEST_DATABASE_EPHEMERAL=1 without TEST_DATABASE_BRANCH names no gate branch. ${TARGET_HINT}`,
    }
  }
  return {
    target: 'local',
    suiteDriver: /** @type {'postgres' | 'neon'} */ (override || 'postgres'),
  }
}

/** The environment a web vitest run needs for one driver on one target. */
function driverEnv(target, driver) {
  if (target === 'remote') {
    // `.env.test`'s local URLs must not win: dotenv never overwrites a variable that is already
    // set, so the branch's DATABASE_URL stands, and the app-role URL is blanked (unset, the app
    // role is created NOLOGIN and the policies stay inert — tests/setup.ts).
    return {
      NODE_ENV: 'test',
      DATABASE_DRIVER: 'neon',
      TEST_DATABASE_EPHEMERAL: '1',
      APP_DATABASE_URL: '',
    }
  }
  return driver === 'neon'
    ? { NODE_ENV: 'test', DATABASE_DRIVER: 'neon', NEON_LOCAL_PROXY: PROXY_URL }
    : { NODE_ENV: 'test', DATABASE_DRIVER: 'postgres' }
}

function vitest(projects, extra = []) {
  return [
    'pnpm',
    'exec',
    'dotenv',
    '-e',
    '.env.test',
    '--',
    'vitest',
    'run',
    ...projects.flatMap(p => ['--project', p]),
    ...extra,
  ]
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ kitOnly: boolean }} tree what the checkout carries (`apps/web/tests/kit-only/` exists)
 */
export function planTests(env, tree) {
  const resolved = resolveTarget(env)
  if ('error' in resolved) return resolved
  const { target, suiteDriver } = resolved
  const otherDriver = suiteDriver === 'postgres' ? 'neon' : 'postgres'
  const suiteEnv = driverEnv(target, suiteDriver)
  // The kit's OWN tests exist only in the kit: the rename deletes the directory, so a copy's plan
  // never names the project and there is nothing to unwire.
  const isolated = ['api-isolated', 'driver', 'ui', 'config', ...(tree.kitOnly ? ['kit-only'] : [])]

  const banner =
    target === 'remote'
      ? `test target: remote Neon branch ${env.TEST_DATABASE_BRANCH} (no Docker; the whole suite under neon)`
      : `test target: local compose (the suite under ${suiteDriver}, then the driver project under ${otherDriver})`

  const steps = [
    {
      label: 'the other packages',
      cwd: '.',
      command: ['pnpm', '-r', '--filter', `!./${WEB_DIR}`, 'test'],
      env: {},
    },
    // Two invocations because vitest 3 resolves `isolate` per run, not per project.
    {
      label: `web: api (shared registry) under ${suiteDriver}`,
      cwd: WEB_DIR,
      command: vitest(['api'], ['--no-isolate']),
      env: suiteEnv,
    },
    {
      label: `web: ${isolated.join(', ')} under ${suiteDriver}`,
      cwd: WEB_DIR,
      command: vitest(isolated),
      env: suiteEnv,
    },
  ]
  const notes = []
  if (target === 'local') {
    steps.push({
      label: `web: driver conformance under ${otherDriver}`,
      cwd: WEB_DIR,
      command: vitest(['driver']),
      env: driverEnv(target, otherDriver),
    })
  } else {
    notes.push('driver conformance under postgres: skipped — remote target, no TCP')
  }
  return { target, suiteDriver, compose: target === 'local', banner, steps, notes }
}

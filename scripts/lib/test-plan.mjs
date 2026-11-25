/**
 * What `pnpm test` runs, as data (docs/CONCEPTS.md §4, "The gate"). `scripts/test.mjs` executes
 * the plan; this file decides it, so the decision is unit-tested without spawning anything
 * (`apps/web/tests/kit-only/gate.test.ts`).
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

import { parseYaml } from './yaml-lite.mjs'

/** The host ports the kit's `docker-compose.test.yml` publishes; a copy may move both. */
export const DEFAULT_TEST_PORTS = Object.freeze({ postgres: 5433, proxy: 4433 })
export const proxyUrl = port => `http://localhost:${port}`
export const PROXY_URL = proxyUrl(DEFAULT_TEST_PORTS.proxy)
export const COMPOSE_FILE = 'apps/web/docker-compose.test.yml'
export const WEB_DIR = 'apps/web'

/** The host port of a compose service's first `ports:` entry (`"5433:5432"` → 5433), or null. */
function publishedPort(service) {
  const first = Array.isArray(service?.ports) ? service.ports[0] : null
  const m = /^(?:[\d.]+:)?(\d+):\d+(?:\/\w+)?$/.exec(String(first ?? '').trim())
  return m ? Number(m[1]) : null
}

/**
 * The host ports `docker-compose.test.yml` publishes for the test Postgres and the Neon proxy.
 * Read, never assumed: a copy that moved its test database off :5433 (so it never meets another
 * checkout's) found the KIT's server there and created its database in it (#178). A file that
 * does not say falls back to the kit's ports.
 * @param {string} composeText
 */
export function testPorts(composeText) {
  let services = {}
  try {
    services = parseYaml(composeText)?.services ?? {}
  } catch {
    services = {}
  }
  return {
    postgres: publishedPort(services['postgres-test']) ?? DEFAULT_TEST_PORTS.postgres,
    proxy: publishedPort(services['neon-proxy-test']) ?? DEFAULT_TEST_PORTS.proxy,
  }
}

/** The port in `.env.test`'s `DATABASE_URL`, or null when there is none to read. */
export function envTestDatabasePort(envTestText) {
  const raw = /^DATABASE_URL=(\S+)/m.exec(envTestText)?.[1]
  if (!raw) return null
  try {
    const url = new URL(raw)
    return Number(url.port || 5432)
  } catch {
    return null
  }
}

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
function driverEnv(target, driver, proxy = PROXY_URL) {
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
    ? { NODE_ENV: 'test', DATABASE_DRIVER: 'neon', NEON_LOCAL_PROXY: proxy }
    : { NODE_ENV: 'test', DATABASE_DRIVER: 'postgres' }
}

/**
 * The suites `pnpm test <suite…>` accepts, each the vitest projects it runs. A suite is the
 * shared-registry project and its isolated half together: which file runs in which half is
 * `apps/web/vitest.config.ts`'s business, and no script names a project.
 */
export const SUITES = {
  api: ['api', 'api-isolated', 'api-fixtures'],
  ui: ['ui', 'ui-isolated'],
  config: ['config', 'config-isolated'],
  driver: ['driver'],
  'kit-only': ['kit-only'],
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
 * @param {{ kitOnly: boolean, webOnly?: boolean, proxy?: string }} tree what the checkout carries
 *   (`apps/web/tests/kit-only/` exists); `webOnly` (`pnpm test web`) skips the other packages
 */
export function planTests(env, tree) {
  const resolved = resolveTarget(env)
  if ('error' in resolved) return resolved
  const { target, suiteDriver } = resolved
  const otherDriver = suiteDriver === 'postgres' ? 'neon' : 'postgres'
  const suiteEnv = driverEnv(target, suiteDriver, tree.proxy)
  // The kit's OWN tests exist only in the kit: the rename deletes the directory, so a copy's plan
  // never names the project and there is nothing to unwire.
  const isolated = [
    'api-isolated',
    'api-fixtures',
    'driver',
    'ui',
    'ui-isolated',
    'config',
    'config-isolated',
    ...(tree.kitOnly ? ['kit-only'] : []),
  ]

  const banner =
    target === 'remote'
      ? `test target: remote Neon branch ${env.TEST_DATABASE_BRANCH} (no Docker; the whole suite under neon)`
      : `test target: local compose (the suite under ${suiteDriver}, then the driver project under ${otherDriver})`

  const steps = [
    ...(tree.webOnly
      ? []
      : [
          {
            label: 'the other packages',
            cwd: '.',
            command: ['pnpm', '-r', '--filter', `!./${WEB_DIR}`, 'test'],
            env: {},
          },
        ]),
    {
      label: `web: api (shared registry) under ${suiteDriver}`,
      cwd: WEB_DIR,
      command: vitest(['api']),
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
      env: driverEnv(target, otherDriver, tree.proxy),
    })
  } else {
    notes.push('driver conformance under postgres: skipped — remote target, no TCP')
  }
  return { target, suiteDriver, compose: target === 'local', banner, steps, notes }
}

/**
 * `pnpm test <suite…> [file…]`, the inner loop: the named suites' projects in one vitest run under
 * the suite driver, narrowed to the files or filters given. No suite runs every web project. No
 * other package, no second driver pass and no compose management (the database is expected up:
 * `pnpm test:db:up`, or any earlier `pnpm test`): that is the full run's job.
 * @param {Record<string, string | undefined>} env
 * @param {{ suites: string[], files: string[], kitOnly: boolean, proxy?: string }} input
 */
export function planSuites(env, { suites, files, kitOnly, proxy }) {
  const resolved = resolveTarget(env)
  if ('error' in resolved) return resolved
  const { target, suiteDriver } = resolved
  const unknown = suites.filter(s => !(s in SUITES))
  if (unknown.length) {
    return {
      error: `unknown suite ${unknown.join(', ')}: one of ${Object.keys(SUITES).join(', ')}`,
    }
  }
  if (suites.includes('kit-only') && !kitOnly) {
    return { error: 'kit-only runs in the kit repository only: a copy has no tests/kit-only/' }
  }
  const named = suites.length
    ? suites
    : Object.keys(SUITES).filter(s => s !== 'kit-only' || kitOnly)
  const projects = named.flatMap(s => SUITES[s])
  return {
    target,
    suiteDriver,
    compose: false,
    banner: `test target: ${target}, ${named.join(' + ')} under ${suiteDriver}${files.length ? `, ${files.length} filter(s)` : ''}`,
    steps: [
      {
        label: `web: ${projects.join(', ')} under ${suiteDriver}`,
        cwd: WEB_DIR,
        command: vitest(projects, files),
        env: driverEnv(target, suiteDriver, proxy),
      },
    ],
    notes: [],
  }
}

/** The projects that open the test database (`tests/setup.ts` is their global setup). */
const DATABASE_PROJECTS = ['api', 'api-isolated', 'api-fixtures', 'driver']

/**
 * `pnpm test --changed`: the same shape as `planTests`, over the files `selectTests` chose
 * (scripts/lib/gate-changed.mjs). The database starts only when a chosen file needs it, and the
 * driver conformance pass runs only when a driver file was chosen — the seam is proven on every
 * full run, and a change that reaches it reaches the `driver` project's files.
 * @param {Record<string, string | undefined>} env
 * @param {{ projects: Record<string, string[]>, packages: string[], proxy?: string }} selection web files are
 *   paths relative to apps/web; packages are repo-relative dirs
 */
export function planSelectedTests(env, selection) {
  const resolved = resolveTarget(env)
  if ('error' in resolved) return resolved
  const { target, suiteDriver } = resolved
  const otherDriver = suiteDriver === 'postgres' ? 'neon' : 'postgres'
  const suiteEnv = driverEnv(target, suiteDriver, selection.proxy)
  const files = p => selection.projects[p] ?? []
  const steps = selection.packages.map(dir => ({
    label: `${dir} (reached by the change)`,
    cwd: '.',
    command: ['pnpm', '--filter', `./${dir}`, 'test'],
    env: {},
  }))
  if (files('api').length) {
    steps.push({
      label: `web: api, ${files('api').length} file(s) under ${suiteDriver}`,
      cwd: WEB_DIR,
      command: vitest(['api'], files('api')),
      env: suiteEnv,
    })
  }
  const isolated = Object.keys(selection.projects).filter(p => p !== 'api' && files(p).length)
  if (isolated.length) {
    const chosen = isolated.flatMap(files)
    steps.push({
      label: `web: ${isolated.join(', ')}, ${chosen.length} file(s) under ${suiteDriver}`,
      cwd: WEB_DIR,
      command: vitest(isolated, chosen),
      env: suiteEnv,
    })
  }
  const notes = []
  if (files('driver').length && target === 'local') {
    steps.push({
      label: `web: driver conformance under ${otherDriver}`,
      cwd: WEB_DIR,
      command: vitest(['driver'], files('driver')),
      env: driverEnv(target, otherDriver, selection.proxy),
    })
  } else if (files('driver').length) {
    notes.push('driver conformance under postgres: skipped — remote target, no TCP')
  }
  const total = Object.values(selection.projects).reduce((n, f) => n + f.length, 0)
  return {
    target,
    suiteDriver,
    compose: target === 'local' && DATABASE_PROJECTS.some(p => files(p).length > 0),
    banner: `test target: ${target}, --changed: ${total} web test file(s) and ${selection.packages.length} other package(s)`,
    steps,
    notes,
  }
}

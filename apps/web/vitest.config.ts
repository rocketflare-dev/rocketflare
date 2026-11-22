import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defaultClientConditions } from 'vite'
import { defineConfig } from 'vitest/config'
import {
  isMarkedFixtureAgents,
  isMarkedIsolated,
  apiTestFiles as listApiTestFiles,
  testDirs,
  testFiles,
  uiNeedsIsolation,
} from './tests/helpers/isolation.ts'
import { latencyFactor } from './tests/helpers/latency.ts'

const alias = {
  '@': path.resolve(import.meta.dirname, './src'),
  /**
   * The test kit (D31): `@testkit/integration` is the harness, `@testkit/unit` the context
   * builders. It is registered HERE and in `tsconfig.json`, and deliberately NOT in
   * `vite.config.ts` — so a `src/` file importing it fails the build instead of shipping the
   * harness into the browser bundle. `tests/config/testkit-alias.test.ts` pins all three halves.
   */
  '@testkit': path.resolve(import.meta.dirname, './tests/kit'),
  // Worker-only module: DurableObject / WorkflowEntrypoint base classes. Tests run under Node
  // (real Postgres, `app.request(req, env)` with tests/mocks/bindings.ts), not workerd.
  'cloudflare:workers': path.resolve(import.meta.dirname, './tests/mocks/cloudflare-workers.ts'),
}

/**
 * A remote target (`pnpm test` with `TEST_DATABASE_BRANCH` set, which sets
 * TEST_DATABASE_EPHEMERAL=1): the suite in a coding sandbox against a throwaway Neon gate branch
 * over the network (tests/helpers/db-safety.ts). Fewer forks, because the local sizing below
 * assumes the compose Postgres's max_connections=300 and a small Neon compute allows ~100.
 * `TEST_MAX_WORKERS` tunes the fork count; `TEST_LATENCY_FACTOR` raises every time limit on a slow
 * machine (a coding sandbox running a test by hand — `tests/helpers/latency.ts`).
 */
const EPHEMERAL = process.env.TEST_DATABASE_EPHEMERAL === '1'

/**
 * How much slower a query is on this target than on the local Postgres, and so how much every
 * time limit scales: 1 locally under `postgres`, 4 under `neon` through the local proxy (an HTTP
 * request and a fresh backend per query, 2-3x worse again on a 2-vCPU runner), 12 on a real Neon
 * branch (real network round trips, and a compute that may cold-start). ONE factor for the test,
 * hook and teardown limits, so no test carries a budget of its own: a test that is slow only on a
 * slow link is walking to a limit query by query, and it lowers that limit (the duration cap in
 * `agent-run-stream.test.ts`, the round cap in `agent-run-workflow.test.ts`) instead. The local
 * `postgres` run keeps vitest's 5 s, so it is still the tripwire for a test that is genuinely slow.
 * `TEST_LATENCY_FACTOR` raises it (never lowers it) for a slow machine; `tests/helpers/latency.ts`.
 */
const LATENCY_FACTOR = latencyFactor(process.env)

/**
 * `config` and `kit-only` have no database, but they drive the kit's own tooling END TO END
 * through child processes — `pnpm plugin add|upgrade`, the bootstrap, the bundle, `tsx` scripts —
 * and a child process is CPU-bound work that slows with everything else the gate runs beside it
 * (a 2 s plugin upgrade measured 6 s under the full suite). Their limit is a project setting, not a
 * per-test number, and it still scales with the factor.
 */
const PROCESS_TEST_TIMEOUT = 20_000 * LATENCY_FACTOR

// Forks are capped because each holds its own Postgres connections (test DB runs
// max_connections=300). Floor 3 = what a 2-vCPU CI runner gets; ceiling 10 measured ~10 s off
// `api-isolated` on a large machine against 6. See .claude/rules/testing.md.
const MAX_WORKERS =
  Number.parseInt(process.env.TEST_MAX_WORKERS ?? '', 10) ||
  (EPHEMERAL ? 2 : Math.min(10, Math.max(3, (os.availableParallelism?.() ?? 4) - 2)))

/**
 * The kit's OWN tests (`docs/CONCEPTS.md` §13): release notes, the version chain, the release and
 * rename machinery — true of the kit repository and of nothing made from it. `scripts/rename.mjs`
 * deletes the directory when a copy is born, so the `kit-only` project exists only while it does,
 * and a copy's gate has nothing kit-only to run (a stray `--project kit-only` then matches nothing,
 * which vitest ignores).
 */
const KIT_ONLY_DIR = path.resolve(import.meta.dirname, './tests/kit-only')

/**
 * A plugin (D31) keeps its tests inside its own directory — `src/plugins/<id>/tests/{api,ui,config}`
 * — so that installing or removing one moves its tests with it and never touches `tests/`.
 * `testDirs` lists the kit's directory and every plugin's, the same list the isolation contract
 * test walks, because the `// @vitest-isolate` marker decides which api project a file joins.
 */
function apiTestFiles(project: 'api' | 'api-isolated' | 'api-fixtures'): string[] {
  const projectOf = (source: string) =>
    isMarkedIsolated(source)
      ? 'api-isolated'
      : isMarkedFixtureAgents(source)
        ? 'api-fixtures'
        : 'api'
  return testDirs(import.meta.dirname, 'api').flatMap(dir =>
    listApiTestFiles(dir.abs)
      .filter(f => projectOf(fs.readFileSync(path.join(dir.abs, f), 'utf8')) === project)
      .map(f => `${dir.rel}/${f}`)
  )
}

/**
 * The ui and config tests, kit and plugins alike, split on `uiNeedsIsolation`: a file that mocks a
 * module or resets the registry gets its own registry (`<kind>-isolated`), every other one shares the
 * worker's, which imports the app once per worker instead of once per file.
 */
function splitTestFiles(kind: 'ui' | 'config', isolated: boolean): string[] {
  const dirs = testDirs(import.meta.dirname, kind)
  const pattern = kind === 'ui' ? /\.(test|spec)\.tsx?$/ : /\.(test|spec)\.ts$/
  return dirs.flatMap(dir =>
    testFiles(dir.abs, pattern)
      .filter(f => uiNeedsIsolation(fs.readFileSync(path.join(dir.abs, f), 'utf8')) === isolated)
      .map(f => `${dir.rel}/${f}`)
  )
}

const uiProject = (name: 'ui' | 'ui-isolated') => ({
  extends: true as const,
  plugins: [react()],
  test: {
    name,
    environment: 'jsdom' as const,
    isolate: name === 'ui-isolated',
    setupFiles: ['./tests/ui/setup.ts'],
    include: splitTestFiles('ui', name === 'ui-isolated'),
  },
  // Without the browser's conditions `react-router` loads as CJS here and an ESM importer such
  // as `react-router-dom` gets a second copy, so the two halves share no router context.
  resolve: { alias, conditions: [...defaultClientConditions] },
})

const configProject = (name: 'config' | 'config-isolated') => ({
  extends: true as const,
  test: {
    name,
    testTimeout: PROCESS_TEST_TIMEOUT,
    environment: 'node' as const,
    isolate: name === 'config-isolated',
    setupFiles: [
      './tests/config/setup.ts',
      ...(name === 'config' ? ['./tests/config/shared-setup.ts'] : []),
    ],
    include: splitTestFiles('config', name === 'config-isolated'),
  },
  resolve: { alias },
})

export default defineConfig({
  test: {
    globals: true,
    watch: false,
    pool: 'forks',
    maxWorkers: MAX_WORKERS,
    testTimeout: 5_000 * LATENCY_FACTOR,
    hookTimeout: 10_000 * LATENCY_FACTOR,
    teardownTimeout: 5_000 * LATENCY_FACTOR,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary', 'lcov'],
      include: [
        'src/api/**/*.ts',
        'src/shared/**/*.ts',
        'src/permissions/**/*.ts',
        'src/db/**/*.ts',
      ],
      exclude: ['src/ui/**', '**/*.test.ts', '**/types.ts', '**/schema/**'],
      clean: true,
      reportsDirectory: './coverage',
    },
    projects: [
      {
        // Shared module registry.
        extends: true,
        test: {
          name: 'api',
          isolate: false,
          environment: 'node',
          globalSetup: ['./tests/setup.ts'],
          setupFiles: ['./tests/api-setup.ts'],
          include: apiTestFiles('api'),
        },
        resolve: { alias },
      },
      {
        // Files marked `// @vitest-isolate`, on vitest's default isolation.
        extends: true,
        test: {
          name: 'api-isolated',
          environment: 'node',
          globalSetup: ['./tests/setup.ts'],
          setupFiles: ['./tests/api-setup.ts'],
          include: apiTestFiles('api-isolated'),
        },
        resolve: { alias },
      },
      {
        // Files marked `// @vitest-fixture-agents`: a shared registry, like `api`, in which the
        // fixture agents are installed once per worker before the app is first imported.
        extends: true,
        test: {
          name: 'api-fixtures',
          isolate: false,
          environment: 'node',
          globalSetup: ['./tests/setup.ts'],
          setupFiles: ['./tests/api-fixtures-setup.ts', './tests/api-setup.ts'],
          include: apiTestFiles('api-fixtures'),
        },
        resolve: { alias },
      },
      {
        // D35: the driver seam's conformance suite, against a real database under whichever
        // driver the environment selects — `pnpm test` runs it under both (tests/driver/CLAUDE.md).
        extends: true,
        test: {
          name: 'driver',
          environment: 'node',
          globalSetup: ['./tests/setup.ts'],
          setupFiles: ['./tests/api-setup.ts'],
          include: ['tests/driver/**/*.{test,spec}.ts'],
        },
        resolve: { alias },
      },
      // No database: config schema, wrangler parity, pure helpers, and every installed plugin's own.
      configProject('config'),
      configProject('config-isolated'),
      ...(fs.existsSync(KIT_ONLY_DIR)
        ? [
            {
              // No database, like `config` — but only in the kit.
              extends: true as const,
              test: {
                name: 'kit-only',
                testTimeout: PROCESS_TEST_TIMEOUT,
                environment: 'node',
                include: ['tests/kit-only/**/*.{test,spec}.ts'],
              },
              resolve: { alias },
            },
          ]
        : []),
      uiProject('ui'),
      uiProject('ui-isolated'),
    ],
  },
})

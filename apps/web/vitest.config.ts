import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { isMarkedIsolated, apiTestFiles as listApiTestFiles } from './tests/helpers/isolation'

const alias = {
  '@': path.resolve(__dirname, './src'),
  /**
   * The test kit (D31): `@testkit/integration` is the harness, `@testkit/unit` the context
   * builders. It is registered HERE and in `tsconfig.json`, and deliberately NOT in
   * `vite.config.ts` — so a `src/` file importing it fails the build instead of shipping the
   * harness into the browser bundle. `tests/config/testkit-alias.test.ts` pins all three halves.
   */
  '@testkit': path.resolve(__dirname, './tests/kit'),
  // Worker-only module: DurableObject / WorkflowEntrypoint base classes. Tests run under Node
  // (real Postgres, `app.request(req, env)` with tests/mocks/bindings.ts), not workerd.
  'cloudflare:workers': path.resolve(__dirname, './tests/mocks/cloudflare-workers.ts'),
}

/**
 * A remote target (`pnpm test` with `TEST_DATABASE_BRANCH` set, which sets
 * TEST_DATABASE_EPHEMERAL=1): the suite in a coding sandbox against a throwaway Neon gate branch
 * over the network (tests/helpers/db-safety.ts). Fewer forks, because the local sizing below
 * assumes the compose Postgres's max_connections=300 and a small Neon compute allows ~100.
 * `TEST_MAX_WORKERS` tunes the fork count.
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
 */
const LATENCY_FACTOR = EPHEMERAL ? 12 : process.env.DATABASE_DRIVER === 'neon' ? 4 : 1

// Forks are capped because each holds its own Postgres connections (test DB runs
// max_connections=300). Floor 3 = what a 2-vCPU CI runner gets; ceiling 6 is where Postgres
// becomes the bottleneck. See .claude/rules/testing.md.
const MAX_WORKERS =
  Number.parseInt(process.env.TEST_MAX_WORKERS ?? '', 10) ||
  (EPHEMERAL ? 2 : Math.min(6, Math.max(3, (os.availableParallelism?.() ?? 4) - 2)))

const API_TEST_DIR = path.resolve(__dirname, './tests/api')

/**
 * The kit's OWN tests (`docs/CONCEPTS.md` §13): release notes, the version chain, the release and
 * rename machinery — true of the kit repository and of nothing made from it. `scripts/rename.mjs`
 * deletes the directory when a copy is born, so the `kit-only` project exists only while it does,
 * and a copy's gate has nothing kit-only to run (a stray `--project kit-only` then matches nothing,
 * which vitest ignores).
 */
const KIT_ONLY_DIR = path.resolve(__dirname, './tests/kit-only')
const PLUGINS_DIR = path.resolve(__dirname, './src/plugins')

/**
 * A plugin (D31) keeps its tests inside its own directory — `src/plugins/<id>/tests/{api,ui,config}`
 * — so that installing or removing one moves its tests with it and never touches `tests/`. The api
 * ones have to be discovered the same way the kit's are, because the `// @vitest-isolate` marker
 * decides which of the two api projects a file belongs to.
 */
function pluginDirs(): string[] {
  if (!fs.existsSync(PLUGINS_DIR)) return []
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
}

function apiTestFiles(isolated: boolean): string[] {
  const dirs: Array<{ abs: string; rel: string }> = [
    { abs: API_TEST_DIR, rel: 'tests/api' },
    ...pluginDirs().map(id => ({
      abs: path.join(PLUGINS_DIR, id, 'tests/api'),
      rel: `src/plugins/${id}/tests/api`,
    })),
  ]
  return dirs.flatMap(dir =>
    listApiTestFiles(dir.abs)
      .filter(f => isMarkedIsolated(fs.readFileSync(path.join(dir.abs, f), 'utf8')) === isolated)
      .map(f => `${dir.rel}/${f}`)
  )
}

export default defineConfig({
  test: {
    globals: true,
    watch: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: MAX_WORKERS,
        // Pinned EQUAL to maxForks: with `isolate: false` vitest 3 may terminate an idle
        // worker mid-promise ("Terminating worker thread", vitest-dev/vitest#8564).
        minForks: MAX_WORKERS,
      },
    },
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
      all: true,
      clean: true,
      reportsDirectory: './coverage',
    },
    projects: [
      {
        // Shared module registry. Isolation is turned off on the command line
        // (`vitest run --project api --no-isolate`) — vitest 3 ignores a per-project `isolate`.
        extends: true,
        test: {
          name: 'api',
          environment: 'node',
          globalSetup: ['./tests/setup.ts'],
          setupFiles: ['./tests/api-setup.ts'],
          include: apiTestFiles(false),
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
          include: apiTestFiles(true),
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
      {
        // No database: config schema, wrangler parity, pure helpers, and every installed plugin's own.
        extends: true,
        test: {
          name: 'config',
          environment: 'node',
          include: [
            'tests/config/**/*.{test,spec}.ts',
            'src/plugins/*/tests/config/**/*.{test,spec}.ts',
          ],
        },
        resolve: { alias },
      },
      ...(fs.existsSync(KIT_ONLY_DIR)
        ? [
            {
              // No database, like `config` — but only in the kit.
              extends: true as const,
              test: {
                name: 'kit-only',
                environment: 'node',
                include: ['tests/kit-only/**/*.{test,spec}.ts'],
              },
              resolve: { alias },
            },
          ]
        : []),
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'ui',
          environment: 'jsdom',
          setupFiles: ['./tests/ui/setup.ts'],
          include: [
            'tests/ui/**/*.{test,spec}.{ts,tsx}',
            'src/plugins/*/tests/ui/**/*.{test,spec}.{ts,tsx}',
          ],
        },
        resolve: { alias },
      },
    ],
  },
})

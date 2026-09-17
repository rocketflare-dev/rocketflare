import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { isMarkedIsolated, apiTestFiles as listApiTestFiles } from './tests/helpers/isolation'

const alias = {
  '@': path.resolve(__dirname, './src'),
  // Worker-only module: DurableObject / WorkflowEntrypoint base classes. Tests run under Node
  // (real Postgres, `app.request(req, env)` with tests/mocks/bindings.ts), not workerd.
  'cloudflare:workers': path.resolve(__dirname, './tests/mocks/cloudflare-workers.ts'),
}

// Forks are capped because each holds its own Postgres connections (test DB runs
// max_connections=300). Floor 3 = what a 2-vCPU CI runner gets; ceiling 6 is where Postgres
// becomes the bottleneck. See .claude/rules/testing.md.
const MAX_WORKERS = Math.min(6, Math.max(3, (os.availableParallelism?.() ?? 4) - 2))

const API_TEST_DIR = path.resolve(__dirname, './tests/api')
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
    teardownTimeout: 5000,
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

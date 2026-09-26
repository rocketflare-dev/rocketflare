/**
 * The `evals` project (D33) — run by `pnpm eval` (scripts/eval.mjs), never by `pnpm test` or the
 * gate. It lives in its own package because vitest-evals needs vitest 4 and the kit's suites are on
 * vitest 3; the targets import `apps/web` source in-process through the same `@/` alias, and the
 * test database on :5433 through the web package's own helpers.
 */
import path from 'node:path'
import { defineConfig } from 'vitest/config'

const web = path.resolve(__dirname, '../web')

export default defineConfig({
  resolve: {
    alias: {
      '@': path.join(web, 'src'),
      // Worker-only module (DurableObject / WorkflowEntrypoint): the same Node stand-in the web tests use.
      'cloudflare:workers': path.join(web, 'tests/mocks/cloudflare-workers.ts'),
    },
  },
  test: {
    name: 'evals',
    environment: 'node',
    include: ['suites/**/*.eval.ts'],
    globalSetup: ['./global-setup.ts'],
    setupFiles: ['./setup.ts'],
    // A case is a real model call (an agent run is several), and judges add more.
    testTimeout: 240_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Provider rate limits, not CPU, are the ceiling: `EVAL_CONCURRENCY` files at once.
    maxWorkers: Number(process.env.EVAL_CONCURRENCY ?? 2),
  },
})

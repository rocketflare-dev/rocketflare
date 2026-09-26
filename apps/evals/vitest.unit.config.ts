/**
 * The eval kit's OWN unit tests — scorers, transcripts, datasets, the compare logic — which need no
 * model and no database, so they run in `pnpm test` and the gate like any other package's. The
 * suites themselves (`suites/**`) never do; that is `vitest.config.ts`, behind `pnpm eval`.
 */
import path from 'node:path'
import { defineConfig } from 'vitest/config'

const web = path.resolve(__dirname, '../web')

export default defineConfig({
  resolve: {
    alias: {
      '@': path.join(web, 'src'),
      'cloudflare:workers': path.join(web, 'tests/mocks/cloudflare-workers.ts'),
    },
  },
  test: {
    name: 'evals-unit',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})

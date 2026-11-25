/**
 * Kit-only: THIS checkout's two tomls and the workflows a copy carries parse with the
 * dependency-free readers `scripts/kit-check.mjs` uses (`scripts/lib/toml-lite.mjs`,
 * `scripts/lib/yaml-lite.mjs`). A copy's files are the app's to change, so the readers' own tests
 * (`tests/kit-only/kit-check-parsers.test.ts`) use inline documents.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { parseToml } from '../../../../scripts/lib/toml-lite.mjs'
import { parseYaml } from '../../../../scripts/lib/yaml-lite.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

it('parses both of the app tomls', () => {
  for (const f of ['wrangler.toml', 'wrangler.staging.toml']) {
    const doc = parseToml(readFileSync(path.join(REPO_ROOT, 'apps/web', f), 'utf8'))
    expect(doc.main).toBe('src/worker.ts')
  }
})

it('parses ci.yml and deploy.yml', () => {
  for (const f of ['ci.yml', 'deploy.yml']) {
    const doc = parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows', f), 'utf8'))
    expect(doc.jobs && Object.keys(doc.jobs).length > 0, f).toBe(true)
  }
})

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  apiTestFiles,
  ISOLATE_MARKER,
  isMarkedIsolated,
  looksLikeItNeedsIsolation,
  testDirs,
} from '../helpers/isolation'

/**
 * A file that mocks a module would leak that fake into every later file sharing the `api`
 * project's module registry; it must opt out with `// @vitest-isolate` on line 1.
 * vitest.config.ts routes files from the same directories (`testDirs`: the kit's `tests/api` and
 * every installed plugin's `src/plugins/<id>/tests/api`) with the same predicate, so this test is
 * what keeps the two in agreement.
 */
const WEB_ROOT = path.resolve(__dirname, '../..')
const files = testDirs(WEB_ROOT, 'api').flatMap(dir =>
  apiTestFiles(dir.abs).map(f => ({ rel: `${dir.rel}/${f}`, abs: path.join(dir.abs, f) }))
)

describe('api test isolation contract', () => {
  it('finds the api test files', () => {
    expect(files.map(f => f.rel)).toContain('tests/api/health.test.ts')
  })

  it.each(files.map(f => [f.rel, f.abs]))(
    '%s carries the isolate marker if it mocks modules',
    (rel, abs) => {
      const source = fs.readFileSync(abs, 'utf8')
      if (looksLikeItNeedsIsolation(source)) {
        expect(isMarkedIsolated(source), `${rel} must start with ${ISOLATE_MARKER}`).toBe(true)
      }
    }
  )
})

describe('the heuristic', () => {
  it('flags a module mock and a registry reset, not a spy or a stub the setups undo', () => {
    expect(looksLikeItNeedsIsolation("vi.mock('@/x')")).toBe(true)
    expect(looksLikeItNeedsIsolation("vi.doMock('@/x')")).toBe(true)
    expect(looksLikeItNeedsIsolation('vi.resetModules()')).toBe(true)
    expect(looksLikeItNeedsIsolation("vi.spyOn(globalThis, 'fetch')")).toBe(false)
    expect(looksLikeItNeedsIsolation("vi.stubGlobal('fetch', f)")).toBe(false)
    expect(looksLikeItNeedsIsolation("vi.stubEnv('X', '1')")).toBe(false)
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  apiTestFiles,
  ISOLATE_MARKER,
  isMarkedIsolated,
  looksLikeItNeedsIsolation,
} from '../helpers/isolation'

/**
 * A file that mocks a module or a global would leak that fake into every later file sharing
 * the `api` project's module registry; it must opt out with `// @vitest-isolate` on line 1.
 * vitest.config.ts uses the same predicate to route files, so this test is what keeps the
 * two in agreement.
 */
const API_TEST_DIR = path.resolve(__dirname)

describe('api test isolation contract', () => {
  const files = apiTestFiles(API_TEST_DIR)

  it('finds the api test files', () => {
    expect(files).toContain('isolation-contract.test.ts')
  })

  it.each(files)('%s carries the isolate marker if it mocks modules/globals', file => {
    const source = fs.readFileSync(path.join(API_TEST_DIR, file), 'utf8')
    if (looksLikeItNeedsIsolation(source)) {
      expect(isMarkedIsolated(source), `${file} must start with ${ISOLATE_MARKER}`).toBe(true)
    }
  })
})

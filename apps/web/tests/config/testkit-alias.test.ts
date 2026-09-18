/**
 * `@testkit` is registered in exactly two places, and the third absence is the point (D31).
 *
 * `tsconfig.json` makes it typecheck; `vitest.config.ts` makes it resolve when tests run;
 * `vite.config.ts` deliberately does NOT.
 *
 * **The two bundles are protected asymmetrically, and only one of them by the build.** Measured,
 * not reasoned:
 *
 *   - `src/ui/**` — Rollup resolves no `@testkit`, so `build:ui` FAILS. The harness
 *     (`@testing-library/react`, the seed fixtures, a Postgres client) cannot reach a browser.
 *   - `src/api/**` — wrangler resolves `tsconfig.json` paths, where `@testkit` IS registered. So
 *     `build:api` SUCCEEDS and the harness is bundled: +866 KB on a 1.98 MB Worker, silently.
 *
 * So on the API side the build is not a backstop at all, and the scan below is the ONLY thing
 * between a stray import and 866 KB of test fixtures in production. Weakening it — narrowing the
 * file glob, exempting a directory — removes the sole protection for that half. The scan also
 * gives the better diagnostic on both halves: a failed Rollup resolve says only that SOMETHING was
 * missing, while the scan names the file and the line, which is what an agent installing a plugin
 * needs.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { staticImports } from '../helpers/plugins'

const WEB_ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(path.join(WEB_ROOT, rel), 'utf8')

describe('the @testkit alias', () => {
  it('is registered in tsconfig.json, so a test typechecks', () => {
    const tsconfig = JSON.parse(read('tsconfig.json')) as {
      compilerOptions: { paths: Record<string, string[]> }
    }
    expect(tsconfig.compilerOptions.paths['@testkit/*']).toEqual(['tests/kit/*'])
  })

  it('is registered in vitest.config.ts, so a test resolves it', () => {
    expect(read('vitest.config.ts')).toMatch(/'@testkit':\s*path\.resolve/)
  })

  it('is NOT registered in vite.config.ts — the whole reason it is safe', () => {
    expect(read('vite.config.ts')).not.toMatch(/@testkit/)
  })

  it('names two entries that exist', () => {
    for (const entry of ['tests/kit/integration.ts', 'tests/kit/unit.ts']) {
      expect(existsSync(path.join(WEB_ROOT, entry)), entry).toBe(true)
    }
  })
})

describe('nothing under src/ imports it', () => {
  it('has no @testkit import in any tracked source file', () => {
    const files = execFileSync('git', ['ls-files', '--', 'src'], {
      cwd: WEB_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(f => /\.tsx?$/.test(f))
      // A plugin keeps its own tests INSIDE its directory (`src/plugins/<id>/tests/**`), so `src/`
      // is not all shipped code. Those are tests and `@testkit` is exactly what they should import;
      // what must never import it is code that reaches a bundle.
      .filter(f => !/(^|\/)tests\//.test(f))
      // `git ls-files` reads the INDEX, so a file removed on disk and not yet staged is listed.
      .filter(f => existsSync(path.join(WEB_ROOT, f)))

    const offenders: string[] = []
    for (const file of files) {
      for (const { specifier, line } of staticImports(read(file))) {
        if (specifier === '@testkit' || specifier.startsWith('@testkit/')) {
          offenders.push(
            `${file}:${line} imports '${specifier}' — the test kit is for tests. Move the ` +
              'helper into the plugin, or take the value as an argument; src/ must never import it.'
          )
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

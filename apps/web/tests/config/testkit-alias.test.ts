/**
 * `@testkit` is registered in exactly two places, and the third absence is the point (D31).
 *
 * `tsconfig.json` makes it typecheck; `vitest.config.ts` makes it resolve when tests run;
 * `vite.config.ts` deliberately does NOT, so a `src/` file that imports it fails `pnpm build`
 * instead of shipping the harness — `@testing-library/react`, the seed fixtures, a Postgres client
 * — into somebody's browser bundle.
 *
 * The build is the backstop, and this file is the diagnostic. A failed Rollup resolve says only
 * that SOMETHING could not be found; the scan below names the file and the line, which is what an
 * agent performing an install needs. It also covers the half the build cannot reach on its own:
 * `src/api/**` is bundled by wrangler, which reads `tsconfig.json` — where the path IS registered —
 * so an API file importing `@testkit` would typecheck, bundle, and only fail at runtime in the
 * Worker. The scan catches both halves the same way.
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

import fs from 'node:fs'
import path from 'node:path'

/**
 * The api suite is ONE suite split across two vitest projects that differ in one thing:
 * whether a test file gets a fresh module registry (`isolate`). Sharing the registry across
 * files in a worker removes ~1s of app-graph import per file; a file that mocks a module or
 * a global (`vi.mock`, `vi.stubGlobal`, spying on `globalThis.fetch`) would leak that fake
 * into every later file in the worker, so it must opt OUT by carrying this marker on its
 * FIRST line:
 *
 *     // @vitest-isolate
 *
 * This rule is imported by BOTH vitest.config.ts (decides where a file runs) and
 * tests/api/isolation-contract.test.ts (fails CI when a file needs the marker and lacks it),
 * so the two can never disagree.
 */
export const ISOLATE_MARKER = '// @vitest-isolate'

export function isMarkedIsolated(source: string): boolean {
  const firstLine = source.split('\n', 1)[0]?.trim() ?? ''
  return firstLine === ISOLATE_MARKER
}

/** Heuristic used only by the contract test to flag files that probably need the marker. */
export function looksLikeItNeedsIsolation(source: string): boolean {
  return /\bvi\.(mock|doMock|stubGlobal|stubEnv|spyOn\(\s*globalThis)/.test(source)
}

/** All *.test.ts files under `dir`, relative to it, recursively, sorted. */
export function apiTestFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.test\.ts$/.test(entry.name)) out.push(path.relative(dir, full))
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out.sort()
}

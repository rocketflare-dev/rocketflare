import fs from 'node:fs'
import path from 'node:path'

/**
 * The api suite is ONE suite split across two vitest projects that differ in one thing:
 * whether a test file gets a fresh module registry (`isolate`). Sharing the registry across
 * files in a worker removes ~1s of app-graph import per file. What a shared registry does NOT
 * undo is a module evaluated under a fake — `vi.mock` / `vi.doMock` leave it in the cache for
 * every later file in the worker, and `vi.resetModules` drops modules other files hold — so a
 * file doing either must opt OUT by carrying this marker on its FIRST line:
 *
 *     // @vitest-isolate
 *
 * Spies and stubs need no marker. Vitest restores every `vi.spyOn` spy after each file even
 * without isolation, and the per-file setups (`tests/api-setup.ts`, `tests/ui/setup.ts`,
 * `tests/config/setup.ts`) undo `vi.stubGlobal` and `vi.stubEnv`. Module-level state a test
 * mutates is the heuristic's blind spot: restore it in `afterAll`, or use the marker.
 *
 * This rule is imported by BOTH vitest.config.ts (decides where a file runs) and
 * tests/config/isolation-contract.test.ts (fails CI when a file needs the marker and lacks it),
 * so the two can never disagree.
 */
export const ISOLATE_MARKER = '// @vitest-isolate'

export function isMarkedIsolated(source: string): boolean {
  const firstLine = source.split('\n', 1)[0]?.trim() ?? ''
  return firstLine === ISOLATE_MARKER
}

/**
 * The `api-fixtures` project (`tests/api-fixtures-setup.ts`): a shared registry whose app has the
 * fixture agents (`tests/helpers/fixture-agents.ts`) installed in the plugin barrels. A file that
 * runs the fixture agents carries this on its FIRST line instead of mocking the barrels.
 */
export const FIXTURE_AGENTS_MARKER = '// @vitest-fixture-agents'

export function isMarkedFixtureAgents(source: string): boolean {
  const firstLine = source.split('\n', 1)[0]?.trim() ?? ''
  return firstLine === FIXTURE_AGENTS_MARKER
}

/** Heuristic used only by the contract test to flag files that probably need the marker. */
export function looksLikeItNeedsIsolation(source: string): boolean {
  return /\bvi\.(mock|doMock|resetModules)\b/.test(source)
}

/**
 * The ui suite is split the same way (`ui` shares a registry, `ui-isolated` does not), but a ui
 * file is routed by the heuristic itself, the marker being only a way to opt in by hand. A
 * plugin's ui tests live in the plugin's repository, so a rule that needed every mocking file
 * marked would break a host the day a plugin it already has shipped an unmarked one.
 */
export function uiNeedsIsolation(source: string): boolean {
  return isMarkedIsolated(source) || looksLikeItNeedsIsolation(source)
}

/** Every file under `dir` whose name matches `pattern`, relative to it, recursively, sorted. */
export function testFiles(dir: string, pattern: RegExp): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (pattern.test(entry.name)) out.push(path.relative(dir, full))
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out.sort()
}

/** All *.test.ts files under `dir`, relative to it, recursively, sorted. */
export function apiTestFiles(dir: string): string[] {
  return testFiles(dir, /\.test\.ts$/)
}

/**
 * Where one kind of test lives: the kit's `tests/<kind>`, then every installed plugin's
 * `src/plugins/<id>/tests/<kind>` (D31 — a plugin's tests move with it). `vitest.config.ts` routes
 * files from these directories and `tests/config/isolation-contract.test.ts` checks the same
 * ones, so a plugin's api test cannot escape the contract. `abs` is absolute, `rel` relative to
 * `webRoot` (`apps/web`).
 */
export function testDirs(
  webRoot: string,
  kind: 'api' | 'ui' | 'config'
): Array<{ abs: string; rel: string }> {
  const pluginsDir = path.join(webRoot, 'src/plugins')
  const plugins = fs.existsSync(pluginsDir)
    ? fs
        .readdirSync(pluginsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort()
    : []
  return [
    { abs: path.join(webRoot, 'tests', kind), rel: `tests/${kind}` },
    ...plugins.map(id => ({
      abs: path.join(pluginsDir, id, 'tests', kind),
      rel: `src/plugins/${id}/tests/${kind}`,
    })),
  ]
}

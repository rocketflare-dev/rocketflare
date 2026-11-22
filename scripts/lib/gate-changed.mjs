/**
 * `pnpm gate --changed` — the gate over what a branch changed, for local commits
 * (docs/CONCEPTS.md §4). The full `pnpm gate` still runs before a push and in CI; this is the
 * inner loop. Everything here is a pure decision over a list of changed paths, unit-tested in
 * `apps/web/tests/kit-only/gate-changed.test.ts`; `scripts/gate.mjs` and `scripts/test.mjs` do
 * the git and the spawning.
 *
 * The rule of the whole file: when in doubt, run more. A path this cannot reason about —
 * configuration, the lockfile, the test harness, the gate itself — makes the run the full gate.
 */

/**
 * Paths whose change can alter every result: dependencies, compiler and lint settings, the
 * vitest/vite configuration, the bindings, the database the suite migrates, the test harness and
 * the gate's own code. Any one of them turns `--changed` into the full gate.
 */
export const FULL_GATE_TRIGGERS = Object.freeze([
  '**/package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.nvmrc',
  'biome.json',
  '**/tsconfig*.json',
  'apps/*/vitest*.config.ts',
  'apps/web/vite.config.ts',
  'apps/web/wrangler*.toml',
  'apps/web/worker-configuration.d.ts',
  'apps/web/.env.test',
  'apps/web/docker-compose.test.yml',
  'apps/web/migrations/**',
  'apps/web/tests/setup.ts',
  'apps/web/tests/api-setup.ts',
  'apps/web/tests/ui/setup.ts',
  'apps/web/tests/helpers/**',
  'apps/web/tests/kit/**',
  'apps/web/tests/mocks/**',
  'scripts/gate.mjs',
  'scripts/test.mjs',
  'scripts/lib/gate-*',
  'scripts/lib/test-plan.*',
])

/**
 * Edges `package.json` does not declare. The eval kit's unit tests import `apps/web/src` through
 * an alias (`apps/evals/vitest.unit.config.ts`), so a web change re-tests it. By directory, which
 * the rename leaves alone.
 */
const IMPLICIT_DEPENDENTS = Object.freeze({ 'apps/web': ['apps/evals'] })

/**
 * Paths outside every package that a package compiles against: the root `scripts/` (their
 * `.d.mts` types are checked by the web tests that import them) and the rf-security runner.
 */
const ROOT_PATHS_OF = Object.freeze({
  'apps/web': ['scripts/**', '.claude/skills/rf-security/tools/**'],
})

/** `**` any depth, `*` within one segment; anchored. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if ('\\^$+?.()|{}[]'.includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`)
}

export function matchesAny(file, globs) {
  return globs.some(g => globToRegExp(g).test(file))
}

/**
 * The packages a change reaches: those it touches, and everything depending on them, transitively.
 * @param {string[]} files repo-relative paths
 * @param {{ dir: string, name: string, deps: string[] }[]} packages deps are package NAMES
 * @returns {string[]} package dirs, in the order given
 */
export function affectedPackages(files, packages) {
  const byName = new Map(packages.map(p => [p.name, p]))
  const touched = new Set()
  for (const p of packages) {
    const roots = ROOT_PATHS_OF[p.dir] ?? []
    if (files.some(f => f.startsWith(`${p.dir}/`) || matchesAny(f, roots))) touched.add(p.dir)
  }
  const dependents = new Map(packages.map(p => [p.dir, new Set(IMPLICIT_DEPENDENTS[p.dir] ?? [])]))
  for (const p of packages) {
    for (const dep of p.deps) {
      const d = byName.get(dep)
      if (d) dependents.get(d.dir)?.add(p.dir)
    }
  }
  const queue = [...touched]
  while (queue.length) {
    const dir = /** @type {string} */ (queue.shift())
    for (const next of dependents.get(dir) ?? []) {
      if (!touched.has(next)) {
        touched.add(next)
        queue.push(next)
      }
    }
  }
  return packages.map(p => p.dir).filter(d => touched.has(d))
}

/**
 * What `--changed` runs, or why it runs the full gate instead.
 * @param {{ changed: string[], existing: string[], packages: { dir: string, name: string, deps: string[], scripts: string[] }[] }} input
 *   `changed`: every path that differs (deleted ones included); `existing`: those still on disk
 */
export function planChanged({ changed, existing, packages }) {
  const trigger = changed.find(f => matchesAny(f, FULL_GATE_TRIGGERS))
  if (trigger) return { full: `${trigger} changed` }
  const affected = affectedPackages(changed, packages)
  const has = (dir, script) => packages.find(p => p.dir === dir)?.scripts.includes(script)
  return {
    lint: existing,
    typecheck: affected.filter(d => has(d, 'typecheck')),
    // The web suite also holds the repository's own guards (docs, skills, CLAUDE.md, the
    // workflows): any change at all gives it a selection pass; which files run is selectTests'.
    test: { web: changed.length > 0, packages: affected.filter(d => d !== 'apps/web') },
    build: affected.filter(d => has(d, 'build') && buildInputChanged(d, changed)),
  }
}

/**
 * A package's build input changed: one of its own files outside `tests/` and `scripts/` that is
 * not markdown, or — when none of its own files changed — a dependency's.
 */
function buildInputChanged(dir, changed) {
  const own = changed.filter(f => f.startsWith(`${dir}/`)).map(f => f.slice(dir.length + 1))
  if (own.length === 0) return true
  return own.some(f => !/^(tests|scripts)\//.test(f) && !f.endsWith('.md'))
}

/**
 * A test file that reads the repository through the filesystem or a child process: what it
 * depends on is invisible to vitest's import graph, so `--changed` runs it every time.
 */
export function readsFiles(source, fsHelpers = []) {
  if (/from ['"](node:)?(fs|fs\/promises|child_process)['"]/.test(source)) return true
  return fsHelpers.some(h => source.includes(h))
}

/**
 * The web test files `--changed` runs, per vitest project.
 * @param {{
 *   all: { file: string, project: string }[],
 *   related: { file: string, project: string }[],
 *   sources: Record<string, string>,
 *   changed: string[],
 *   fsHelpers?: string[],
 * }} input `file` paths are repo-relative; `related` is vitest's own `--changed` answer
 * @returns {Record<string, string[]>}
 */
export function selectTests({ all, related, sources, changed, fsHelpers = [] }) {
  const relatedKeys = new Set(related.map(t => `${t.project}\0${t.file}`))
  const out = {}
  for (const t of all) {
    const source = sources[t.file] ?? ''
    const run =
      relatedKeys.has(`${t.project}\0${t.file}`) ||
      changed.includes(t.file) ||
      readsFiles(source, fsHelpers)
    if (!run) continue
    out[t.project] = [...(out[t.project] ?? []), t.file]
  }
  return out
}

/**
 * `pnpm gate` — an app's checks, defined once (docs/CONCEPTS.md §4). The same command is the
 * pre-commit gate on a laptop, the one job in a copy's CI, and Launch's ship gate (which reads
 * `--list --json`, contract: `packages/shared/src/gate.ts`). `scripts/gate.mjs` executes; this file
 * holds the steps and the argument rules, unit-tested in `apps/web/tests/kit-only/gate.test.ts`.
 *
 * There is deliberately no step for generated files: `typecheck` regenerates
 * `worker-configuration.d.ts` (commit what changes), the `docs/plugin-api.md` diff is the kit's own
 * check (kit.yml), and `pnpm plugin check` runs at `plugin add|upgrade` and in plugin CI.
 */

export const GATE_LIST_SCHEMA_VERSION = 1

/** In run order. `command` is argv; `database` means the step needs a test database. */
export const GATE_STEPS = Object.freeze([
  {
    id: 'lint',
    command: ['pnpm', 'lint'],
    display: 'biome check . --error-on-warnings',
    database: false,
  },
  // `pnpm -r typecheck`: web runs `wrangler types` first, so it always compiles against fresh types.
  {
    id: 'typecheck',
    command: ['pnpm', 'typecheck'],
    display: 'pnpm -r typecheck',
    database: false,
  },
  // scripts/test.mjs: the target, the database and the conformance pass (lib/test-plan.mjs).
  { id: 'test', command: ['pnpm', 'test'], display: 'pnpm test', database: true },
  // web: vite build + a dry-run `wrangler deploy` (what catches a Node-only import); cli: tsc.
  { id: 'build', command: ['pnpm', 'build'], display: 'pnpm -r build', database: false },
])

export const GATE_USAGE = `usage: pnpm gate [step…] [--skip <step>]… [--keep-going] [--changed[=<ref>]] | --list [--json]

  pnpm gate                 every step, in order, stopping at the first failure
  pnpm gate test build      just those steps (still in gate order)
  pnpm gate --skip test     every step but that one (for iterating locally — CI never skips)
  pnpm gate --keep-going    run every step and report every failure
  pnpm gate --changed       only what the branch changed (since the merge base with origin/main,
                            plus uncommitted files) — for local commits; the full gate runs
                            before a push. --changed=<ref> names the base
  pnpm gate --list [--json] the steps; --json is the contract Launch reads

steps: ${GATE_STEPS.map(s => s.id).join(', ')}`

/** The `--list --json` document. */
export function gateList() {
  return {
    schema: GATE_LIST_SCHEMA_VERSION,
    steps: GATE_STEPS.map(({ id, display, database }) => ({ id, command: display, database })),
  }
}

/**
 * @param {string[]} argv
 * @returns {{ list: boolean, json: boolean, keepGoing: boolean, changed: string | null, steps: string[] } | { error: string } | { help: true }}
 *   `changed`: null for the full gate, '' for `--changed` (the default base), else the named ref
 */
export function parseGateArgs(argv) {
  const ids = GATE_STEPS.map(s => s.id)
  const named = []
  const skipped = []
  let list = false
  let json = false
  let keepGoing = false
  /** @type {string | null} */
  let changed = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--list') list = true
    else if (arg === '--json') json = true
    else if (arg === '--keep-going') keepGoing = true
    else if (arg === '--changed') changed = ''
    else if (arg.startsWith('--changed=')) {
      changed = arg.slice('--changed='.length)
      if (!changed) return { error: '--changed= needs a ref (or drop the =)' }
    } else if (arg === '--skip' || arg.startsWith('--skip=')) {
      const value = arg === '--skip' ? argv[++i] : arg.slice('--skip='.length)
      if (!value || !ids.includes(value)) {
        return { error: `--skip needs a step (${ids.join(', ')}), got '${value ?? ''}'` }
      }
      skipped.push(value)
    } else if (arg.startsWith('-')) return { error: `unknown option '${arg}'` }
    else if (ids.includes(arg)) named.push(arg)
    else return { error: `unknown step '${arg}' (steps: ${ids.join(', ')})` }
  }
  if (json && !list) return { error: '--json only applies to --list' }
  if (list && (named.length || skipped.length || keepGoing || changed !== null)) {
    return { error: '--list takes no steps, --skip, --keep-going or --changed' }
  }
  const wanted = named.length ? named : ids
  const steps = ids.filter(id => wanted.includes(id) && !skipped.includes(id))
  if (!list && steps.length === 0) return { error: 'nothing left to run' }
  return { list, json, keepGoing, changed, steps }
}

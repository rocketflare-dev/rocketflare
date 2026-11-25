/**
 * A synthetic audit run for the rf-security runner's tests: a throwaway runs root under the OS
 * temp directory, a tiny invented target checkout, and helpers that play the agents' part by
 * writing result files where an agent would. Nothing here comes from a real run.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL = fileURLToPath(
  new URL('../../../../../.claude/skills/rf-security', import.meta.url)
)
export const AUDIT = path.join(SKILL, 'tools', 'audit.mjs')
export const GUARD = path.join(SKILL, 'tools', 'guard-hook.mjs')

const WIDGETS = [
  "import { db } from './db'",
  '',
  'export async function loadWidget(id: string) {',
  '  return db.widgets.find(id)',
  '}',
  '',
  'export async function saveWidget(id: string, body: unknown) {',
  '  return db.widgets.update(id, body)',
  '}',
].join('\n')
const GADGETS = ['export function priceGadget(n: number) {', '  return n * 2', '}'].join('\n')

export type Run = ReturnType<typeof makeRun>

export function makeRun(profile = 'standard') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-security-test-'))
  const runs = path.join(tmp, 'runs')
  const run = path.join(runs, 'demo', 'run-1')
  const host = path.join(tmp, 'host')
  fs.mkdirSync(path.join(host, 'src'), { recursive: true })
  fs.writeFileSync(path.join(host, 'src', 'widgets.ts'), WIDGETS)
  fs.writeFileSync(path.join(host, 'src', 'gadgets.ts'), GADGETS)
  fs.mkdirSync(path.join(run, 'agents'), { recursive: true })
  const meta = {
    run_id: 'run-1',
    repo: 'demo',
    target: host,
    source_ref: {
      kit: 'a'.repeat(40),
      ref: 'HEAD',
      dirty_worktree: false,
      installed_tree: 'b'.repeat(40),
    },
    profile,
    scope_paths: [],
    scope: null,
    budget: 50,
    budget_plan: {
      profile,
      total: 50,
      recon: 4,
      critics: 2,
      final_follow_up: 2,
      validation: 21,
      hunters: 21,
      ok: true,
    },
    execution_policy: 'sandboxed-source-and-local-only',
    selected_companions: [],
    prior_runs: [],
    shared_file_owners: {},
    models: { hunters: 'model-a', verifiers: 'model-b' },
    run_status: 'in_progress',
    started: '2026-01-01T00:00:00.000Z',
  }
  writeJson(path.join(run, 'run-metadata.json'), meta)
  fs.writeFileSync(
    path.join(run, 'architecture.md'),
    '# Demo architecture\n\nTwo invented modules.\n'
  )

  const audit = (...args: string[]) => {
    const r = spawnSync('node', [AUDIT, ...args, '--run', run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RF_SECURITY_RUNS: runs,
        RF_SECURITY_TRANSCRIPTS: path.join(tmp, 'none'),
      },
    })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const file = (...p: string[]) => path.join(run, ...p)
  const read = (...p: string[]) => JSON.parse(fs.readFileSync(file(...p), 'utf8'))
  const has = (...p: string[]) => fs.existsSync(file(...p))
  const ledger = (): any[] => read('coverage-ledger.json')
  const unitsOf = (id: string) => ledger().filter(u => u.agent_id === id)
  /** Writes what an agent hands back, where it would write it. */
  const agentWrites = (id: string, value: unknown) =>
    writeJson(file('agents', id, 'scratch', 'result.json'), value)
  return { tmp, run, host, audit, file, read, has, ledger, unitsOf, agentWrites }
}

export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** Wave 1: two hunters, one unit each. */
export function planWave1(r: Run) {
  writeJson(r.file('plan.json'), {
    wave: 1,
    excluded: [],
    hunters: [
      {
        id: 'h01-widgets',
        subsystem: 'src',
        surface: 'widget reads and writes by id',
        boundary: 'src/widgets.ts#loadWidget',
        paths: ['src/widgets.ts'],
        classes: ['O:Access control'],
      },
      {
        id: 'h02-gadgets',
        subsystem: 'src',
        surface: 'gadget pricing',
        boundary: 'src/gadgets.ts#priceGadget',
        paths: ['src/gadgets.ts'],
        classes: ['O:Business logic'],
      },
    ],
  })
  return r.audit('hunters', r.file('plan.json'))
}

const check = (agent: string, file: string) => ({
  agent_id: agent,
  reviewed_paths: [file],
  invariant: 'Every read checks the caller owns the object.',
  method: 'source',
  result: 'Read the handler end to end.',
  artifact: null,
})

/** A hunter's result for each of its units: `candidate` with the fingerprints, else `covered`. */
export function hunterResult(r: Run, id: string, file: string, fingerprints: string[] = []) {
  const units = r.unitsOf(id).map(u => ({
    coverage_id: u.coverage_id,
    disposition: fingerprints.length ? 'candidate' : 'covered',
    reviewed_paths: [file],
    checks: [check(id, file)],
    candidate_fingerprints: fingerprints,
    unresolved: [],
  }))
  const candidates = fingerprints.map(fp => ({
    proposed_verdict: 'needs_validation',
    fingerprint: fp,
    title: 'Widget read skips the owner check',
    description: `Candidate ${fp}: loadWidget returns any widget by id.`,
    root_cause: 'No owner filter.',
    trace: [{ kind: 'entrypoint', file, line: 3, scope: 'loadWidget', description: 'entry' }],
  }))
  r.agentWrites(id, { units, candidates, hardening: [], uncovered: [] })
}

/** A needs_validation record citing the synthetic target. */
export function record(fingerprint: string, title = 'Widget read skips the owner check') {
  return {
    verdict: 'needs_validation',
    fingerprint,
    title,
    description: 'loadWidget returns a widget without checking who owns it.',
    claimed_root_cause: 'The query filters by id alone.',
    trace: [
      {
        kind: 'entrypoint',
        file: 'src/widgets.ts',
        line: 3,
        scope: 'loadWidget',
        description: 'The read entry.',
      },
      {
        kind: 'sink',
        file: 'src/widgets.ts',
        line: 4,
        scope: 'loadWidget',
        description: 'The unscoped query.',
      },
    ],
    evidence: [{ file: 'src/widgets.ts', line: 4, description: 'No owner filter in the query.' }],
    blockers: ['Whether the db layer adds an owner filter is not visible in source.'],
    validation_plan: { local: 'Call loadWidget for a widget owned by another user in a test.' },
  }
}

/** Wave 1 hunted and ingested: h01 reports `fp`, h02 covers its unit. */
export function huntedWave1(r: Run, fp = 'widget-read-unscoped:src/widgets.ts:loadWidget') {
  planWave1(r)
  hunterResult(r, 'h01-widgets', 'src/widgets.ts', [fp])
  hunterResult(r, 'h02-gadgets', 'src/gadgets.ts')
  r.audit('collect')
  return r.audit('ingest')
}

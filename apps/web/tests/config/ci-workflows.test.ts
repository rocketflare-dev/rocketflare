/**
 * The guards that decide what `ci.yml` and `deploy.yml` run, and where.
 *
 * Promises that live only in YAML, where nothing else would notice them regress:
 *   - `ci.yml`'s gate job runs `pnpm gate` and adds nothing of its own but the secrets scan — so
 *     what passes in CI is what passes on a laptop and in Launch's ship gate (docs/CONCEPTS.md §4).
 *     No `test-neon`, no `services:` database beside the compose file, no `--skip`;
 *   - nothing is deployed, or gated, when there is nothing to deploy (`guard`);
 *   - a commit is gated ONCE: `deploy.yml` skips `ci` when the commit already has a green CI run,
 *     and `staging` deploys only after a passing `ci` or that proof — never after a failed one.
 *
 * There is no YAML parser in the workspace, so the jobs are read by indentation (two spaces under
 * `jobs:`), which is all these files use. The `gated` job's shell is run for real against a stub
 * `gh`, because its failure mode is the security property: any doubt must mean "gate here".
 * The kit's OWN workflow (kit.yml) is pinned by `tests/kit-only/kit-workflow.test.ts`: a copy has
 * none. The `config` project: no database.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const read = (f: string) => readFileSync(path.join(REPO_ROOT, '.github/workflows', f), 'utf8')
const CI = read('ci.yml')
const DEPLOY = read('deploy.yml')

/** The lines of one job: from `  <id>:` to the next two-space key (comments excluded). */
function job(workflow: string, id: string): string[] {
  const lines = workflow.split('\n')
  const start = lines.indexOf(`  ${id}:`)
  expect(start, `job ${id}`).toBeGreaterThan(-1)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => /^ {0,2}[\w-]+:/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).filter(l => !l.trim().startsWith('#'))
}

/** A job-level key's value, a `|` block folded onto one whitespace-normalised line. */
function key(lines: string[], name: string): string | undefined {
  const i = lines.findIndex(l => l.startsWith(`    ${name}:`))
  if (i === -1) return undefined
  const inline = (lines[i] ?? '').slice(`    ${name}:`.length).trim()
  if (inline !== '|') return inline
  const body: string[] = []
  for (const l of lines.slice(i + 1)) {
    if (!l.startsWith('      ') && l.trim() !== '') break
    body.push(l.trim())
  }
  return body.join(' ').replace(/\s+/g, ' ').trim()
}

/** Every command a job's steps run: a `run: x` line, or each line of a `run: |` block. */
function commands(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(/^(\s*)(?:- )?run: (.*)$/)
    if (!m) continue
    if (m[2]?.trim() !== '|') {
      out.push(m[2]?.trim() ?? '')
      continue
    }
    const indent = (lines[i + 1] ?? '').match(/^ */)?.[0].length ?? 0
    for (const l of lines.slice(i + 1)) {
      if (l.trim() !== '' && !l.startsWith(' '.repeat(indent))) break
      if (l.trim()) out.push(l.trim())
    }
  }
  return out
}

describe('ci.yml', () => {
  it('has a gate job that runs pnpm gate, last', () => {
    const gate = commands(job(CI, 'gate'))
    expect(gate.at(-1)).toBe('pnpm gate')
    expect(key(job(CI, 'gate'), 'if')).toBeUndefined()
  })

  it('adds nothing of substance to the gate but the secrets scan', () => {
    const substantive = commands(job(CI, 'gate')).filter(
      c =>
        c !== 'pnpm gate' &&
        c !== 'pnpm install --frozen-lockfile' &&
        !c.startsWith('nohup docker compose -f apps/web/docker-compose.test.yml') &&
        !c.startsWith('> "$RUNNER_TEMP/pull.log"') &&
        !/gitleaks/.test(c)
    )
    expect(substantive).toEqual([])
  })

  it('has no second test job, no services: database and no skipped step', () => {
    expect(CI.split('\n')).not.toContain('  test-neon:')
    expect(CI).not.toMatch(/^\s+services:/m)
    expect(CI).not.toMatch(/pnpm gate[^\n]*--skip/)
    expect(CI).not.toMatch(/inputs\.deploy/)
  })

  it('is callable from deploy.yml, with no inputs', () => {
    expect(CI).toMatch(/\n {2}workflow_call:\n(?! {4}inputs:)/)
  })
})

describe('deploy.yml', () => {
  const TRIGGER = [
    "(github.event_name == 'push' && github.ref_type == 'tag') ||",
    "(github.event_name == 'workflow_dispatch' && inputs.environment == 'staging')",
  ].join(' ')

  it('keeps the kit’s “Anything to deploy?” guard in front of both deploy jobs', () => {
    expect(key(job(DEPLOY, 'guard'), 'name')).toBe('Anything to deploy?')
    expect(job(DEPLOY, 'guard').join('\n')).toContain('node scripts/release-check.mjs --deployable')
    expect(key(job(DEPLOY, 'staging'), 'if')).toContain("needs.guard.outputs.deployable == 'true'")
    expect(key(job(DEPLOY, 'production'), 'if')).toContain(
      "needs.guard.outputs.deployable == 'true'"
    )
  })

  it('asks whether the commit is already gated, with read access to Actions', () => {
    const gated = job(DEPLOY, 'gated')
    expect(key(gated, 'needs')).toBe('guard')
    expect(key(gated, 'if')).toBe(`needs.guard.outputs.deployable == 'true' && ( ${TRIGGER} )`)
    expect(gated.join('\n')).toMatch(/permissions:\n\s+actions: read/)
    expect(gated.join('\n')).toContain('actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA')
  })

  it('calls ci.yml only when there is something to deploy and the commit is not yet gated', () => {
    const ci = job(DEPLOY, 'ci')
    expect(key(ci, 'needs')).toBe('[guard, gated]')
    expect(key(ci, 'uses')).toBe('./.github/workflows/ci.yml')
    expect(ci.join('\n')).not.toMatch(/with:/)
    expect(key(ci, 'if')).toBe(
      "!cancelled() && needs.guard.outputs.deployable == 'true' && " +
        `needs.gated.outputs.gated != 'true' && ( ${TRIGGER} )`
    )
  })

  it('checks parity with ONLY the parity test in both deploy jobs (their checkout has no history)', () => {
    for (const id of ['staging', 'production']) {
      const text = job(DEPLOY, id).join('\n')
      expect(text, id).toContain('test:config tests/config/wrangler-parity.test.ts')
      // The whole config project reads git history (upgrade-lib's mirror tests), which a
      // depth-1 checkout does not have: that is how the first real app deploy failed.
      expect(text, id).not.toMatch(/test:config\s*$/m)
    }
  })

  it('deploys staging after a passing ci, or a ci skipped on proof — never after a failed one', () => {
    const staging = job(DEPLOY, 'staging')
    expect(key(staging, 'needs')).toBe('[guard, gated, ci]')
    expect(key(staging, 'if')).toBe(
      `!cancelled() && needs.guard.outputs.deployable == 'true' && ( ${TRIGGER} ) && ( ` +
        "needs.ci.result == 'success' || " +
        "(needs.ci.result == 'skipped' && needs.gated.outputs.gated == 'true') )"
    )
  })
})

describe('deploy.yml `gated` step', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** The step's `run: |` block, de-indented as the YAML block scalar is. */
  function script(): string {
    const lines = job(DEPLOY, 'gated')
    const start = lines.findIndex(l => l.trim() === 'run: |')
    const indent = (lines[start + 1] ?? '').match(/^ */)?.[0].length ?? 0
    const body: string[] = []
    for (const l of lines.slice(start + 1)) {
      if (l.trim() !== '' && !l.startsWith(' '.repeat(indent))) break
      body.push(l.slice(indent))
    }
    return body.join('\n')
  }

  /** Runs the step with a stub `gh` that prints `out` and exits `code`; returns GITHUB_OUTPUT. */
  function run(out: string, code = 0): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'gated-'))
    dirs.push(dir)
    const gh = path.join(dir, 'gh')
    writeFileSync(gh, `#!/bin/sh\nprintf '%s' '${out}'\nexit ${code}\n`)
    chmodSync(gh, 0o755)
    const output = path.join(dir, 'output')
    writeFileSync(output, '')
    const r = spawnSync('bash', ['-c', script()], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'acme/app',
        GITHUB_SHA: 'abc123',
      },
      encoding: 'utf8',
    })
    expect(r.status, r.stderr).toBe(0)
    return readFileSync(output, 'utf8').trim()
  }

  it('is gated when a successful CI run exists', () => {
    expect(run('2')).toBe('gated=true')
  })

  it('gates here when there is none', () => {
    expect(run('0')).toBe('gated=false')
  })

  it('gates here when the API fails or answers something that is not a count', () => {
    expect(run('HTTP 403: Resource not accessible by integration', 1)).toBe('gated=false')
    expect(run('')).toBe('gated=false')
    expect(run('null')).toBe('gated=false')
  })
})

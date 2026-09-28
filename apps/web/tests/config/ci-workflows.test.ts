/**
 * The guards that decide what `ci.yml` and `deploy.yml` run, and where.
 *
 * Three promises live only in YAML expressions, where nothing else would notice them regress:
 *   - the default-plugins gate is KIT-ONLY (a copy's plugins are committed, so `check` covers them);
 *   - the deploy path skips `test-neon` (`deploy: true`), and PR/push CI does not;
 *   - a commit is gated ONCE: `deploy.yml` skips `ci` when the commit already has a green CI run,
 *     and `staging` deploys only after a passing `ci` or that proof — never after a failed one.
 *
 * There is no YAML parser in the workspace, so the jobs are read by indentation (two spaces under
 * `jobs:`), which is all these files use. The `gated` job's shell is run for real against a stub
 * `gh`, because its failure mode is the security property: any doubt must mean "gate here".
 * The `config` project: no database.
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
const KIT_ONLY = "github.repository == 'rocketflare-dev/rocketflare'"

/** The lines of one job: from `  <id>:` to the next two-space key (comments excluded). */
function job(workflow: string, id: string): string[] {
  const lines = workflow.split('\n')
  const start = lines.indexOf(`  ${id}:`)
  expect(start, `job ${id}`).toBeGreaterThan(-1)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => /^ {0,2}[\w-]+:/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).filter(l => !l.trim().startsWith('#'))
}

/** A copy may delete `renamed` (kit-only anyway) and `test-neon` (docs/NEON-DRIVER.md §5). */
const hasJob = (workflow: string, id: string) => workflow.split('\n').includes(`  ${id}:`)

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

describe('ci.yml', () => {
  it('runs the default-plugins gate only in the kit’s own repository', () => {
    expect(key(job(CI, 'default-plugins'), 'if')).toBe(KIT_ONLY)
    const plugins = job(CI, 'plugins')
    expect(key(plugins, 'if')).toContain(KIT_ONLY)
    expect(key(plugins, 'if')).toContain("needs.default-plugins.outputs.count != '0'")
    if (hasJob(CI, 'renamed')) expect(key(job(CI, 'renamed'), 'if')).toBe(KIT_ONLY)
  })

  it('runs the ordinary gate and the plugin audit everywhere, deploy path included', () => {
    expect(key(job(CI, 'check'), 'if')).toBeUndefined()
    expect(key(job(CI, 'plugin-check'), 'if')).toBeUndefined()
  })

  it('declares the `deploy` input and skips only test-neon with it', () => {
    expect(CI).toMatch(
      /workflow_call:\n {4}inputs:\n {6}deploy:\n[\s\S]*?type: boolean\n\s+default: false/
    )
    if (hasJob(CI, 'test-neon')) {
      expect(key(job(CI, 'test-neon'), 'if')).toBe('${{ !inputs.deploy }}')
    }
  })

  it('keeps the kit’s literal through the rename, which is what makes the guard kit-only', async () => {
    const { KIT } = await import('../../../../scripts/lib/rename-lib.mjs')
    const pattern = new RegExp(KIT.preservedPattern.source)
    expect(pattern.exec(KIT_ONLY)?.[0]).toBe('rocketflare-dev/rocketflare')
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
    expect(key(gated, 'if')).toBe(TRIGGER)
    expect(gated.join('\n')).toMatch(/permissions:\n\s+actions: read/)
    expect(gated.join('\n')).toContain('actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA')
  })

  it('calls ci.yml with deploy: true, and skips it only when the commit is already gated', () => {
    const ci = job(DEPLOY, 'ci')
    expect(key(ci, 'needs')).toBe('gated')
    expect(key(ci, 'uses')).toBe('./.github/workflows/ci.yml')
    expect(ci.join('\n')).toMatch(/with:\n\s+deploy: true/)
    expect(key(ci, 'if')).toBe(
      `!cancelled() && needs.gated.outputs.gated != 'true' && ( ${TRIGGER} )`
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

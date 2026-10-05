/**
 * The guards that decide what `ci.yml` and `deploy.yml` run, and where.
 *
 * Promises that live only in YAML, where nothing else would notice them regress:
 *   - `ci.yml`'s gate job runs `pnpm gate` and adds nothing of its own but the secrets scan — so
 *     what passes in CI is what passes on a laptop and in Launch's ship gate (docs/CONCEPTS.md §4).
 *     No `test-neon`, no `services:` database beside the compose file, no `--skip`. The one
 *     narrowing is `pnpm gate build` on a tree Launch already gated, opt-in through
 *     LAUNCH_GATE_APP_ID (the lookup's rules: `gate-verified.test.ts`);
 *   - nothing is deployed, or gated, when there is nothing to deploy (`guard`);
 *   - a commit is gated ONCE: `deploy.yml` skips `ci` when the commit already has a green CI run,
 *     or is a version-only bump over a parent that has one, and `staging` deploys only after a
 *     passing `ci` or that proof — never after a failed one.
 *
 * There is no YAML parser in the workspace, so the jobs are read by indentation (two spaces under
 * `jobs:`), which is all these files use. The `gated` job's decision is `gatedDecision` in
 * `scripts/release-check.mjs`, driven here with a fake API and once for real against a stub `gh`
 * and a scratch git repository, because its failure mode is the security property: any doubt must
 * mean "gate here". `--version-only` itself is `tests/config/release-version-only.test.ts`.
 * The kit's OWN workflow (kit.yml) is pinned by `tests/kit-only/kit-workflow.test.ts`: a copy has
 * none. The `config` project: no database.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gatedDecision, successfulCiRuns } from '../../../../scripts/release-check.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const read = (f: string) => readFileSync(path.join(REPO_ROOT, '.github/workflows', f), 'utf8')
const CI = read('ci.yml')
const DEPLOY = read('deploy.yml')

/** A GitHub Actions expression, `${{ … }}`, as the workflow writes it. */
const expr = (inner: string) => `\${{ ${inner} }}`

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
  it('has a gate job that runs pnpm gate, last — and is never skipped', () => {
    const gate = commands(job(CI, 'gate'))
    expect(gate.at(-1)).toBe('pnpm gate')
    // `!cancelled()` and nothing else: a skipped or failed `verified` must still run the gate.
    expect(key(job(CI, 'gate'), 'if')).toBe(expr('!cancelled()'))
    expect(key(job(CI, 'gate'), 'needs')).toBe('verified')
  })

  it('adds nothing of substance to the gate but the secrets scan (and the scope it decides)', () => {
    const substantive = commands(job(CI, 'gate')).filter(
      c =>
        c !== 'pnpm gate' &&
        c !== 'pnpm gate build' &&
        c !== 'pnpm install --frozen-lockfile' &&
        !c.startsWith('nohup docker compose -f apps/web/docker-compose.test.yml') &&
        !c.startsWith('> "$RUNNER_TEMP/pull.log"') &&
        !/gitleaks/.test(c) &&
        // the `scope` step's shell
        !/^(if \[ "\$VERIFIED"|echo "reuse=|echo "Launch gated|else|fi)/.test(c)
    )
    expect(substantive).toEqual([])
  })

  it('runs the full gate unless the scope step proved this tree was gated by Launch', () => {
    const text = job(CI, 'gate').join('\n')
    // The full gate is the fallback: any output but `true` (empty, `false`) runs it.
    expect(text).toMatch(/- if: steps\.scope\.outputs\.reuse != 'true'\n\s+run: pnpm gate\n/)
    expect(text).toMatch(/if: steps\.scope\.outputs\.reuse == 'true'\n\s+run: pnpm gate build\n/)
    // gitleaks is never conditional.
    const gitleaks = text.indexOf('- name: gitleaks')
    expect(text.slice(gitleaks, text.indexOf('run:', gitleaks))).not.toMatch(/if:/)
    // reuse needs the verified output AND the same tree, re-read in this job.
    expect(text).toContain('[ "$VERIFIED" = "true" ]')
    expect(text).toContain(`[ "$(git rev-parse 'HEAD^{tree}')" = "$TREE" ]`)
  })

  it('looks up a Launch attestation only when LAUNCH_GATE_APP_ID is set, with read scopes', () => {
    const verified = job(CI, 'verified')
    expect(key(verified, 'if')).toBe("vars.LAUNCH_GATE_APP_ID != ''")
    const text = verified.join('\n')
    expect(text).toMatch(
      /permissions:\n\s+contents: read\n\s+checks: read\n\s+pull-requests: read\n/
    )
    expect(commands(verified)).toEqual(['node scripts/gate-verified.mjs'])
    expect(text).toContain(`PR_HEAD_SHA: ${expr('github.event.pull_request.head.sha')}`)
    // The first job, and the only other one.
    const jobs = CI.slice(CI.indexOf('\njobs:\n'))
      .split('\n')
      .filter(l => /^ {2}[\w-]+:$/.test(l))
    expect(jobs).toEqual(['  verified:', '  gate:'])
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
    // The parent has to be in the clone for the version-only rule to diff against it.
    expect(gated.join('\n')).toMatch(/actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 2/)
    expect(commands(gated)).toEqual(['node scripts/release-check.mjs --gated "$GITHUB_SHA"'])
  })

  it('calls ci.yml only when there is something to deploy and the commit is not yet gated', () => {
    const ci = job(DEPLOY, 'ci')
    expect(key(ci, 'needs')).toBe('[guard, gated]')
    expect(key(ci, 'uses')).toBe('./.github/workflows/ci.yml')
    expect(ci.join('\n')).not.toMatch(/with:/)
    // ci.yml's `verified` job asks for these; a called workflow cannot exceed its caller's grant.
    expect(ci.join('\n')).toMatch(
      /permissions:\n\s+contents: read\n\s+checks: read\n\s+pull-requests: read\n/
    )
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

const SHA = 'a'.repeat(40)
const PARENT = 'b'.repeat(40)

describe('gatedDecision (deploy.yml `gated`)', () => {
  const versionOnly =
    (problems: string[] = []) =>
    () => ({ parent: PARENT, problems })
  const runs = (counts: Record<string, number | null>) => (sha: string) => counts[sha] ?? 0

  it('(a) is gated when the commit itself has a successful CI run — today’s rule', () => {
    const asked: string[] = []
    const d = gatedDecision({
      sha: SHA,
      runs: sha => {
        asked.push(sha)
        return 2
      },
      versionOnly: () => {
        throw new Error('the parent must not be consulted once the commit itself is gated')
      },
    })
    expect(d.gated).toBe(true)
    expect(asked).toEqual([SHA])
  })

  it('(b) is gated when it is a version-only bump over a parent with a successful run', () => {
    const d = gatedDecision({ sha: SHA, runs: runs({ [PARENT]: 1 }), versionOnly: versionOnly() })
    expect(d).toEqual({
      gated: true,
      reason: expect.stringContaining(`version-only bump over ${PARENT}`),
    })
  })

  it('gates here when the bump is version-only but the parent has no successful run (yet)', () => {
    // A parent whose CI is still running counts as none: the API is asked for completed,
    // successful runs only, so the deploy gates itself rather than waiting.
    const d = gatedDecision({ sha: SHA, runs: runs({}), versionOnly: versionOnly() })
    expect(d.gated).toBe(false)
  })

  it('gates here when the commit is not version-only, however green its parent is', () => {
    const d = gatedDecision({
      sha: SHA,
      runs: runs({ [PARENT]: 5 }),
      versionOnly: versionOnly(['files other than the root package.json changed: src/a.ts']),
    })
    expect(d.gated).toBe(false)
    expect(d.reason).toContain('src/a.ts')
  })

  it('treats an unreadable API as no proof, for the commit and for its parent', () => {
    expect(gatedDecision({ sha: SHA, runs: () => null, versionOnly: versionOnly() }).gated).toBe(
      false
    )
    expect(
      gatedDecision({
        sha: SHA,
        runs: runs({ [SHA]: null, [PARENT]: null }),
        versionOnly: versionOnly(),
      }).gated
    ).toBe(false)
  })

  it('gates here when the version-only check itself throws', () => {
    const d = gatedDecision({
      sha: SHA,
      runs: runs({ [PARENT]: 1 }),
      versionOnly: () => {
        throw new Error('git exploded')
      },
    })
    expect(d).toEqual({ gated: false, reason: expect.stringContaining('git exploded') })
  })
})

describe('successfulCiRuns', () => {
  const exec = (body: string | Error) => () => {
    if (body instanceof Error) throw body
    return body
  }
  const runsBody = (runs: object[]) =>
    JSON.stringify({ total_count: runs.length, workflow_runs: runs })

  it('counts completed, successful push and pull_request runs on exactly that sha', () => {
    const body = runsBody([
      { event: 'push', conclusion: 'success', head_sha: SHA },
      { event: 'pull_request', conclusion: 'success', head_sha: SHA },
      { event: 'workflow_call', conclusion: 'success', head_sha: SHA },
      { event: 'push', conclusion: null, head_sha: SHA },
      { event: 'push', conclusion: 'success', head_sha: PARENT },
    ])
    expect(successfulCiRuns('acme/app', SHA, { exec: exec(body) })).toBe(2)
  })

  it('asks for the ci.yml runs of that sha', () => {
    const calls: string[][] = []
    successfulCiRuns('acme/app', SHA, {
      exec: (cmd, args) => {
        calls.push([cmd, ...args])
        return runsBody([])
      },
    })
    expect(calls).toEqual([
      [
        'gh',
        'api',
        `repos/acme/app/actions/workflows/ci.yml/runs?head_sha=${SHA}&status=success&per_page=100`,
      ],
    ])
  })

  it('answers null — no proof — when the API fails or answers something unexpected', () => {
    expect(successfulCiRuns('acme/app', SHA, { exec: exec(new Error('HTTP 403')) })).toBeNull()
    expect(successfulCiRuns('acme/app', SHA, { exec: exec('') })).toBeNull()
    expect(successfulCiRuns('acme/app', SHA, { exec: exec('null') })).toBeNull()
    expect(successfulCiRuns('acme/app', SHA, { exec: exec('{"message":"Not Found"}') })).toBeNull()
  })
})

describe('deploy.yml `gated` step, for real', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false']
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', [...GIT, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()

  /** A two-commit repository whose second commit is a version bump, or `edit` when given. */
  function repo(edit?: (dir: string) => void): { dir: string; head: string; parent: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'gated-repo-'))
    dirs.push(dir)
    const pkg = (version: string) =>
      `${JSON.stringify({ name: 'app', version, private: true }, null, 2)}\n`
    writeFileSync(path.join(dir, 'package.json'), pkg('1.0.0'))
    git(dir, ['init', '-q'])
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'feature'])
    if (edit) edit(dir)
    else writeFileSync(path.join(dir, 'package.json'), pkg('1.0.1'))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'release: 1.0.1'])
    return { dir, head: git(dir, ['rev-parse', 'HEAD']), parent: git(dir, ['rev-parse', 'HEAD^']) }
  }

  /**
   * Runs the step's command with a stub `gh` that reports `green` shas as having one successful run
   * (or fails outright with `fail`); returns GITHUB_OUTPUT.
   */
  function run(r: { dir: string; head: string }, green: string[], fail = false): string {
    const bin = mkdtempSync(path.join(tmpdir(), 'gated-bin-'))
    dirs.push(bin)
    const runsFor = (sha: string) =>
      JSON.stringify({ workflow_runs: [{ event: 'push', conclusion: 'success', head_sha: sha }] })
    const cases = green
      .map(sha => `  *head_sha=${sha}*) printf '%s' '${runsFor(sha)}' ;;`)
      .join('\n')
    writeFileSync(
      path.join(bin, 'gh'),
      fail
        ? '#!/bin/sh\necho "HTTP 403: Resource not accessible by integration" >&2\nexit 1\n'
        : `#!/bin/sh\ncase "$2" in\n${cases}\n  *) printf '%s' '{"workflow_runs":[]}' ;;\nesac\n`
    )
    chmodSync(path.join(bin, 'gh'), 0o755)
    const output = path.join(bin, 'output')
    writeFileSync(output, '')
    const p = spawnSync(
      'node',
      [path.join(REPO_ROOT, 'scripts/release-check.mjs'), '--gated', r.head, '--repo-root', r.dir],
      {
        cwd: r.dir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: 'acme/app',
        },
        encoding: 'utf8',
      }
    )
    expect(p.status, p.stderr).toBe(0)
    return readFileSync(output, 'utf8').trim()
  }

  it('is gated when the commit itself has a successful CI run', () => {
    const r = repo(dir => writeFileSync(path.join(dir, 'src.ts'), 'x'))
    expect(run(r, [r.head])).toBe('gated=true')
  })

  it('is gated when a version-only bump sits on a green parent', () => {
    const r = repo()
    expect(run(r, [r.parent])).toBe('gated=true')
  })

  it('gates here when neither the commit nor (for a version bump) its parent is green', () => {
    expect(run(repo(), [])).toBe('gated=false')
  })

  it('gates here when the commit changed code, even over a green parent', () => {
    const r = repo(dir => writeFileSync(path.join(dir, 'src.ts'), 'x'))
    expect(run(r, [r.parent])).toBe('gated=false')
  })

  it('gates here when the API fails', () => {
    const r = repo()
    expect(run(r, [r.parent], true)).toBe('gated=false')
  })
})

/**
 * Build once (deployer path, docs/DEPLOYER.md → Build once). `scripts/bundle.mjs` and its tests
 * (`bundle.test.ts`, `bundle-lib.test.ts`) hold the logic; these pin the wiring that only YAML has.
 */
describe('deploy.yml build once', () => {
  const step = (lines: string[], name: string) => {
    const i = lines.findIndex(
      l => l.trim() === `- name: ${name}` || l.trim() === `- name: "${name}"`
    )
    expect(i, name).toBeGreaterThan(-1)
    const rest = lines.slice(i + 1)
    const end = rest.findIndex(l => /^ {6}- /.test(l))
    return [lines[i] ?? '', ...(end === -1 ? rest : rest.slice(0, end))].join('\n')
  }

  it('promotes on `release: published` only — a draft fires no such event', () => {
    expect(DEPLOY).toMatch(/\n {2}release:\n {4}types: \[published\]\n/)
  })

  it('attaches the bundle from its own job: contents: write, nothing installed or built', () => {
    const attach = job(DEPLOY, 'release-bundle')
    expect(key(attach, 'needs')).toBe('staging')
    expect(key(attach, 'if')).toBe(
      "!cancelled() && needs.staging.result == 'success' && " +
        "vars.DEPLOYER_URL != '' && github.ref_type == 'tag'"
    )
    expect(attach.join('\n')).toMatch(/permissions:\n\s+contents: write/)
    expect(commands(attach)).toEqual([
      'node scripts/bundle.mjs attach "bundle/launch-bundle-$BUNDLE_TAG.tgz"',
    ])
  })

  it('never gives contents: write to a job that runs pnpm install', () => {
    for (const id of ['staging', 'production']) {
      expect(job(DEPLOY, id).join('\n'), id).not.toMatch(/contents: write/)
    }
  })

  it('packs on staging only on the deployer path and only for a tag', () => {
    const staging = job(DEPLOY, 'staging')
    expect(step(staging, 'Pack the build for production (build once)')).toContain(
      "if: vars.DEPLOYER_URL != '' && github.ref_type == 'tag'"
    )
    expect(step(staging, 'Keep the bundle for the release')).toContain(
      "if: vars.DEPLOYER_URL != '' && github.ref_type == 'tag'"
    )
  })

  it('production skips its builds only for a verified bundle, and the wrangler path always builds', () => {
    const production = job(DEPLOY, 'production')
    expect(step(production, 'Use the staging bundle when the release carries one')).toContain(
      "if: vars.DEPLOYER_URL != ''"
    )
    expect(step(production, 'Build UI')).toContain(
      "if: vars.DEPLOYER_URL == '' || steps.bundle.outputs.source != 'bundle'"
    )
    expect(step(production, 'Build the Worker (dry run, no credentials)')).toContain(
      "if: vars.DEPLOYER_URL != '' && steps.bundle.outputs.source != 'bundle'"
    )
    // The parity test and the migrations still need the workspace.
    expect(commands(production)).toContain('pnpm install --frozen-lockfile')
  })

  it("production's upload tells the deployer whether it sends the bundle's bytes", () => {
    const upload = step(job(DEPLOY, 'production'), 'Hand the build to the deployer')
    expect(upload).toContain('run: node scripts/deployer.mjs upload')
    expect(upload).toContain(`DEPLOYER_SOURCE: ${expr('steps.bundle.outputs.source')}`)
    // Staging always builds: its upload says nothing, so the deployer defaults to `build`.
    const staging = step(job(DEPLOY, 'staging'), 'Hand the build to the deployer')
    expect(staging).not.toContain('DEPLOYER_SOURCE')
  })
})

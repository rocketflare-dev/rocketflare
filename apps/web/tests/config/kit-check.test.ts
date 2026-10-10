/**
 * `scripts/kit-check.mjs` — the Launch kit conformance check (D36), shared with the meta-kit
 * (rocketflare-dev/launch-kit, whose `scripts/tests/kit-check.test.mjs` this ports to vitest). It
 * travels into every copy: a copy is an app Launch drives through its own `launch.kit.json`, so the
 * check must pass in the kit AND in a renamed copy (kit.yml runs it on both).
 *
 * The broken-contract cases run on a scratch copy of the files the checker reads, never on this
 * checkout. The `config` project: no database.
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkKit,
  ciProblems,
  commandTarget,
  releaseProblems,
  tomlProblems,
  tomlShape,
} from '../../../../scripts/kit-check.mjs'
import { parseYaml } from '../../../../scripts/lib/yaml-lite.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SCRIPT = path.join(REPO_ROOT, 'scripts/kit-check.mjs')

function run(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout }
  } catch (err) {
    const e = err as { status: number; stdout?: string }
    return { status: e.status, stdout: String(e.stdout ?? '') }
  }
}

/** Every path the checker reads: root files, workflows, scripts, the Worker's tomls and source. */
const CHECKED = [
  /^[^/]+$/,
  /^\.github\//,
  /^scripts\//,
  /^\.claude\/skills\/rf-upgrade\//,
  /^apps\/web\/[^/]+$/,
  /^apps\/web\/scripts\//,
  /^apps\/web\/src\//,
]
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(f => CHECKED.some(re => re.test(f)) && existsSync(path.join(REPO_ROOT, f)))

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kit-check-'))
  dirs.push(dir)
  for (const rel of files) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    cpSync(path.join(REPO_ROOT, rel), path.join(dir, rel), { verbatimSymlinks: true })
  }
  return dir
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const failing = (report: ReturnType<typeof checkKit>) =>
  report.checks
    .filter(c => !c.ok)
    .flatMap(c => c.problems)
    .join('\n')
const edit = (dir: string, rel: string, fn: (text: string) => string) => {
  const file = path.join(dir, rel)
  writeFileSync(file, fn(readFileSync(file, 'utf8')))
}

describe('kit-check on this checkout', () => {
  it('conforms (exit 0, every check green, no warnings)', () => {
    const res = run(['--json'])
    expect(res.status, res.stdout).toBe(0)
    const report = JSON.parse(res.stdout)
    expect(report.ok).toBe(true)
    expect(report.checks.map((c: { id: string }) => c.id)).toEqual([
      'manifest',
      'files',
      'ci',
      'release',
      'tomls',
    ])
    expect(report.warnings).toEqual([])
  })

  it('checks the names against the kit, or the copy, this checkout is', () => {
    const report = checkKit(REPO_ROOT)
    const app = JSON.parse(readFileSync(path.join(REPO_ROOT, '.rocketflare.json'), 'utf8')).app
    expect(report.kit?.isCopy).toBe(app !== null)
    if (app !== null) expect(report.kit?.slug).toBe(app.slug)
  })

  it('runs the gate list with --exec', () => {
    const report = checkKit(REPO_ROOT, { exec: true })
    expect(report.checks.find(c => c.id === 'gate-list')?.ok, JSON.stringify(report)).toBe(true)
  })

  it('fails --provisioned while the ids are still placeholders', () => {
    const res = run(['--provisioned'])
    expect(res.status).toBe(1)
    expect(res.stdout).toMatch(/still the placeholder/)
  })

  it('answers a usage error with exit 2', () => {
    expect(run(['--nope']).status).toBe(2)
  })
})

describe('kit-check finds what breaks the contract', () => {
  it('a missing manifest', () => {
    const dir = scratch()
    unlinkSync(path.join(dir, 'launch.kit.json'))
    expect(failing(checkKit(dir))).toMatch(/launch.kit.json: missing/)
  })

  it('a missing must-have file', () => {
    const dir = scratch()
    unlinkSync(path.join(dir, 'scripts/rename.mjs'))
    unlinkSync(path.join(dir, 'AGENTS.md'))
    unlinkSync(path.join(dir, 'CLAUDE.md'))
    const problems = failing(checkKit(dir))
    expect(problems).toMatch(/scaffold.init: scripts\/rename.mjs does not exist/)
    expect(problems).toMatch(/CLAUDE.md or AGENTS.md/)
  })

  it('an app manifest without the kit id Launch reads', () => {
    const dir = scratch()
    edit(dir, '.rocketflare.json', t => {
      const m = JSON.parse(t)
      delete m.kit.id
      return JSON.stringify(m)
    })
    expect(failing(checkKit(dir))).toContain('.rocketflare.json: kit.id missing')
  })

  it('a renamed Gate job', () => {
    const dir = scratch()
    edit(dir, '.github/workflows/ci.yml', t => t.replace('name: Gate', 'name: Checks'))
    expect(failing(checkKit(dir))).toMatch(/no job named "Gate"/)
  })

  it('a deploy workflow without id-token: write', () => {
    const dir = scratch()
    edit(dir, '.github/workflows/deploy.yml', t =>
      t.replaceAll('id-token: write', 'id-token: none')
    )
    expect(failing(checkKit(dir))).toMatch(/id-token: write/)
  })

  it('a hyperdrive binding, a route and a misnamed queue', () => {
    const dir = scratch()
    const slug = checkKit(dir).kit?.slug
    for (const f of ['wrangler.toml', 'wrangler.staging.toml']) {
      edit(dir, `apps/web/${f}`, t => `${t}\n[[hyperdrive]]\nbinding = "HD"\nid = "<HD_ID>"\n`)
    }
    edit(
      dir,
      'apps/web/wrangler.toml',
      t => `routes = ["x.test/*"]\n${t}\n[[queues.producers]]\nbinding = "Q"\nqueue = "jobs"\n`
    )
    const problems = failing(checkKit(dir))
    expect(problems).toMatch(/hyperdrive: not a binding kind Launch provisions/)
    expect(problems).toMatch(/routes: Launch owns/)
    expect(problems).toContain(`"jobs" does not follow {slug}-{suffix} for slug "${slug}"`)
    expect(problems).toMatch(/differ in shape/)
  })

  it('a real id committed in the kit', () => {
    const dir = scratch()
    edit(dir, 'apps/web/wrangler.toml', t =>
      t.replace(/id = "<[A-Z_]+>"/, 'id = "0123456789abcdef"')
    )
    expect(failing(checkKit(dir))).toMatch(/must be a <PLACEHOLDER>/)
  })
})

describe('kit-check rules (pure)', () => {
  it('commandTarget names the file or the script a command runs', () => {
    expect(commandTarget('node scripts/rename.mjs {slug}')).toEqual({
      kind: 'file',
      file: 'scripts/rename.mjs',
    })
    expect(commandTarget('pnpm gate --list --json')).toEqual({ kind: 'script', script: 'gate' })
    expect(commandTarget('pnpm run db:migrate:ci')).toEqual({
      kind: 'script',
      script: 'db:migrate:ci',
    })
    expect(commandTarget('pnpm install --frozen-lockfile')).toBeNull()
  })

  it('staging names carry the suffix, production names never do', () => {
    const toml = {
      name: 'acme-staging',
      main: 'x',
      r2_buckets: [{ binding: 'F', bucket_name: 'acme-files' }],
    }
    expect(
      tomlProblems(toml, { slug: 'acme', env: 'staging', stagingSuffix: '-staging', label: 's' })
    ).toEqual([
      's: r2_buckets[0].bucket_name: "acme-files" does not follow {slug}-{suffix}-staging for slug "acme"',
    ])
    const prod = tomlProblems(
      {
        name: 'acme',
        main: 'x',
        workflows: [{ name: 'acme-run-staging', binding: 'W', class_name: 'C' }],
      },
      { slug: 'acme', env: 'production', stagingSuffix: '-staging', label: 'p' }
    )
    expect(prod).toHaveLength(1)
  })

  it('the shape ignores names, ids and var values', () => {
    const p = {
      name: 'acme',
      vars: { A: '1' },
      kv_namespaces: [{ binding: 'K', id: '<A>' }],
      queues: { producers: [{ binding: 'Q', queue: 'acme-jobs' }] },
    }
    const s = {
      name: 'acme-staging',
      vars: { A: '2' },
      kv_namespaces: [{ binding: 'K', id: '<B>' }],
      queues: { producers: [{ binding: 'Q', queue: 'acme-jobs-staging' }] },
    }
    const o = { slug: 'acme', stagingSuffix: '-staging' }
    expect(tomlShape(p, { ...o, env: 'production' })).toEqual(
      tomlShape(s, { ...o, env: 'staging' })
    )
  })

  it('ci.yml must run on pull requests and read the verified variable', () => {
    const wf = parseYaml('on:\n  push:\njobs:\n  gate:\n    name: Gate\n')
    const problems = ciProblems(wf, '', {
      requiredCheck: 'Gate',
      verifiedVariable: 'LAUNCH_GATE_APP_ID',
    })
    expect(problems).toHaveLength(2)
  })

  it('the deploy workflow must finish with if: always()', () => {
    const text = readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8')
    const wf = parseYaml(text.replaceAll(/if: always\(\)( && )?/g, 'if: '))
    const problems = releaseProblems(wf, { file: 'deploy.yml', environmentInput: 'environment' })
    expect(
      problems.some(p => p.includes('if: always()')),
      problems.join('\n')
    ).toBe(true)
  })
})

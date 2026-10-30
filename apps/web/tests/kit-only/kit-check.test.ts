/**
 * `scripts/kit-check.mjs` — the Launch kit conformance check (D36), shared with the meta-kit
 * (rocketflare-dev/launch-kit, whose `scripts/tests/kit-check.test.mjs` this ports to vitest).
 *
 * Every case runs on a fixture kit built in a temp directory (`./fixtures/kit-fixture.mjs`, shared
 * with the meta-kit), never on this checkout. Kit-only: the checker is the kit's to keep in step with
 * the meta-kit, so a copy (which may still RUN it) does not re-prove it in its own gate. Whether
 * THIS checkout conforms is kit.yml's `Launch kit check` step (and the renamed copy's), never a
 * test. No database.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
import {
  FIXTURE_APP_MANIFEST,
  FIXTURE_DEPLOY_YML,
  FIXTURE_TOKENS,
  FIXTURE_TOMLS,
  provisionLikeLaunch,
  writeKitFixture,
} from './fixtures/kit-fixture.mjs'

const SCRIPT = path.resolve(__dirname, '../../../../scripts/kit-check.mjs')
const APP = { slug: 'zz-desk', display: 'Zz Desk', domain: 'zz.example' }

function run(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout }
  } catch (err) {
    const e = err as { status: number; stdout?: string }
    return { status: e.status, stdout: String(e.stdout ?? '') }
  }
}

const dirs: string[] = []
/** The fixture kit (`app` null) or a fresh copy of it named `app`. */
function fixture(app: typeof APP | null = null): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kit-check-'))
  dirs.push(dir)
  return writeKitFixture(dir, { app })
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

describe('kit-check: the kit', () => {
  it('conforms (exit 0, every check green, no warnings)', () => {
    const res = run([fixture(), '--json'])
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
    expect(report.kit).toEqual({
      id: FIXTURE_TOKENS.slug,
      slug: FIXTURE_TOKENS.slug,
      isCopy: false,
    })
  })

  it('runs the gate list with --exec', () => {
    const report = checkKit(fixture(), { exec: true })
    expect(report.checks.find(c => c.id === 'gate-list')?.ok, JSON.stringify(report)).toBe(true)
  })

  it('fails --provisioned while the ids are still placeholders', () => {
    const res = run([fixture(), '--provisioned'])
    expect(res.status).toBe(1)
    expect(res.stdout).toMatch(/still the placeholder/)
  })

  it('refuses a real id committed in the kit', () => {
    const dir = fixture()
    edit(dir, FIXTURE_TOMLS[0], t => t.replace(/id = "<[A-Z_]+>"/, 'id = "0123456789abcdef"'))
    expect(failing(checkKit(dir))).toMatch(/must be a <PLACEHOLDER> in the kit/)
  })

  it('answers a usage error with exit 2', () => {
    expect(run(['--nope']).status).toBe(2)
  })
})

describe('kit-check: a copy', () => {
  it('conforms freshly scaffolded, its ids still placeholders, and fails --provisioned', () => {
    const dir = fixture(APP)
    const report = checkKit(dir)
    expect(report.ok, failing(report)).toBe(true)
    expect(report.kit).toEqual({ id: FIXTURE_TOKENS.slug, slug: APP.slug, isCopy: true })
    const res = run([dir, '--provisioned'])
    expect(res.status).toBe(1)
    expect(res.stdout).toMatch(/still the placeholder/)
  })

  it("conforms once Launch's write_config has committed its ids and vars, and passes --provisioned", () => {
    const dir = fixture(APP)
    const ids = provisionLikeLaunch(dir)
    const prod = readFileSync(path.join(dir, FIXTURE_TOMLS[0]), 'utf8')
    expect(ids).toHaveLength(4)
    expect(prod).toContain(`id = "${ids[0]}"`)
    expect(prod).not.toMatch(/<[A-Z0-9_]+>/)
    expect(prod).toMatch(/^workers_dev = false$/m)
    expect(prod).toMatch(/^OIDC_ISSUER = "https:\/\/launch\.example\.com"$/m)

    const res = run([dir, '--json'])
    expect(res.status, res.stdout).toBe(0)
    expect(JSON.parse(res.stdout).warnings).toEqual([])
    const provisioned = run([dir, '--provisioned'])
    expect(provisioned.status, provisioned.stdout).toBe(0)
  })

  it('still holds a provisioned copy to its names and to one shape', () => {
    const dir = fixture(APP)
    provisionLikeLaunch(dir)
    edit(dir, FIXTURE_TOMLS[1], t => t.replace(`"${APP.slug}-files-staging"`, '"files-staging"'))
    edit(dir, FIXTURE_TOMLS[0], t => `${t}\n[[kv_namespaces]]\nbinding = "EXTRA"\nid = "abc"\n`)
    const problems = failing(checkKit(dir, { provisioned: true }))
    expect(problems).toMatch(/"files-staging" does not follow/)
    expect(problems).toMatch(/differ in shape/)
  })
})

describe('kit-check finds what breaks the contract', () => {
  it('a missing manifest', () => {
    const dir = fixture()
    unlinkSync(path.join(dir, 'launch.kit.json'))
    expect(failing(checkKit(dir))).toMatch(/launch.kit.json: missing/)
  })

  it('a missing must-have file', () => {
    const dir = fixture()
    unlinkSync(path.join(dir, 'scripts/init.mjs'))
    unlinkSync(path.join(dir, 'CLAUDE.md'))
    const problems = failing(checkKit(dir))
    expect(problems).toMatch(/scaffold.init: scripts\/init.mjs does not exist/)
    expect(problems).toMatch(/CLAUDE.md or AGENTS.md/)
  })

  it('an app manifest with "app": null is the kit itself, not a copy', () => {
    const dir = fixture()
    writeFileSync(
      path.join(dir, FIXTURE_APP_MANIFEST),
      JSON.stringify({
        app: null,
        kit: { id: FIXTURE_TOKENS.slug, version: '0.0.0', commit: null },
      })
    )
    const report = checkKit(dir)
    expect(report.ok, failing(report)).toBe(true)
    expect(report.kit?.isCopy).toBe(false)
    expect(report.kit?.slug).toBe(FIXTURE_TOKENS.slug)
  })

  it('a copy whose app manifest lacks the kit id Launch reads', () => {
    const dir = fixture(APP)
    edit(dir, FIXTURE_APP_MANIFEST, t => {
      const m = JSON.parse(t)
      delete m.kit.id
      return JSON.stringify(m)
    })
    const report = checkKit(dir)
    expect(report.kit?.isCopy).toBe(true)
    expect(failing(report)).toContain(`${FIXTURE_APP_MANIFEST}: kit.id missing`)
  })

  it('a renamed Gate job', () => {
    const dir = fixture()
    edit(dir, '.github/workflows/ci.yml', t => t.replace('name: Gate', 'name: Checks'))
    expect(failing(checkKit(dir))).toMatch(/no job named "Gate"/)
  })

  it('a deploy workflow without id-token: write', () => {
    const dir = fixture()
    edit(dir, '.github/workflows/deploy.yml', t =>
      t.replaceAll('id-token: write', 'id-token: none')
    )
    expect(failing(checkKit(dir))).toMatch(/id-token: write/)
  })

  it('a hyperdrive binding, a route and a misnamed queue', () => {
    const dir = fixture()
    for (const f of FIXTURE_TOMLS) {
      edit(dir, f, t => `${t}\n[[hyperdrive]]\nbinding = "HD"\nid = "<HD_ID>"\n`)
    }
    edit(
      dir,
      FIXTURE_TOMLS[0],
      t => `routes = ["x.test/*"]\n${t}\n[[queues.producers]]\nbinding = "Q"\nqueue = "jobs"\n`
    )
    const problems = failing(checkKit(dir))
    expect(problems).toMatch(/hyperdrive: not a binding kind Launch provisions/)
    expect(problems).toMatch(/routes: Launch owns/)
    expect(problems).toContain(
      `"jobs" does not follow {slug}-{suffix} for slug "${FIXTURE_TOKENS.slug}"`
    )
    expect(problems).toMatch(/differ in shape/)
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

  it('ids: placeholders in the kit; placeholders or real ids in a copy; real with --provisioned', () => {
    const at = (id: string) => ({ name: 'acme', main: 'x', kv_namespaces: [{ binding: 'K', id }] })
    const o = { slug: 'acme', env: 'production' as const, stagingSuffix: '-staging', label: 'p' }
    expect(tomlProblems(at('<K_ID>'), o)).toEqual([])
    expect(tomlProblems(at('abc123'), o).join()).toMatch(/must be a <PLACEHOLDER> in the kit/)
    expect(tomlProblems(at('<K_ID>'), { ...o, isCopy: true })).toEqual([])
    expect(tomlProblems(at('abc123'), { ...o, isCopy: true })).toEqual([])
    for (const isCopy of [false, true]) {
      expect(tomlProblems(at('abc123'), { ...o, isCopy, provisioned: true })).toEqual([])
      expect(tomlProblems(at('<K_ID>'), { ...o, isCopy, provisioned: true }).join()).toMatch(
        /still the placeholder/
      )
    }
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
    const wf = parseYaml(FIXTURE_DEPLOY_YML.replaceAll(/if: always\(\)( && )?/g, 'if: '))
    const problems = releaseProblems(wf, { file: 'deploy.yml', environmentInput: 'environment' })
    expect(
      problems.some(p => p.includes('if: always()')),
      problems.join('\n')
    ).toBe(true)
  })
})

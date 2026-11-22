/**
 * `scripts/upgrade.mjs --apply [--apply-deletes]` end to end, over a local kit and a local copy.
 *
 * Four promises, each once broken in a real copy:
 *   - a plan run (no `--apply`) works on a dirty tree; only `--apply` refuses one;
 *   - `--apply-deletes` deletes what the kit deleted (it was parsed and then never read), and the
 *     summary is worded from the flags given — it used to tell you to pass the flag you passed;
 *   - a VENDORED plugin (the kit's own repository, no subdirectory) is ported like core — it was
 *     skipped as plugin-owned while `pnpm plugin upgrade` refused it as vendored;
 *   - `--apply` stages what it wrote, so the gate's `git ls-files` scanners see the new files.
 * Real git, local repositories only.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO = path.resolve(__dirname, '../../../..')
const MANIFEST = readdirSync(REPO).find(f => /^\.[a-z0-9-]+\.json$/.test(f) && !f.includes('local'))
const CHANGED = 'apps/web/src/api/greeting.ts'
const ADDED = 'apps/web/src/api/farewell.ts'
const DELETED = 'apps/web/tests/api/old-behaviour.test.ts'
const PLUGIN_DIR = 'apps/web/src/plugins/example-feature'
const PLUGIN_FILE = `${PLUGIN_DIR}/server.ts`
const PLUGIN_ADDED = `${PLUGIN_DIR}/tests/api/mcp.test.ts`

const note = (version: string, previous: string) => `---
version: ${version}
previous: ${previous}
date: 2026-01-01
breaking: false
migrations: []
areas: [api]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Release ${version}.

## How to apply

1. Nothing.

## Conflicts to expect

None.

## Verify

1. Nothing.
`

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' }
  ).trim()
}

function writeAt(root: string, rel: string, text: string) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

let tmp = ''
let kit = ''
let from = ''
let kitManifest: Record<string, any> = {}

/** A fresh copy of the kit at 0.1.0, named `acme`, committed clean, its mirror populated. */
function makeApp(name: string) {
  const app = path.join(tmp, name)
  mkdirSync(app)
  for (const f of ['scripts/upgrade.mjs', 'scripts/lib']) {
    cpSync(path.join(REPO, f), path.join(app, f), { recursive: true })
  }
  const surfaces = (kitManifest.surfaces as Record<string, any>[]).map(s =>
    s.id === 'example-feature' ? { ...s, source: { ...s.source, repo: kit, subdir: '' } } : s
  )
  const manifest = {
    ...kitManifest,
    kit: { ...kitManifest.kit, repo: kit, version: '0.1.0', commit: from },
    app: { slug: 'acme', display: 'Acme', domain: 'acme.example.com' },
    surfaces,
    history: [],
  }
  writeAt(app, MANIFEST ?? '', `${JSON.stringify(manifest, null, 2)}\n`)
  writeAt(app, CHANGED, "export const greeting = 'hello'\n")
  writeAt(app, DELETED, '// a test of behaviour the kit removed\n')
  writeAt(app, `${PLUGIN_DIR}/plugin.json`, '{ "id": "example-feature" }\n')
  writeAt(app, PLUGIN_FILE, "import { x } from '@acme/shared/plugins'\nexport const v = 1\n")
  writeAt(app, 'docs/upgrades/0.1.0.md', note('0.1.0', 'null'))
  writeAt(app, '.gitignore', '.upgrade/\n')
  git(app, ['init', '-q', '-b', 'main'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-q', '-m', 'Start'])
  const plan = spawnSync(process.execPath, ['scripts/upgrade.mjs', '--to', '0.2.0'], {
    cwd: app,
    encoding: 'utf8',
  })
  if (plan.status !== 0) throw new Error(`plan run exit ${plan.status}: ${plan.stderr}`)
  return app
}

const run = (app: string, args: string[]) =>
  spawnSync(process.execPath, ['scripts/upgrade.mjs', '--no-fetch', '--to', '0.2.0', ...args], {
    cwd: app,
    encoding: 'utf8',
  })

beforeAll(() => {
  if (!MANIFEST) throw new Error('no provenance manifest at the repo root')
  tmp = mkdtempSync(path.join(tmpdir(), 'upgrade-apply-'))
  kitManifest = JSON.parse(readFileSync(path.join(REPO, MANIFEST), 'utf8'))

  // The kit: 0.1.0, then 0.2.0 — one file changed, one added, one deleted, and the vendored
  // plugin changed and given a new test.
  kit = path.join(tmp, 'kit')
  mkdirSync(kit)
  git(kit, ['init', '-q', '-b', 'main'])
  writeAt(kit, MANIFEST, `${JSON.stringify({ ...kitManifest, app: null }, null, 2)}\n`)
  writeAt(kit, CHANGED, "export const greeting = 'hello'\n")
  writeAt(kit, DELETED, '// a test of behaviour the kit removed\n')
  writeAt(kit, `${PLUGIN_DIR}/plugin.json`, '{ "id": "example-feature" }\n')
  writeAt(kit, PLUGIN_FILE, "import { x } from '@rocketflare/shared/plugins'\nexport const v = 1\n")
  writeAt(kit, 'docs/upgrades/0.1.0.md', note('0.1.0', 'null'))
  git(kit, ['add', '-A'])
  git(kit, ['commit', '-q', '-m', '0.1.0'])
  git(kit, ['tag', '0.1.0'])
  from = git(kit, ['rev-parse', 'HEAD'])
  writeAt(kit, CHANGED, "export const greeting = 'hello, world'\n")
  writeAt(kit, ADDED, "export const farewell = 'bye'\n")
  rmSync(path.join(kit, DELETED))
  writeAt(kit, PLUGIN_FILE, "import { x } from '@rocketflare/shared/plugins'\nexport const v = 2\n")
  writeAt(kit, PLUGIN_ADDED, "import '@rocketflare/shared/plugins'\n")
  writeAt(kit, 'docs/upgrades/0.2.0.md', note('0.2.0', '0.1.0'))
  git(kit, ['add', '-A'])
  git(kit, ['commit', '-q', '-m', '0.2.0'])
  git(kit, ['tag', '0.2.0'])
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('upgrade.mjs on a dirty tree', () => {
  it('runs a plan, and refuses only --apply', () => {
    const app = makeApp('dirty')
    writeAt(app, 'local-edit.txt', 'not committed\n')
    const plan = run(app, [])
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('5/6 plan')
    const apply = run(app, ['--apply'])
    expect(apply.status).toBe(1)
    expect(apply.stderr).toMatch(/not clean/)
    expect(readFileSync(path.join(app, CHANGED), 'utf8')).toContain("'hello'")
  })
})

describe('upgrade.mjs --apply --apply-deletes', () => {
  let app = ''
  let r: ReturnType<typeof run>

  beforeAll(() => {
    app = makeApp('deletes')
    r = run(app, ['--apply', '--apply-deletes'])
  })

  it('applies, deletes what the kit deleted, and never tells you to pass the flag you passed', () => {
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(path.join(app, DELETED))).toBe(false)
    expect(readFileSync(path.join(app, CHANGED), 'utf8')).toContain('hello, world')
    expect(existsSync(path.join(app, ADDED))).toBe(true)
    expect(r.stdout).not.toMatch(/pass --apply-deletes/)
    expect(r.stdout).toContain(DELETED)
    expect(JSON.parse(readFileSync(path.join(app, MANIFEST ?? ''), 'utf8')).kit.version).toBe(
      '0.2.0'
    )
  })

  it('ports the vendored plugin like core, translated into the app names', () => {
    expect(readFileSync(path.join(app, PLUGIN_FILE), 'utf8')).toContain('export const v = 2')
    expect(readFileSync(path.join(app, PLUGIN_ADDED), 'utf8')).toContain('@acme/shared/plugins')
    expect(r.stdout).not.toMatch(/pnpm plugin upgrade/)
  })

  it('stages exactly what it wrote: nothing unstaged, nothing untracked', () => {
    const status = git(app, ['status', '--porcelain']).split('\n').filter(Boolean)
    expect(status.length).toBeGreaterThan(0)
    for (const line of status) expect(line, line).toMatch(/^[AMD] {2}/)
    const tracked = git(app, ['ls-files'])
    expect(tracked).toContain(ADDED)
    expect(tracked).toContain(PLUGIN_ADDED)
    expect(tracked).not.toContain(DELETED)
  })
})

describe('upgrade.mjs --apply without --apply-deletes', () => {
  it('keeps the deleted file and says how to remove it by hand', () => {
    const app = makeApp('keeps')
    const r = run(app, ['--apply'])
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(path.join(app, DELETED))).toBe(true)
    expect(r.stdout).toContain('`git rm <path>`')
    expect(r.stdout).not.toMatch(/re-run with --apply --apply-deletes/)
  })
})

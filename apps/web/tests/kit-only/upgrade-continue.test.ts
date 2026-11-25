/**
 * `scripts/upgrade.mjs --continue`: finishing an upgrade whose `--apply` left rejects.
 *
 * An apply with a rejected hunk deliberately does not stamp `.rocketflare.json`, and re-running it
 * cannot finish the job: the tree is dirty, and the patch no longer applies to the files it already
 * patched. So the copy was left on the old version with the new code — until someone hand-edited
 * the manifest. `--continue` records the plan that apply wrote, once every `*.rej` is gone, and
 * only if that plan starts from the commit the copy still records. Real git, local repos only.
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
const FILE = 'apps/web/src/api/greeting.ts'

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
let app = ''
let toCommit = ''

const run = (args: string[]) =>
  spawnSync(process.execPath, ['scripts/upgrade.mjs', '--no-fetch', ...args], {
    cwd: app,
    encoding: 'utf8',
  })

const recorded = () => JSON.parse(readFileSync(path.join(app, MANIFEST ?? ''), 'utf8'))

beforeAll(() => {
  if (!MANIFEST) throw new Error('no provenance manifest at the repo root')
  tmp = mkdtempSync(path.join(tmpdir(), 'upgrade-continue-'))
  const kitManifest = JSON.parse(readFileSync(path.join(REPO, MANIFEST), 'utf8'))

  // The kit: 0.1.0, then 0.2.0, which changes the one line the copy also changed.
  const kit = path.join(tmp, 'kit')
  mkdirSync(kit)
  git(kit, ['init', '-q', '-b', 'main'])
  writeAt(kit, MANIFEST, `${JSON.stringify({ ...kitManifest, app: null }, null, 2)}\n`)
  writeAt(kit, FILE, "export const greeting = 'hello'\n")
  writeAt(kit, 'docs/upgrades/0.1.0.md', note('0.1.0', 'null'))
  git(kit, ['add', '-A'])
  git(kit, ['commit', '-q', '-m', '0.1.0'])
  git(kit, ['tag', '0.1.0'])
  const from = git(kit, ['rev-parse', 'HEAD'])
  writeAt(kit, FILE, "export const greeting = 'hello, world'\n")
  writeAt(kit, 'docs/upgrades/0.2.0.md', note('0.2.0', '0.1.0'))
  git(kit, ['add', '-A'])
  git(kit, ['commit', '-q', '-m', '0.2.0'])
  git(kit, ['tag', '0.2.0'])
  toCommit = git(kit, ['rev-parse', 'HEAD'])

  // The copy: from 0.1.0, with its own edit on the line 0.2.0 changes — the hunk will reject.
  app = path.join(tmp, 'app')
  mkdirSync(app)
  for (const f of ['scripts/upgrade.mjs', 'scripts/lib']) {
    cpSync(path.join(REPO, f), path.join(app, f), { recursive: true })
  }
  const manifest = {
    ...kitManifest,
    kit: { ...kitManifest.kit, repo: kit, version: '0.1.0', commit: from },
    app: { slug: 'acme', display: 'Acme', domain: 'acme.example.com' },
    history: [],
  }
  writeAt(app, MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  writeAt(app, FILE, "export const greeting = 'hi there'\n")
  writeAt(app, 'docs/upgrades/0.1.0.md', note('0.1.0', 'null'))
  writeAt(app, '.gitignore', '.upgrade/\n')
  git(app, ['init', '-q', '-b', 'main'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-q', '-m', 'Start'])
  // Populate the mirror once, so every run below can stay offline.
  const plan = spawnSync(process.execPath, ['scripts/upgrade.mjs', '--to', '0.2.0'], {
    cwd: app,
    encoding: 'utf8',
  })
  if (plan.status !== 0) throw new Error(`plan run exit ${plan.status}: ${plan.stderr}`)
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('upgrade.mjs --continue', () => {
  it('an apply with a reject stamps nothing and names the command that finishes it', () => {
    const r = run(['--to', '0.2.0', '--apply'])
    expect(r.status).toBe(4)
    expect(existsSync(path.join(app, `${FILE}.rej`))).toBe(true)
    expect(recorded().kit.version).toBe('0.1.0')
    expect(r.stderr).toContain('pnpm kit:upgrade --to 0.2.0 --continue')
  })

  it('refuses while a reject remains, and still stamps nothing', () => {
    const r = run(['--to', '0.2.0', '--continue'])
    expect(r.status).toBe(4)
    expect(r.stderr).toContain(`${FILE}.rej`)
    expect(recorded().kit.version).toBe('0.1.0')
  })

  it('records the version, commit and history once the rejects are resolved', () => {
    writeAt(app, FILE, "export const greeting = 'hi there, world'\n")
    rmSync(path.join(app, `${FILE}.rej`))
    const r = run(['--continue'])
    expect(r.status, r.stderr).toBe(0)
    const m = recorded()
    expect(m.kit.version).toBe('0.2.0')
    expect(m.kit.commit).toBe(toCommit)
    expect(m.history).toEqual([
      expect.objectContaining({ to: toCommit, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }),
    ])
  })

  it('refuses to stamp twice: the plan no longer starts from what the copy records', () => {
    const r = run(['--to', '0.2.0', '--continue'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/already stamped/)
    expect(recorded().history).toHaveLength(1)
  })
})

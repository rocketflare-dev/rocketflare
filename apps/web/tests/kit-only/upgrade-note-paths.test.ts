/**
 * `scripts/upgrade.mjs` end to end, over a two-release fixture kit: the release-note paths the
 * report and `plan.json` print must exist IN THE COPY. They used to print the kit's own path,
 * `docs/upgrades/X.Y.Z.md`, which a copy does not have until `--apply` writes it — so an agent
 * (Launch's unattended kit upgrade, `/rf-upgrade`) that read the report before applying failed its
 * first Read every time. A plan run copies each note to `.upgrade/work/<version>/notes/`; that is
 * the path to print. Real git, local repos only — no network.
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
import { notePath, noteReportLines } from '../../../../scripts/lib/upgrade-lib.mjs'

const REPO = path.resolve(__dirname, '../../../..')
const MANIFEST = readdirSync(REPO).find(f => /^\.[a-z0-9-]+\.json$/.test(f) && !f.includes('local'))

const note = (version: string, previous: string) => `---
version: ${version}
previous: ${previous}
date: 2026-01-01
breaking: false
migrations: []
areas: [docs]
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

function run(args: string[]) {
  const r = spawnSync(process.execPath, ['scripts/upgrade.mjs', '--force', ...args], {
    cwd: app,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`upgrade.mjs exit ${r.status}: ${r.stderr}${r.stdout}`)
  return r.stdout
}

/** The `  X.Y.Z  <path>` lines under the report's `Release notes` heading. */
function reportedNotes(stdout: string) {
  const lines = stdout.split('\n')
  const at = lines.findIndex(l => l.startsWith('Release notes'))
  if (at < 0) return []
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    const m = l.match(/^ {2}(\d+\.\d+\.\d+) {2}(\S+)/)
    if (!m) break
    out.push(m[2] ?? '')
  }
  return out
}

beforeAll(() => {
  if (!MANIFEST) throw new Error('no provenance manifest at the repo root')
  tmp = mkdtempSync(path.join(tmpdir(), 'upgrade-notes-'))
  const kitManifest = JSON.parse(readFileSync(path.join(REPO, MANIFEST), 'utf8'))

  // The kit: 0.1.0, then 0.2.0 with its porting note and one changed file.
  const kit = path.join(tmp, 'kit')
  mkdirSync(kit)
  git(kit, ['init', '-q', '-b', 'main'])
  writeAt(kit, MANIFEST, `${JSON.stringify({ ...kitManifest, app: null }, null, 2)}\n`)
  writeAt(kit, 'README.md', 'one\n')
  writeAt(kit, 'docs/upgrades/0.1.0.md', note('0.1.0', 'null'))
  git(kit, ['add', '-A'])
  git(kit, ['commit', '-q', '-m', '0.1.0'])
  git(kit, ['tag', '0.1.0'])
  const from = git(kit, ['rev-parse', 'HEAD'])
  writeAt(kit, 'README.md', 'one\ntwo\n')
  writeAt(kit, 'docs/upgrades/0.2.0.md', note('0.2.0', '0.1.0'))
  git(kit, ['add', '-A'])
  git(kit, ['commit', '-q', '-m', '0.2.0'])
  git(kit, ['tag', '0.2.0'])

  // The copy: made from 0.1.0, so it has 0.1.0's note and not 0.2.0's.
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
  writeAt(app, 'README.md', 'one\n')
  writeAt(app, 'docs/upgrades/0.1.0.md', note('0.1.0', 'null'))
  writeAt(app, '.gitignore', '.upgrade/\n')
  git(app, ['init', '-q', '-b', 'main'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-q', '-m', 'Start'])
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('upgrade.mjs release-note paths', () => {
  it('a plan run prints a note path that exists in the copy before anything is applied', () => {
    const stdout = run(['--to', '0.2.0'])
    const printed = reportedNotes(stdout)
    expect(printed).toEqual(['.upgrade/work/0.2.0/notes/0.2.0.md'])
    // The note this release adds is not in the copy yet — that is what the old report named.
    expect(existsSync(path.join(app, 'docs/upgrades/0.2.0.md'))).toBe(false)
    for (const p of printed) expect(existsSync(path.join(app, p))).toBe(true)

    const plan = JSON.parse(readFileSync(path.join(app, '.upgrade/work/0.2.0/plan.json'), 'utf8'))
    expect(plan.notes).toEqual([
      {
        version: '0.2.0',
        file: 'docs/upgrades/0.2.0.md',
        path: '.upgrade/work/0.2.0/notes/0.2.0.md',
        applicable: true,
      },
    ])
    const md = readFileSync(path.join(app, '.upgrade/work/0.2.0/plan.md'), 'utf8')
    expect(md).toContain('Also at `.upgrade/work/0.2.0/notes/0.2.0.md`.')
  })

  it('a dry run writes nothing and labels the note as the kit ref, not a local path', () => {
    rmSync(path.join(app, '.upgrade/work'), { recursive: true, force: true })
    const stdout = run(['--to', '0.2.0', '--dry-run', '--no-fetch'])
    expect(stdout).toMatch(/Release notes \(in the kit at 0\.2\.0 — dry run, not copied here/)
    expect(reportedNotes(stdout)).toEqual(['0.2.0:docs/upgrades/0.2.0.md'])
    expect(existsSync(path.join(app, '.upgrade/work/0.2.0'))).toBe(false)
  })

  it('--apply still prints the work-dir path, and also lands the note in docs/upgrades/', () => {
    const stdout = run(['--to', '0.2.0', '--apply'])
    const printed = reportedNotes(stdout)
    expect(printed).toEqual(['.upgrade/work/0.2.0/notes/0.2.0.md'])
    for (const p of printed) expect(existsSync(path.join(app, p))).toBe(true)
    expect(existsSync(path.join(app, 'docs/upgrades/0.2.0.md'))).toBe(true)
  })
})

describe('noteReportLines', () => {
  const n1 = { version: '0.2.0', file: 'docs/upgrades/0.2.0.md' }
  const n2 = { version: '0.3.0', file: 'docs/upgrades/0.3.0.md' }

  it('is empty without notes', () => {
    expect(noteReportLines([], [], { workDir: '.upgrade/work/0.3.0', toRef: '0.3.0' })).toEqual([])
  })

  it('names the work-dir copy and flags a note that does not apply', () => {
    const lines = noteReportLines([n1, n2], [n2], {
      workDir: '.upgrade/work/0.3.0',
      toRef: '0.3.0',
    })
    expect(lines.slice(2)).toEqual([
      '  0.2.0  .upgrade/work/0.3.0/notes/0.2.0.md  (not applicable here)',
      '  0.3.0  .upgrade/work/0.3.0/notes/0.3.0.md',
    ])
  })

  it('notePath keeps only the basename under notes/', () => {
    expect(notePath('.upgrade/work/0.3.0', 'docs/upgrades/0.3.0.md')).toBe(
      '.upgrade/work/0.3.0/notes/0.3.0.md'
    )
  })
})

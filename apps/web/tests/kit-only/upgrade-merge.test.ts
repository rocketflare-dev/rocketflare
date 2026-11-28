/**
 * `scripts/upgrade.mjs` end to end, for two things a 0.23 → 0.43 jump in a real copy needed (#178):
 *
 *   - a patch whose context no longer matches — the copy's formatter sorted the imports differently
 *     from the kit's — is retried as a 3-way merge (base = the old kit file, theirs = the new one),
 *     which resolves it outright; a real conflict is a `.rej` by default and conflict markers under
 *     `--3way`, and `--continue` refuses while a marker remains. A file that is yours to decide gets
 *     the same merge as a starting point under `merged/`;
 *   - the TARGET release's upgrader plans the jump when it differs from the copy's, so fixes to the
 *     upgrader released inside the range apply to the jump that crosses them. One that predates the
 *     hand-over is not run, and the run says so.
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
const MANIFEST =
  readdirSync(REPO).find(f => /^\.[a-z0-9-]+\.json$/.test(f) && !f.includes('local')) ?? ''
const FILE = 'apps/web/src/api/merged.ts'
const ENV_EXAMPLE = 'apps/web/.dev.vars.example'

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

/**
 * Two imports, two untouched lines, then the value the kit changes: near enough that the patch's
 * three lines of context reach an import, far enough that a 3-way merge sees two separate changes.
 */
const source = (imports: string[], value: string) =>
  `${imports.join('\n')}\n\nexport const one = 1\nexport const v = ${value}\n`
const KIT_ORDER = ["import { b } from './b'", "import { a } from './a'"]
// What the copy's own Biome made of the same two lines.
const COPY_ORDER = ["import { a } from './a'", "import { b } from './b'"]

let tmp = ''
let kitManifest: Record<string, any> = {}

/** A kit at 0.1.0 and 0.2.0; `base` adds files to both, `extra` adds (or changes) them in 0.2.0. */
function makeKit(
  name: string,
  extra: Record<string, string> = {},
  base: Record<string, string> = {}
) {
  const kit = path.join(tmp, name)
  mkdirSync(kit)
  git(kit, ['init', '-q', '-b', 'main'])
  writeAt(kit, MANIFEST, `${JSON.stringify({ ...kitManifest, app: null }, null, 2)}\n`)
  writeAt(kit, FILE, source(KIT_ORDER, '1'))
  writeAt(kit, ENV_EXAMPLE, 'APP_NAME=Rocketflare\nLOG_LEVEL=info\n')
  writeAt(kit, 'docs/upgrades/0.1.0.md', note('0.1.0', 'null'))
  for (const [rel, text] of Object.entries(base)) writeAt(kit, rel, text)
  git(kit, ['add', '-A'])
  git(kit, ['commit', '-q', '-m', '0.1.0'])
  git(kit, ['tag', '0.1.0'])
  const from = git(kit, ['rev-parse', 'HEAD'])
  writeAt(kit, FILE, source(KIT_ORDER, '2'))
  writeAt(kit, ENV_EXAMPLE, 'APP_NAME=Rocketflare\nLOG_LEVEL=info\nNEW_VAR=1\n')
  writeAt(kit, 'docs/upgrades/0.2.0.md', note('0.2.0', '0.1.0'))
  for (const [rel, text] of Object.entries(extra)) writeAt(kit, rel, text)
  git(kit, ['add', '-A'])
  git(kit, ['commit', '-q', '-m', '0.2.0'])
  git(kit, ['tag', '0.2.0'])
  return { kit, from }
}

/**
 * A copy named `acme` at 0.1.0 whose `FILE` reads `value` under its own import order; `files` are
 * the copy's own versions of further files.
 */
function makeApp(
  name: string,
  kit: { kit: string; from: string },
  value = '1',
  files: Record<string, string> = {}
) {
  const app = path.join(tmp, name)
  mkdirSync(app)
  for (const f of ['scripts/upgrade.mjs', 'scripts/lib']) {
    cpSync(path.join(REPO, f), path.join(app, f), { recursive: true })
  }
  const surfaces = (kitManifest.surfaces as Record<string, any>[]).filter(s => s.kind !== 'plugin')
  writeAt(
    app,
    MANIFEST,
    `${JSON.stringify(
      {
        ...kitManifest,
        kit: { ...kitManifest.kit, repo: kit.kit, version: '0.1.0', commit: kit.from },
        app: { slug: 'acme', display: 'Acme', domain: 'acme.example.com' },
        surfaces,
        history: [],
      },
      null,
      2
    )}\n`
  )
  writeAt(app, FILE, source(COPY_ORDER, value))
  writeAt(app, ENV_EXAMPLE, 'ACME_ONLY=1\nAPP_NAME=Acme\nLOG_LEVEL=info\n')
  writeAt(app, 'docs/upgrades/0.1.0.md', note('0.1.0', 'null'))
  writeAt(app, '.gitignore', '.upgrade/\n')
  for (const [rel, text] of Object.entries(files)) writeAt(app, rel, text)
  git(app, ['init', '-q', '-b', 'main'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-q', '-m', 'Start'])
  return app
}

const run = (app: string, args: string[], fetch = false) =>
  spawnSync(
    process.execPath,
    ['scripts/upgrade.mjs', ...(fetch ? [] : ['--no-fetch']), '--to', '0.2.0', ...args],
    { cwd: app, encoding: 'utf8' }
  )

const read = (app: string, rel: string) => readFileSync(path.join(app, rel), 'utf8')

beforeAll(() => {
  if (!MANIFEST) throw new Error('no provenance manifest at the repo root')
  tmp = mkdtempSync(path.join(tmpdir(), 'upgrade-merge-'))
  kitManifest = JSON.parse(readFileSync(path.join(REPO, MANIFEST), 'utf8'))
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('a patch that no longer applies', () => {
  let kit: { kit: string; from: string }
  beforeAll(() => {
    kit = makeKit('kit-merge')
  })

  it('is merged 3-way when only the context moved, staged, and the upgrade stamped', () => {
    const app = makeApp('clean', kit)
    expect(run(app, [], true).status).toBe(0)
    const r = run(app, ['--apply'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('1 merged 3-way')
    // The copy's import order survives; the kit's change lands.
    expect(read(app, FILE)).toBe(source(COPY_ORDER, '2'))
    expect(existsSync(path.join(app, `${FILE}.rej`))).toBe(false)
    expect(git(app, ['diff', '--cached', '--name-only'])).toContain(FILE)
    expect(JSON.parse(read(app, MANIFEST)).kit.version).toBe('0.2.0')
  })

  it('gives a file that is yours to decide a 3-way merge to start from', () => {
    const app = makeApp('manual', kit)
    expect(run(app, [], true).status).toBe(0)
    const r = run(app, ['--json'])
    expect(r.status, r.stderr).toBe(0)
    const merged = read(app, `.upgrade/work/0.2.0/merged/${ENV_EXAMPLE}`)
    expect(merged).toBe('ACME_ONLY=1\nAPP_NAME=Acme\nLOG_LEVEL=info\nNEW_VAR=1\n')
    // Never written into the tree: it is still yours to decide.
    expect(read(app, ENV_EXAMPLE)).not.toContain('NEW_VAR')
  })

  it('is a .rej when the merge conflicts, and conflict markers under --3way', () => {
    const rej = makeApp('conflict-rej', kit, '9')
    expect(run(rej, [], true).status).toBe(0)
    const r = run(rej, ['--apply'])
    expect(r.status).toBe(4)
    expect(existsSync(path.join(rej, `${FILE}.rej`))).toBe(true)
    expect(r.stderr).toContain('--3way')

    const markers = makeApp('conflict-3way', kit, '9')
    expect(run(markers, [], true).status).toBe(0)
    const m = run(markers, ['--apply', '--3way'])
    expect(m.status).toBe(4)
    expect(m.stdout).toContain('1 with conflict markers')
    expect(read(markers, FILE)).toMatch(/^<{7} .*\n[\s\S]*^={7}\n[\s\S]*^>{7} kit 0\.2\.0$/m)
    expect(existsSync(path.join(markers, `${FILE}.rej`))).toBe(false)

    // `--continue` refuses while a marker remains, then stamps once it is resolved.
    const early = run(markers, ['--continue'])
    expect(early.status).toBe(4)
    expect(early.stderr).toContain(FILE)
    writeAt(markers, FILE, source(COPY_ORDER, '2'))
    const done = run(markers, ['--continue'])
    expect(done.status, done.stderr).toBe(0)
    expect(JSON.parse(read(markers, MANIFEST)).kit.version).toBe('0.2.0')
  })
})

describe('the starting point for a file that is yours to decide', () => {
  const LAUNCH = 'launch.kit.json'
  const README = 'README.md'
  const launch = (description: string, gate: string) =>
    `${JSON.stringify(
      {
        kit: { id: 'rocketflare', name: 'Rocketflare', description },
        commands: { gate },
      },
      null,
      2
    )}\n`
  const readme = (intro: string, site: string) =>
    `# Rocketflare\n\n${intro}\n\ncurl -fsSL https://${site}/install.sh | bash\n`

  it("keeps launch.kit.json's kit block the kit's, and the kit-website links the kit's", () => {
    const kit = makeKit(
      'kit-manual-names',
      {
        [LAUNCH]: launch('The kit, described anew by Rocketflare', 'pnpm gate --all'),
        [README]: readme('Rocketflare, described anew.', 'rocketflare.dev'),
      },
      {
        [LAUNCH]: launch('A Rocketflare starter', 'pnpm gate'),
        [README]: readme('Rocketflare, described.', 'rocketflare.dev'),
      }
    )
    // The copy as the rename left it, plus a link an older name map rewrote into its domain.
    const app = makeApp('manual-names', kit, '1', {
      [LAUNCH]: launch('A Rocketflare starter', 'pnpm gate'),
      [README]: readme('Acme, described.', 'acme.example.com'),
    })
    expect(run(app, [], true).status).toBe(0)
    const r = run(app, ['--json'])
    expect(r.status, r.stderr).toBe(0)
    const merged = JSON.parse(read(app, `.upgrade/work/0.2.0/merged/${LAUNCH}`))
    expect(merged.kit).toEqual({
      id: 'rocketflare',
      name: 'Rocketflare',
      description: 'The kit, described anew by Rocketflare',
    })
    expect(merged.commands.gate).toBe('pnpm gate --all')
    const startingPoint = read(app, `.upgrade/work/0.2.0/merged/${README}`)
    expect(startingPoint).toContain('https://rocketflare.dev/install.sh')
    expect(startingPoint).not.toContain('acme.example.com/install.sh')
  })
})

describe("the target release's upgrader", () => {
  it('plans the jump when it differs from the copy’s and knows the hand-over', () => {
    const current = readFileSync(path.join(REPO, 'scripts/upgrade.mjs'), 'utf8')
    const marked = current.replace(
      /^const HERE = /m,
      "process.stdout.write('TARGET UPGRADER\\n')\nconst HERE = "
    )
    expect(marked).not.toBe(current)
    const extra: Record<string, string> = { 'scripts/upgrade.mjs': marked }
    for (const f of readdirSync(path.join(REPO, 'scripts/lib'))) {
      extra[`scripts/lib/${f}`] = readFileSync(path.join(REPO, 'scripts/lib', f), 'utf8')
    }
    const kit = makeKit('kit-handover', extra)
    const app = makeApp('handover', kit)
    const r = run(app, [], true)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain("0.2.0's, not this copy's")
    expect(r.stdout).toContain('TARGET UPGRADER')
    // It planned THIS checkout, from where it was extracted.
    expect(existsSync(path.join(app, '.upgrade/work/0.2.0/plan.json'))).toBe(true)
    expect(existsSync(path.join(app, '.upgrade/tool/0.2.0/scripts/upgrade.mjs'))).toBe(true)
  })

  it('is not run when it predates the hand-over, and the run says so', () => {
    const kit = makeKit('kit-old-upgrader', {
      'scripts/upgrade.mjs': "process.stdout.write('OLD UPGRADER\\n')\n",
    })
    const app = makeApp('old-upgrader', kit)
    const r = run(app, [], true)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toContain('OLD UPGRADER')
    expect(r.stderr).toContain('predates the hand-over')
    expect(r.stdout).toContain('5/6 plan')
  })
})

/**
 * `scripts/upgrade.mjs` and the app's own domains, end to end over a local kit and a local copy:
 *
 *   - an EXAMPLE surface a later release adds is never ported into an existing copy — it is
 *     reported "available, not applied" and recorded absent, so the next upgrade skips it too;
 *   - the app's unit lists (`app.ts` and its twins) are app-owned: the kit's edits to them never
 *     land, and an upgrade creates each one, empty, only where the copy has none;
 *   - a copy's own `app.ts` and domain are left byte for byte.
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
import { APP_OWNED_PATHS, EMPTY_APP_LISTS } from '../../../../scripts/lib/upgrade-lib.mjs'

const REPO = path.resolve(__dirname, '../../../..')
const MANIFEST = readdirSync(REPO).find(f => /^\.[a-z0-9-]+\.json$/.test(f) && !f.includes('local'))
const CORE = 'apps/web/src/units/server.ts'
const HR = 'apps/web/src/example-hr/index.ts'
const HR_SHARED = 'packages/shared/src/example-hr/index.ts'
const APP = 'apps/web/src/app.ts'

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
/** The kit's manifest as a release BEFORE app domains had it: no example domains. */
let oldManifest: Record<string, any> = {}
let newManifest: Record<string, any> = {}

const isExampleDomain = (s: { id: string }) => s.id === 'example-hr' || s.id === 'example-sales'

function commitRelease(version: string, previous: string) {
  writeAt(kit, `docs/upgrades/${version}.md`, note(version, previous))
  git(kit, ['add', '-A'])
  git(kit, ['commit', '-q', '-m', version])
  git(kit, ['tag', version])
}

/** A copy made from 0.1.0, named `acme`; `extra` are its own files. */
function makeApp(name: string, extra: Record<string, string> = {}) {
  const app = path.join(tmp, name)
  mkdirSync(app)
  for (const f of ['scripts/upgrade.mjs', 'scripts/lib']) {
    cpSync(path.join(REPO, f), path.join(app, f), { recursive: true })
  }
  const manifest = {
    ...oldManifest,
    kit: { ...oldManifest.kit, repo: kit, version: '0.1.0', commit: from },
    app: { slug: 'acme', display: 'Acme', domain: 'acme.example.com' },
    history: [],
  }
  writeAt(app, MANIFEST ?? '', `${JSON.stringify(manifest, null, 2)}\n`)
  writeAt(app, CORE, 'export const units = 1\n')
  writeAt(app, 'docs/upgrades/0.1.0.md', note('0.1.0', 'null'))
  writeAt(app, '.gitignore', '.upgrade/\n')
  for (const [rel, text] of Object.entries(extra)) writeAt(app, rel, text)
  git(app, ['init', '-q', '-b', 'main'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-q', '-m', 'Start'])
  return app
}

const run = (app: string, to: string, args: string[] = []) =>
  spawnSync(process.execPath, ['scripts/upgrade.mjs', '--to', to, ...args], {
    cwd: app,
    encoding: 'utf8',
  })

beforeAll(() => {
  if (!MANIFEST) throw new Error('no provenance manifest at the repo root')
  tmp = mkdtempSync(path.join(tmpdir(), 'upgrade-domains-'))
  newManifest = JSON.parse(readFileSync(path.join(REPO, MANIFEST), 'utf8'))
  oldManifest = {
    ...newManifest,
    surfaces: newManifest.surfaces.filter((s: any) => !isExampleDomain(s)),
  }

  kit = path.join(tmp, 'kit')
  mkdirSync(kit)
  git(kit, ['init', '-q', '-b', 'main'])
  // 0.1.0: no domains at all.
  writeAt(kit, MANIFEST, `${JSON.stringify({ ...oldManifest, app: null }, null, 2)}\n`)
  writeAt(kit, CORE, 'export const units = 1\n')
  commitRelease('0.1.0', 'null')
  from = git(kit, ['rev-parse', 'HEAD'])
  // 0.2.0: core reads the app's lists, which list the two example domains the release adds.
  writeAt(kit, MANIFEST, `${JSON.stringify({ ...newManifest, app: null }, null, 2)}\n`)
  writeAt(kit, CORE, "import { APP_DOMAINS } from '../app'\nexport const units = APP_DOMAINS\n")
  writeAt(
    kit,
    APP,
    "import { exampleHr } from './example-hr'\nexport const APP_DOMAINS = [exampleHr]\n"
  )
  writeAt(kit, 'packages/shared/src/app.ts', 'export const SHARED_DOMAINS = [exampleHrShared]\n')
  writeAt(kit, HR, "import '@rocketflare/shared/example-hr/index'\nexport const exampleHr = {}\n")
  writeAt(kit, HR_SHARED, 'export const exampleHrShared = {}\n')
  commitRelease('0.2.0', '0.1.0')
  // 0.3.0: the examples and the kit's app.ts change again.
  writeAt(kit, HR, 'export const exampleHr = { v: 3 }\n')
  writeAt(
    kit,
    APP,
    "import { exampleHr } from './example-hr'\nexport const APP_DOMAINS = [exampleHr] // 3\n"
  )
  writeAt(
    kit,
    CORE,
    "import { APP_DOMAINS } from '../app'\nexport const units = [...APP_DOMAINS]\n"
  )
  commitRelease('0.3.0', '0.2.0')
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('a copy older than domains, upgraded to the release that adds them', () => {
  let app = ''
  let r: ReturnType<typeof run>
  beforeAll(() => {
    app = makeApp('old')
    r = run(app, '0.2.0', ['--apply'])
  })

  it('ports core, and never the example domains', () => {
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(readFileSync(path.join(app, CORE), 'utf8')).toContain('APP_DOMAINS')
    expect(existsSync(path.join(app, HR))).toBe(false)
    expect(existsSync(path.join(app, HR_SHARED))).toBe(false)
  })

  it('reports each example as available, not applied', () => {
    expect(r.stdout).toContain('Available, not applied: the example example-hr')
    expect(r.stdout).toContain('Available, not applied: the example example-sales')
  })

  it('creates every app list empty — never the kit’s, which lists its examples', () => {
    for (const rel of APP_OWNED_PATHS) {
      expect(readFileSync(path.join(app, rel), 'utf8'), rel).toBe(EMPTY_APP_LISTS[rel])
    }
    expect(readFileSync(path.join(app, APP), 'utf8')).not.toContain('example')
    expect(git(app, ['ls-files'])).toContain(APP)
  })

  it('records the examples in the manifest, so they stay absent', () => {
    const m = JSON.parse(readFileSync(path.join(app, MANIFEST ?? ''), 'utf8'))
    expect(m.kit.version).toBe('0.2.0')
    expect(m.surfaces.filter(isExampleDomain).map((s: any) => s.id)).toEqual([
      'example-hr',
      'example-sales',
    ])
  })

  it('skips the examples again on the next upgrade, and leaves the app list alone', () => {
    git(app, ['commit', '-q', '-m', 'Upgrade to 0.2.0'])
    const next = run(app, '0.3.0', ['--apply'])
    expect(next.status, next.stderr + next.stdout).toBe(0)
    expect(existsSync(path.join(app, HR))).toBe(false)
    expect(next.stdout).not.toContain('Available, not applied')
    expect(readFileSync(path.join(app, APP), 'utf8')).toBe(EMPTY_APP_LISTS[APP])
    expect(readFileSync(path.join(app, CORE), 'utf8')).toContain('[...APP_DOMAINS]')
  })
})

describe('a copy with domains of its own', () => {
  const ownApp = "import { orders } from './orders'\nexport const APP_DOMAINS = [orders] as const\n"
  const ownDomain = "export const orders = { id: 'orders' }\n"
  let app = ''
  let r: ReturnType<typeof run>
  beforeAll(() => {
    app = makeApp('own', { [APP]: ownApp, 'apps/web/src/orders/index.ts': ownDomain })
    r = run(app, '0.2.0', ['--apply'])
  })

  it('leaves its app.ts and its domain byte for byte, and creates only the missing lists', () => {
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(readFileSync(path.join(app, APP), 'utf8')).toBe(ownApp)
    expect(readFileSync(path.join(app, 'apps/web/src/orders/index.ts'), 'utf8')).toBe(ownDomain)
    expect(r.stdout).not.toContain(`Created ${APP}`)
    expect(readFileSync(path.join(app, 'packages/shared/src/app.ts'), 'utf8')).toBe(
      EMPTY_APP_LISTS['packages/shared/src/app.ts']
    )
  })

  it('names the kit’s app-list edits it skipped', () => {
    expect(r.stdout).toMatch(/Skipped 2 change\(s\) to the app's own domain lists/)
  })
})

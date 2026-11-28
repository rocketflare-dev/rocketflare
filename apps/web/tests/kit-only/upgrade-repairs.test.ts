/**
 * What `kit:upgrade` repairs or refuses to do, from a rehearsal of a copy made at 0.33.0 and
 * upgraded to 0.46.0 — the first jump that crossed the hand-over from below it:
 *
 *   - the vendored plugin an older upgrader skipped is brought to the TARGET's version, not only
 *     moved by this hop's diff (a file still at an old release is ported from that release);
 *   - kit-website links an older name map rewrote into the app's domain are put back;
 *   - a copy with a look of its own gets its look files as `manual`, a stock copy as patches;
 *   - what the run writes is formatted by the copy's own Biome (a longer name re-wraps imports);
 *   - a handed-over run prints `1/6 kit` once.
 *
 * Pure halves first, then real git over local repositories only.
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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyReplacements, deriveNames } from '../../../../scripts/lib/rename-lib.mjs'
import {
  kitSiteRepairs,
  LOOK_FILES,
  lookDivergence,
  lookOf,
  matchingRelease,
  upgraderLeftBehind,
} from '../../../../scripts/lib/upgrade-lib.mjs'

const REPO = path.resolve(__dirname, '../../../..')
const MANIFEST =
  readdirSync(REPO).find(f => /^\.[a-z0-9-]+\.json$/.test(f) && !f.includes('local')) ?? ''

const names = deriveNames('acme', 'Acme', { domain: 'acme.example.com' })

describe('kitSiteRepairs', () => {
  const kit = [
    "export const PLUGIN_CATALOGUE_URL = 'https://rocketflare.dev/plugins'",
    'curl -fsSL https://rocketflare.dev/install.sh | bash',
    'see [track record](https://rocketflare.dev/security/track-record/)',
  ].join('\n')

  it('puts back every kit-website link the kit file carries', () => {
    const copy = [
      "export const PLUGIN_CATALOGUE_URL = 'https://acme.example.com/plugins'",
      'curl -fsSL https://acme.example.com/install.sh | bash',
      'see [track record](https://acme.example.com/security/track-record/)',
    ].join('\n')
    const r = kitSiteRepairs(copy, kit, names)
    expect(r.text).toBe(kit)
    expect(r.repaired.map(x => x.to)).toEqual([
      'rocketflare.dev/security/track-record/',
      'rocketflare.dev/install.sh',
      'rocketflare.dev/plugins',
    ])
  })

  it('leaves the app’s own addresses, other paths and a correct copy alone', () => {
    const copy =
      'https://app.acme.example.com/plugins noreply@acme.example.com/plugins ' +
      'https://acme.example.com/plugins-admin https://acme.example.com/pricing'
    const r = kitSiteRepairs(copy, kit, names)
    expect(r.text).toBe(copy)
    expect(r.repaired).toEqual([])
    expect(kitSiteRepairs(kit, kit, names).repaired).toEqual([])
  })
})

describe('the look', () => {
  const tokens = (primary: string) =>
    `@theme {\n  --radius-control: 0.5rem;\n}\n[data-theme="acme-light"] {\n  --color-primary: ${primary};\n}\n`
  const indexCss = (primary: string) =>
    `@import "tailwindcss";\n.btn { margin: 0; }\n${tokens(primary)}`

  it('reads only the look part of each look file', () => {
    expect(lookOf('apps/web/src/ui/index.css', indexCss('red'))).toBe(
      lookOf('apps/web/src/ui/index.css', indexCss('red').replace('margin: 0', 'margin: 1px'))
    )
    expect(
      lookOf('apps/web/src/ui/main.tsx', "import '@fontsource-variable/inter'\nimport './x'")
    ).toBe("import '@fontsource-variable/inter'")
    expect(
      lookOf('apps/web/src/ui/index.html', '<meta name="theme-color" content="#123456" />')
    ).toBe('#123456')
    expect(lookOf('apps/web/src/ui/App.tsx', 'x')).toBeNull()
  })

  it('diverges only when the copy changed the look, not the styles around it', () => {
    const base = {
      'apps/web/src/shared/theme-tokens.css': tokens('blue'),
      'apps/web/src/ui/index.css': indexCss('blue'),
    }
    expect(
      lookDivergence({
        local: {
          ...base,
          'apps/web/src/ui/index.css': indexCss('blue').replace('margin: 0', 'margin: 2px'),
        },
        base,
      })
    ).toEqual([])
    expect(
      lookDivergence({
        local: { ...base, 'apps/web/src/shared/theme-tokens.css': tokens('red') },
        base,
      })
    ).toEqual(['apps/web/src/shared/theme-tokens.css'])
    expect(LOOK_FILES).toContain('apps/web/src/ui/main.tsx')
  })
})

describe('matchingRelease and upgraderLeftBehind', () => {
  it('finds the newest release a file is byte for byte', () => {
    const c = [
      { ref: '0.3.0', text: 'c' },
      { ref: '0.2.0', text: 'b' },
      { ref: '0.1.0', text: 'b' },
    ]
    expect(matchingRelease('b', c)).toBe('0.2.0')
    expect(matchingRelease('z', c)).toBeNull()
  })

  it('knows an upgrader that cannot hand over', () => {
    expect(upgraderLeftBehind('const x = process.env[UPGRADE_ROOT_ENV]')).toBe(false)
    expect(upgraderLeftBehind('// an upgrader from before the hand-over')).toBe(true)
    expect(upgraderLeftBehind(readFileSync(path.join(REPO, 'scripts/upgrade.mjs'), 'utf8'))).toBe(
      false
    )
  })
})

// ---------------------------------------------------------------- end to end

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

const PLUGIN = 'apps/web/src/plugins/example-feature'
const PLUGIN_INDEX = `${PLUGIN}/index.ts`
const PLUGIN_ADDED = `${PLUGIN}/tests/config/example-tools.test.ts`
const PLUGIN_GONE = `${PLUGIN}/legacy.ts`
const SITE_FILE = 'apps/web/src/api/catalogue.ts'
const LONG_FILE = 'apps/web/src/api/long-imports.ts'
const TOKENS = 'apps/web/src/shared/theme-tokens.css'
const SLUG = 'acme-industrial-operations'

const pluginIndex = (member: string, v: number) =>
  `import { definePlugin } from '@rocketflare/shared/plugins'\nexport const ${member} = definePlugin([])\nexport const v = ${v}\n`
const themeTokens = (primary: string) =>
  `@theme {\n  --radius-control: 0.5rem;\n}\n[data-theme="rocketflare-light"] {\n  --color-primary: ${primary};\n}\n`
const LONG =
  "import { alphaExportedNameNumberOne, betaExportedNameNumberTwo } from '@rocketflare/shared/x'\n\n" +
  'export const both = [alphaExportedNameNumberOne, betaExportedNameNumberTwo]\n'

let tmp = ''
let kitManifest: Record<string, any> = {}
let kit = ''
const tr = (text: string) => applyReplacements(text, deriveNames(SLUG, 'Acme')).text

function commitTag(dir: string, tag: string) {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', tag])
  git(dir, ['tag', tag])
}

/**
 * 0.1.0 → 0.2.0 renames the plugin's deprecated member, adds a plugin test and deletes a plugin
 * file; 0.3.0 changes the plugin again, restyles the look and adds a file with a long import.
 * The catalogue link never changes.
 */
function makeKit(dir: string, extra: Record<string, string> = {}) {
  mkdirSync(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  writeAt(dir, MANIFEST, `${JSON.stringify({ ...kitManifest, app: null }, null, 2)}\n`)
  writeAt(dir, `${PLUGIN}/plugin.json`, '{ "id": "example-feature" }\n')
  writeAt(dir, PLUGIN_INDEX, pluginIndex('agentTools', 1))
  writeAt(dir, PLUGIN_GONE, 'export const legacy = 1\n')
  writeAt(dir, SITE_FILE, "export const PLUGIN_CATALOGUE_URL = 'https://rocketflare.dev/plugins'\n")
  writeAt(dir, TOKENS, themeTokens('oklch(50% 0.1 250)'))
  writeAt(dir, 'docs/upgrades/0.1.0.md', note('0.1.0', 'null'))
  commitTag(dir, '0.1.0')
  writeAt(dir, PLUGIN_INDEX, pluginIndex('tools', 1))
  writeAt(dir, PLUGIN_ADDED, "import { tools } from '../../index'\nexport const t = tools\n")
  rmSync(path.join(dir, PLUGIN_GONE))
  writeAt(dir, 'docs/upgrades/0.2.0.md', note('0.2.0', '0.1.0'))
  commitTag(dir, '0.2.0')
  writeAt(dir, PLUGIN_INDEX, pluginIndex('tools', 3))
  writeAt(dir, TOKENS, themeTokens('oklch(55% 0.12 35)'))
  writeAt(dir, LONG_FILE, LONG)
  writeAt(dir, 'docs/upgrades/0.3.0.md', note('0.3.0', '0.2.0'))
  for (const [rel, text] of Object.entries(extra)) writeAt(dir, rel, text)
  commitTag(dir, '0.3.0')
  return git(dir, ['rev-parse', '0.2.0'])
}

/**
 * A copy stamped at 0.2.0 by an older upgrader that skipped the vendored plugin (its files are
 * still the kit's 0.1.0) and translated the catalogue link into the app's domain.
 */
function makeApp(name: string, kitDir: string, { look = 'stock' } = {}) {
  const app = path.join(tmp, name)
  mkdirSync(app)
  for (const f of ['scripts/upgrade.mjs', 'scripts/lib']) {
    cpSync(path.join(REPO, f), path.join(app, f), { recursive: true })
  }
  // The copy's own Biome, as a real copy has after `pnpm install`.
  symlinkSync(path.join(REPO, 'node_modules'), path.join(app, 'node_modules'))
  cpSync(path.join(REPO, 'biome.json'), path.join(app, 'biome.json'))
  const surfaces = (kitManifest.surfaces as Record<string, any>[]).map(s =>
    s.id === 'example-feature' ? { ...s, source: { ...s.source, repo: kitDir, subdir: '' } } : s
  )
  writeAt(
    app,
    MANIFEST,
    `${JSON.stringify(
      {
        ...kitManifest,
        kit: {
          ...kitManifest.kit,
          repo: kitDir,
          version: '0.2.0',
          commit: git(kitDir, ['rev-parse', '0.2.0']),
        },
        app: { slug: SLUG, display: 'Acme', domain: 'acme.example.com' },
        surfaces,
        history: [],
      },
      null,
      2
    )}\n`
  )
  writeAt(app, `${PLUGIN}/plugin.json`, '{ "id": "example-feature" }\n')
  writeAt(app, PLUGIN_INDEX, tr(pluginIndex('agentTools', 1)))
  writeAt(app, PLUGIN_GONE, 'export const legacy = 1\n')
  writeAt(
    app,
    SITE_FILE,
    "export const PLUGIN_CATALOGUE_URL = 'https://acme.example.com/plugins'\n"
  )
  writeAt(
    app,
    TOKENS,
    tr(themeTokens(look === 'stock' ? 'oklch(50% 0.1 250)' : 'oklch(40% 0.2 145)'))
  )
  for (const v of ['0.1.0', '0.2.0'])
    writeAt(app, `docs/upgrades/${v}.md`, note(v, v === '0.1.0' ? 'null' : '0.1.0'))
  writeAt(app, '.gitignore', '.upgrade/\nnode_modules\n')
  git(app, ['init', '-q', '-b', 'main'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-q', '-m', 'Start'])
  return app
}

const run = (app: string, args: string[]) =>
  spawnSync(process.execPath, ['scripts/upgrade.mjs', '--to', '0.3.0', ...args], {
    cwd: app,
    encoding: 'utf8',
  })
const read = (app: string, rel: string) => readFileSync(path.join(app, rel), 'utf8')
const planOf = (app: string) => JSON.parse(read(app, '.upgrade/work/0.3.0/plan.json'))
const fileOf = (app: string, rel: string) =>
  planOf(app).files.find((f: { path: string }) => f.path === rel)

beforeAll(() => {
  if (!MANIFEST) throw new Error('no provenance manifest at the repo root')
  tmp = mkdtempSync(path.join(tmpdir(), 'upgrade-repairs-'))
  kitManifest = JSON.parse(readFileSync(path.join(REPO, MANIFEST), 'utf8'))
  kit = path.join(tmp, 'kit')
  makeKit(kit)
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('an upgrade after an older upgrader', () => {
  let app = ''
  let applied: ReturnType<typeof run>
  beforeAll(() => {
    app = makeApp('drifted', kit)
    const plan = run(app, [])
    if (plan.status !== 0) throw new Error(`plan exit ${plan.status}: ${plan.stderr}`)
    applied = run(app, ['--no-fetch', '--apply', '--apply-deletes'])
  })

  it('plans the stranded plugin file from the release it really is', () => {
    expect(applied.status, applied.stderr).toBe(0)
    expect(fileOf(app, PLUGIN_INDEX)).toMatchObject({ class: 'modified', base: '0.1.0' })
    expect(fileOf(app, PLUGIN_ADDED)).toMatchObject({ class: 'added' })
    expect(fileOf(app, PLUGIN_GONE)).toMatchObject({ class: 'deleted' })
  })

  it("brings the vendored plugin to the target's version", () => {
    expect(read(app, PLUGIN_INDEX)).toBe(tr(pluginIndex('tools', 3)))
    expect(read(app, PLUGIN_INDEX)).not.toContain('agentTools')
    expect(existsSync(path.join(app, PLUGIN_ADDED))).toBe(true)
    expect(existsSync(path.join(app, PLUGIN_GONE))).toBe(false)
  })

  it('puts the kit catalogue link back, and stages it', () => {
    expect(read(app, SITE_FILE)).toContain("'https://rocketflare.dev/plugins'")
    expect(applied.stdout).toContain(`repaired    ${SITE_FILE}`)
    expect(git(app, ['diff', '--cached', '--name-only'])).toContain(SITE_FILE)
  })

  it('formats what it wrote for the app’s longer name', () => {
    const text = read(app, LONG_FILE)
    expect(text).toContain(`@${SLUG}/shared/x`)
    expect(Math.max(...text.split('\n').map(l => l.length))).toBeLessThanOrEqual(100)
    expect(applied.stdout).toContain('formatted   formatted with biome')
  })

  it('takes the look in a copy that never changed it', () => {
    expect(fileOf(app, TOKENS)).toMatchObject({ class: 'modified' })
    expect(read(app, TOKENS)).toContain('oklch(55% 0.12 35)')
  })
})

describe('a copy with a look of its own', () => {
  it('gets its look files as manual, and its tokens untouched', () => {
    const app = makeApp('own-look', kit, { look: 'own' })
    const plan = run(app, [])
    expect(plan.status, plan.stderr).toBe(0)
    const tokens = fileOf(app, TOKENS)
    expect(tokens).toMatchObject({ class: 'manual', look: true })
    expect(tokens.reason).toContain('--adopt-default-look')
    expect(planOf(app).look.diverged).toEqual([TOKENS])
    const r = run(app, ['--no-fetch', '--apply'])
    expect(r.status, r.stderr).toBe(0)
    expect(read(app, TOKENS)).toContain('oklch(40% 0.2 145)')
    expect(read(app, TOKENS)).not.toContain('oklch(55% 0.12 35)')
  })
})

describe('a handed-over run', () => {
  it('prints 1/6 kit once', () => {
    const current = readFileSync(path.join(REPO, 'scripts/upgrade.mjs'), 'utf8')
    const extra: Record<string, string> = {
      'scripts/upgrade.mjs': current.replace(
        /^const HERE = /m,
        '// the target release\nconst HERE = '
      ),
    }
    for (const f of readdirSync(path.join(REPO, 'scripts/lib'))) {
      extra[`scripts/lib/${f}`] = readFileSync(path.join(REPO, 'scripts/lib', f), 'utf8')
    }
    const handKit = path.join(tmp, 'kit-handover')
    makeKit(handKit, extra)
    const app = makeApp('handover', handKit)
    const r = run(app, [])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain("0.3.0's, not this copy's")
    expect(r.stdout.match(/1\/6 kit/g)).toHaveLength(1)
    expect(r.stdout).toContain('2/6 surfaces')
  })
})

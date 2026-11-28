/**
 * Keeping an app's own look across a release whose look added tokens, and the two traps the
 * look tooling had around it (`scripts/lib/brand.mjs`, `scripts/design-docs.mjs`):
 *
 * - `--add-missing-tokens`: every token of the kit's look the app lacks, derived from the app's
 *   own palette, written into its blocks, held to the contrast floors; no token the app has moves.
 * - `--adopt-default-look` names the kit's faces in `@theme`; when the app does not load them it
 *   says exactly which import and dependency to add (`fontLoading`).
 * - A newer kit's script run on a copy: `--root <copy>` works, and run from inside the copy
 *   without it the script refuses instead of quietly working on its own checkout.
 *
 * Kit-only: the fixtures are the kit's own token files, renamed to an `acme` copy and turned to
 * other hues, so a retuned default needs no edit here. No network.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addMissingTokens,
  applyHue,
  fontLoading,
  fontsourcePackage,
  hexOf,
  rotateHue,
} from '../../../../scripts/lib/brand.mjs'
import { checkTheme, themeTokens } from '../../../../scripts/lib/contrast.mjs'
import { applyReplacements, deriveNames } from '../../../../scripts/lib/rename-lib.mjs'

const REPO = path.resolve(__dirname, '../../../..')
const SCRIPT = path.join(REPO, 'scripts/design-docs.mjs')
const TOKENS = 'apps/web/src/shared/theme-tokens.css'
const INDEX = 'apps/web/src/ui/index.css'
const HTML = 'apps/web/src/ui/index.html'
const MAIN = 'apps/web/src/ui/main.tsx'
const PKG = 'apps/web/package.json'
const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8')
const names = deriveNames('acme', 'Acme')
const acme = (text: string) => applyReplacements(text, names).text
/** The kit's look, in the copy's names. */
const defaults = () => ({ tokensCss: acme(read(TOKENS)), indexCss: acme(read(INDEX)) })

/** The tokens the 0.45 look introduced, which an older copy's blocks do not have. */
const NEW_LOOK =
  /^ {2}--(?:rail-[\w-]+|series-\d|flare|selection-[\w-]+|surface-bubble|shadow-[\w-]+|radius-(?:control|panel|popover)|font-[\w-]+): [^;]+;[^\n]*\n/gm

/**
 * A copy that kept a look of its own: the kit's files turned to `hue`, its primary (and the focus
 * ring) set to `primary`, every token of the newer look removed. `hex` writes each colour as hex,
 * as a copy from before the oklch look has them.
 */
function keeper(hue: number, primary: string, { hex = false } = {}) {
  const turned = applyHue(defaults(), hue)
  const strip = (css: string) => {
    let out = css
      .replace(NEW_LOOK, '')
      .replace(/--color-primary: oklch\([^)]*\)/, `--color-primary: ${primary}`)
      .replace(/--focus-ring: oklch\([^)]*\)/, `--focus-ring: ${primary}`)
    if (hex)
      out = out.replace(
        /(--[\w-]+:\s*)(oklch\([^)/]*\))(\s*;)/g,
        (_, a, c, b) => `${a}${hexOf(c)}${b}`
      )
    return out
  }
  return { tokensCss: strip(turned.tokensCss), indexCss: strip(turned.indexCss) }
}

const tokensOf = (files: { tokensCss: string; indexCss: string }) =>
  themeTokens(`${files.tokensCss}\n${files.indexCss}`)
const failures = (files: { tokensCss: string; indexCss: string }) => {
  const t = tokensOf(files)
  return (['light', 'dark'] as const).flatMap(kind => {
    const r = checkTheme(t[kind].tokens)
    return [
      ...r.pairs.filter(p => !p.ok).map(p => `${kind} ${p.fg} on ${p.bg}: ${p.ratio ?? p.problem}`),
      ...r.equal.filter(e => !e.ok).map(e => `${kind} ${e.a} != ${e.b}`),
    ]
  })
}
/** Every `--x: v` of the files' blocks, per theme, plus `@theme`. */
const everyToken = (files: { tokensCss: string; indexCss: string }) => {
  const t = tokensOf(files)
  const theme = /@theme\s*\{([^}]*)\}/.exec(files.tokensCss.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1]
  const decl = Object.fromEntries(
    [...(theme ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])
  )
  return { theme: decl, light: t.light.tokens, dark: t.dark.tokens }
}

const PALETTES: Array<[number, string, { hex?: boolean }]> = [
  [255, '#1d4ed8', {}],
  [290, '#6d28d9', {}],
  [180, '#0f766e', {}],
  [150, '#166534', { hex: true }],
  [10, '#be123c', { hex: true }],
]

describe('addMissingTokens', () => {
  it.each(PALETTES)(
    'hue %s, primary %s: every added token passes every contrast pair',
    (hue, primary, o) => {
      const current = keeper(hue, primary, o)
      expect(failures(current).filter(f => !/not defined/.test(f))).toEqual([])
      const r = addMissingTokens({ current, defaults: defaults() })
      expect(r.failing).toEqual([])
      expect(failures(r)).toEqual([])
    }
  )

  it.each(PALETTES)('hue %s: changes no token the app has', (hue, primary, o) => {
    const current = keeper(hue, primary, o)
    const before = everyToken(current)
    const after = everyToken(addMissingTokens({ current, defaults: defaults() }))
    for (const kind of ['theme', 'light', 'dark'] as const)
      for (const [prop, value] of Object.entries(before[kind]))
        expect(after[kind][prop], `${kind} ${prop}`).toBe(value)
  })

  it('adds every token of the look the app lacks, in the block the kit keeps it in', () => {
    const current = keeper(255, '#1d4ed8')
    const r = addMissingTokens({ current, defaults: defaults() })
    const kit = everyToken(defaults())
    const app = everyToken(current)
    const expected = (['theme', 'light', 'dark'] as const).flatMap(kind =>
      Object.keys(kit[kind])
        .filter(p => !(p in app[kind]))
        .map(p => `${kind} ${p}`)
    )
    const fontFaces = ['theme --font-sans', 'theme --font-mono']
    expect(r.added.map(a => `${a.kind} ${a.prop}`).sort()).toEqual(
      expected.filter(e => !fontFaces.includes(e)).sort()
    )
    expect(r.added.find(a => a.prop === '--rail-surface')).toMatchObject({
      file: 'index.css',
      kind: 'light',
    })
    expect(r.added.find(a => a.prop === '--radius-control')).toMatchObject({
      file: 'theme-tokens.css',
      kind: 'theme',
    })
    expect(r.missing).toEqual([])
    expect(everyToken(r).light['--series-3']).toBeDefined()
  })

  it("derives the values from the app's palette, not the kit's", () => {
    const current = keeper(255, '#1d4ed8')
    const r = addMissingTokens({ current, defaults: defaults() })
    const added = Object.fromEntries(r.added.map(a => [`${a.kind} ${a.prop}`, a.value]))
    // A token the kit holds equal to the primary is the app's primary, verbatim.
    expect(added['light --rail-active']).toBe('#1d4ed8')
    expect(added['theme --radius-control']).toBe(everyToken(current).light['--radius-field'])
    // The rail and the selection sit on the app's hue (255), not the kit's (35).
    expect(added['light --rail-surface']).toMatch(/ 255\)$/)
    expect(added['dark --selection-surface']).toMatch(/ 255\)$/)
    // A series off the brand hue keeps its offset from it.
    const kit = everyToken(defaults()).light
    const hue = (v: string) => Number(/ ([\d.]+)\)$/.exec(v)?.[1])
    const offset = (h: number) => (((h % 360) + 540) % 360) - 180
    expect(offset(hue(added['light --series-2']) - 255)).toBeCloseTo(
      offset(hue(kit['--series-2']) - 35),
      0
    )
    // The flare keeps its own hue; a shadow is turned to the app's hue.
    expect(added['light --flare']).toBe(kit['--flare'])
    expect(added['light --shadow-panel']).toBe(
      rotateHue(`--shadow-panel: ${kit['--shadow-panel']};`, 255 - 35).css.slice(16, -1)
    )
  })

  it("leaves the kit's face out: the app's font stays as it renders", () => {
    const r = addMissingTokens({ current: keeper(255, '#1d4ed8'), defaults: defaults() })
    expect(r.skipped.join('\n')).toMatch(/--font-sans/)
    expect(r.tokensCss).not.toContain('IBM Plex Sans')
    expect(r.added.find(a => a.prop === '--font-heading')?.value).toBe('var(--font-sans)')
  })

  it('moves a derived value until its pair passes: the flare on a bright rail', () => {
    const current = keeper(255, '#1d4ed8')
    current.indexCss = current.indexCss.replace(
      /(\[data-theme="acme-light"\] \{)/,
      `$1
  --rail-surface: #2563eb;
  --rail-border: #3b82f6;
  --rail-text: #ffffff;
  --rail-text-muted: #f1f5f9;
  --rail-hover: #1d4ed8;
  --rail-active: #1e3a8a;
  --rail-active-text: #ffffff;
  --rail-focus-ring: #fde68a;`
    )
    const kitFlare = everyToken(defaults()).light['--flare']
    const failsAsKit = checkTheme({
      ...everyToken(current).light,
      '--flare': kitFlare,
    }).pairs.find(p => p.fg === '--flare')
    expect(failsAsKit?.ok).toBe(false)
    const r = addMissingTokens({ current, defaults: defaults() })
    const flare = r.added.find(a => a.kind === 'light' && a.prop === '--flare')
    expect(flare?.adjusted).toBe(true)
    expect(everyToken(r).light['--rail-surface']).toBe('#2563eb')
    expect(failures(r)).toEqual([])
  })

  it('reports a pair it cannot pass, against a token of the app that fails already', () => {
    // A light primary too pale for the panel: no new chat-bubble surface can carry it either.
    const r = addMissingTokens({ current: keeper(60, '#ca8a04'), defaults: defaults() })
    expect(r.failing.join('\n')).toMatch(/--color-primary #ca8a04 on --surface-bubble/)
  })

  it('running it twice adds nothing the second time', () => {
    const once = addMissingTokens({ current: keeper(180, '#0f766e'), defaults: defaults() })
    const twice = addMissingTokens({ current: once, defaults: defaults() })
    expect(twice.added).toEqual([])
    expect(twice.tokensCss).toBe(once.tokensCss)
    expect(twice.indexCss).toBe(once.indexCss)
  })
})

describe('fontLoading', () => {
  const kit = { mainTsx: read(MAIN), packageJson: read(PKG) }
  const theme = (sans: string) => `@theme {\n  --font-sans: ${sans};\n}\n`
  const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps })

  it("names the kit's package and version for the kit's own face", () => {
    const [plex] = fontLoading({
      tokensCss: theme('"IBM Plex Sans Variable", ui-sans-serif, sans-serif'),
      mainTsx: "import '@fontsource/inter'\n",
      packageJson: pkg({ '@fontsource/inter': '^5.0.0' }),
      kit,
    })
    expect(plex).toMatchObject({
      family: 'IBM Plex Sans Variable',
      pkg: '@fontsource-variable/ibm-plex-sans',
      version: JSON.parse(kit.packageJson).dependencies['@fontsource-variable/ibm-plex-sans'],
      imported: false,
      declared: false,
      loaded: false,
    })
  })

  it("is satisfied by the kit's own files, a stylesheet link or an @font-face", () => {
    const loads = (o: Partial<Parameters<typeof fontLoading>[0]>) =>
      fontLoading({ tokensCss: read(TOKENS), ...o })
    expect(
      loads({ mainTsx: kit.mainTsx, packageJson: kit.packageJson }).every(
        f => f.imported && f.declared
      )
    ).toBe(true)
    expect(
      fontLoading({
        tokensCss: theme('"Fraunces", Georgia, serif'),
        indexHtml: '<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400">',
      })[0].loaded
    ).toBe(true)
    expect(
      fontLoading({
        tokensCss: theme('"Acme Grotesk", sans-serif'),
        indexCss: '@font-face { font-family: "Acme Grotesk"; src: local("x"); }',
      })[0].loaded
    ).toBe(true)
  })

  it('ignores system faces and guesses a package for any other family', () => {
    expect(fontLoading({ tokensCss: theme('ui-sans-serif, system-ui, sans-serif') })).toEqual([])
    expect(fontsourcePackage('Inter')).toBe('@fontsource/inter')
    expect(fontsourcePackage('Fraunces Variable')).toBe('@fontsource-variable/fraunces')
  })
})

describe('pnpm design:docs, run on a copy', () => {
  let root: string
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  const at = (rel: string) => readFileSync(path.join(root, rel), 'utf8')
  const node = (args: string[], cwd = REPO) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd })
  const run = (...args: string[]) => node(['--root', root, ...args])

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'keep-look-'))
    const k = keeper(255, '#1d4ed8')
    write(TOKENS, k.tokensCss.replace(/(@theme \{)/, '$1\n  --font-sans: "Inter", sans-serif;'))
    write(INDEX, k.indexCss)
    write(HTML, acme(read(HTML)))
    write(
      MAIN,
      read(MAIN).replace(/import '@fontsource-variable[^\n]*\n/g, "import '@fontsource/inter'\n")
    )
    write(
      PKG,
      JSON.stringify({ name: '@acme/web', dependencies: { '@fontsource/inter': '^5.0.0' } })
    )
    write(
      '.rocketflare.json',
      JSON.stringify({
        kit: { version: '0.0.0', commit: null },
        app: { slug: 'acme', display: 'Acme', domain: 'acme.example.com' },
      })
    )
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('--add-missing-tokens prints each token it added and writes them; nothing the second time', () => {
    const before = everyToken({ tokensCss: at(TOKENS), indexCss: at(INDEX) })
    const r = run('--add-missing-tokens', '--from', REPO)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^added index\.css light --rail-surface: oklch\([^)]+\)/m)
    expect(r.stdout).toMatch(/^added theme-tokens\.css @theme --radius-control: /m)
    expect(r.stdout).toMatch(
      /^added index\.css light --rail-active: #1d4ed8 \(from your --color-primary\)$/m
    )
    expect(r.stdout).toMatch(/wrote apps\/web\/src\/ui\/index\.css/)
    // The app loads its own face, Inter, and keeps it: no font warning.
    expect(r.stderr).toBe('')
    const after = everyToken({ tokensCss: at(TOKENS), indexCss: at(INDEX) })
    for (const kind of ['theme', 'light', 'dark'] as const)
      for (const [prop, value] of Object.entries(before[kind]))
        expect(after[kind][prop]).toBe(value)
    expect(failures({ tokensCss: at(TOKENS), indexCss: at(INDEX) })).toEqual([])
    const again = run('--add-missing-tokens', '--from', REPO)
    expect(again.status, again.stderr).toBe(0)
    expect(again.stdout).toMatch(/Nothing to add/)
  })

  it('--add-missing-tokens writes nothing, and exits 1, when a pair cannot pass', () => {
    const k = keeper(60, '#ca8a04')
    write(TOKENS, k.tokensCss)
    write(INDEX, k.indexCss)
    const r = run('--add-missing-tokens', '--from', REPO)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/Wrote nothing/)
    expect(at(TOKENS)).toBe(k.tokensCss)
    expect(at(INDEX)).toBe(k.indexCss)
  })

  it("--adopt-default-look says which of the look's faces the app does not load, and how", () => {
    const r = run('--adopt-default-look', '--from', REPO)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toMatch(/"IBM Plex Sans Variable", which this app does not load/)
    expect(r.stderr).toContain(`add to ${MAIN}:  import '@fontsource-variable/ibm-plex-sans'`)
    const version = JSON.parse(read(PKG)).dependencies['@fontsource-variable/jetbrains-mono']
    expect(r.stderr).toContain(
      `pnpm --filter ./apps/web add @fontsource-variable/jetbrains-mono@${version}`
    )
    // With the kit's imports and dependencies in place, it says nothing.
    write(MAIN, read(MAIN))
    write(PKG, read(PKG))
    const quiet = run('--adopt-default-look', '--from', REPO)
    expect(quiet.stderr).not.toMatch(/does not load/)
  })

  it("the kit's script, run from inside a copy without --root, refuses and names the flag", () => {
    const before = at(INDEX)
    const r = node(['--add-missing-tokens', '--from', REPO], root)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/run from inside .*keep-look-.*: without --root it works on/)
    expect(r.stderr).toMatch(/Pass --root \S*keep-look-/)
    expect(at(INDEX)).toBe(before)
  })

  it('--from naming the checkout being worked on is refused, not a silent no-op', () => {
    const r = node(['--adopt-default-look', '--from', REPO])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/is the checkout being worked on/)
  })

  it('says where the defaults come from when this script is not the copy’s', () => {
    const r = run('--add-missing-tokens')
    expect(r.stdout).toMatch(/note: the defaults come from .*'s own record/)
  })
})

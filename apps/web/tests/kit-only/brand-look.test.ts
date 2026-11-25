/**
 * The brand's reach over the default look (`scripts/lib/brand.mjs`): one hue turning the whole
 * palette (`applyHue`, behind brand.css `--brand-hue` and the rename's `--colour`), the shape,
 * depth, font and series tokens a brand.css may set, the shell's contrast pairs, and
 * `pnpm design:docs --adopt-default-look` — the kit's default token files taken by a copy, from a
 * kit checkout or from the upgrade's mirror, in the copy's names, with its brand.css on top.
 *
 * Kit-only: it reads the kit's own token files and asserts on the kit's hue (35, ember) and names;
 * every other expected value is read from those files, so a retuned default needs no edit here.
 * The CLI runs against throwaway checkouts in the OS temp directory. No network.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  adoptDefaultLook,
  applyBrand,
  applyHue,
  brandHue,
  hueOf,
} from '../../../../scripts/lib/brand.mjs'
import {
  checkTheme,
  contrastPairs,
  SHELL_PAIRS,
  themeTokens,
} from '../../../../scripts/lib/contrast.mjs'
import { applyReplacements, deriveNames } from '../../../../scripts/lib/rename-lib.mjs'

const REPO = path.resolve(__dirname, '../../../..')
const SCRIPT = path.join(REPO, 'scripts/design-docs.mjs')
const TOKENS = 'apps/web/src/shared/theme-tokens.css'
const INDEX = 'apps/web/src/ui/index.css'
const HTML = 'apps/web/src/ui/index.html'
const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8')
const kit = () => ({ tokensCss: read(TOKENS), indexCss: read(INDEX), indexHtml: read(HTML) })
const both = (files: { tokensCss: string; indexCss: string }) =>
  `${files.tokensCss}\n${files.indexCss}`
/** The kit's own token values, per theme. */
const kitTokens = () => {
  const t = themeTokens(both(kit()))
  return { light: t.light.tokens, dark: t.dark.tokens }
}
const KIT_HUE = brandHue(both(kit())) as number
/** An `oklch(L C H)` value turned by `delta` degrees, written as `rotateHue` writes it. */
const turned = (value: string, delta: number) =>
  value.replace(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)/, (_, l, c, h) => {
    const hue = Number(((((Number(h) + delta) % 360) + 360) % 360).toFixed(2))
    return `oklch(${l} ${c} ${hue}`
  })
/** A kit token at brand hue `hue`: its offset from the kit's hue kept. */
const atHue = (value: string, hue: number) => turned(value, hue - KIT_HUE)
const failures = (files: { tokensCss: string; indexCss: string }) => {
  const themes = themeTokens(`${files.tokensCss}\n${files.indexCss}`)
  return (['light', 'dark'] as const).flatMap(kind =>
    checkTheme(themes[kind].tokens)
      .pairs.filter(p => !p.ok)
      .map(p => `${kind} ${p.fg} on ${p.bg}: ${p.ratio ?? p.problem}`)
  )
}

describe('one hue turns the palette', () => {
  it('keeps every contrast floor at every hue, so --colour and --brand-hue cannot pick a failing one', () => {
    const k = kit()
    const broken = Array.from({ length: 72 }, (_, i) => i * 5).flatMap(hue =>
      failures(applyHue(k, hue)).map(f => `${hue}°: ${f}`)
    )
    expect(broken).toEqual([])
  })

  it('reads the hue from the files, never assumes it', () => {
    const k = kit()
    // The kit's default, ember: a warm rust hue the neutrals, primary and rail all share.
    expect(brandHue(both(k))).toBe(35)
    expect(kitTokens().light['--color-primary']).toMatch(/ 35\)$/)
    expect(brandHue(applyHue(k, 40).tokensCss)).toBe(40)
    expect(hueOf('#777777')).toMatchObject({ error: expect.stringMatching(/grey/) })
    expect(hueOf('120')).toEqual({ hue: 120 })
  })

  it.each([25, 145, 300])('hue %s keeps every contrast floor', hue => {
    expect(failures(applyHue(kit(), hue))).toEqual([])
  })

  it('leaves the flare, the state colours and comments where they were', () => {
    const k = kitTokens()
    const r = applyHue(kit(), 25)
    const t = themeTokens(both(r))
    for (const kind of ['light', 'dark'] as const)
      expect(t[kind].tokens['--flare']).toBe(k[kind]['--flare'])
    expect(r.indexCss).toContain('--tone-error-surface: #ffe4e6;')
    expect(t.light.tokens['--rail-surface']).toBe(atHue(k.light['--rail-surface'], 25))
    expect(t.light.tokens['--rail-surface']).toMatch(/ 25\)$/)
    // A series off the brand hue keeps its offset from it.
    expect(t.light.tokens['--series-2']).toBe(atHue(k.light['--series-2'], 25))
    expect(t.light.tokens['--series-2']).not.toBe(k.light['--series-2'])
    expect(r.indexHtml).toContain(`<meta name="theme-color" content="${r.primary}"`)
  })
})

describe('brand.css', () => {
  it('--brand-hue turns the palette first; explicit properties land on top', () => {
    const r = applyBrand(
      kit(),
      `@theme { --brand-hue: 145; }
@plugin "daisyui/theme" { name: "x-light"; --color-accent: oklch(0.5 0.1 60); }`
    )
    const k = kitTokens()
    expect(r.hue).toEqual({ from: KIT_HUE, to: 145, rotated: expect.any(Number) })
    expect(r.unknown).toEqual([])
    expect(r.problems).toEqual([])
    expect(r.tokensCss).toContain(`--color-primary: ${atHue(k.light['--color-primary'], 145)};`)
    expect(r.tokensCss).toContain('--color-accent: oklch(0.5 0.1 60);')
    expect(r.indexCss).toContain(`--rail-active: ${atHue(k.light['--rail-active'], 145)};`)
    expect(r.warnings).toEqual([])
  })

  it('refuses a hue that is not one', () => {
    const r = applyBrand(kit(), '@theme { --brand-hue: #808080; }')
    expect(r.problems.join('\n')).toMatch(/--brand-hue: .*grey/)
    expect(r.tokensCss).toBe(read(TOKENS))
  })

  it('may set radius, depth, font and series tokens', () => {
    const r = applyBrand(
      kit(),
      `@theme {
  --font-sans: "Fraunces Variable", Georgia, serif;
  --radius-control: 4px;
  --radius-panel: 6px;
}
[data-theme="x-light"] {
  --shadow-panel: 0 1px 3px oklch(0.3 0.02 35 / 0.1);
  --series-1: oklch(0.5 0.13 30);
}`
    )
    expect(r.unknown).toEqual([])
    expect(r.tokensCss).toContain('--font-sans: "Fraunces Variable", Georgia, serif;')
    expect(r.tokensCss).toContain('--radius-control: 4px;')
    expect(r.tokensCss).toContain('--radius-panel: 6px;')
    expect(r.indexCss).toContain('--shadow-panel: 0 1px 3px oklch(0.3 0.02 35 / 0.1);')
    expect(r.indexCss).toContain('--series-1: oklch(0.5 0.13 30);')
  })

  it('a new primary without its rail and selection tones is the half-applied brand', () => {
    const r = applyBrand(
      kit(),
      '@plugin "daisyui/theme" { name: "x-light"; --color-primary: #7c3aed; }'
    )
    const said = r.warnings.join('\n')
    for (const tone of ['--rail-active', '--rail-focus-ring', '--selection-surface'])
      expect(said).toContain(`light ${tone} is still the kit's`)
  })
})

describe('the shell pairs', () => {
  it('are part of contrastPairs(), so --contrast checks them over a brand', () => {
    const pairs = contrastPairs().map(p => p.join(' '))
    for (const p of SHELL_PAIRS) expect(pairs).toContain(p.join(' '))
    expect(SHELL_PAIRS.map(p => p[0])).toEqual(
      expect.arrayContaining(['--rail-text', '--series-5', '--flare', '--rail-focus-ring'])
    )
  })
})

/** The kit's three files as a copy named `acme` has them, wearing an older look. */
function oldCopy() {
  const names = deriveNames('acme', 'Acme')
  const t = (text: string) => applyReplacements(text, names).text
  const k = kit()
  return {
    tokensCss: t(k.tokensCss)
      .replace(/--color-primary: oklch\([^)]*\)/, '--color-primary: #2563eb')
      .replace('--radius-panel: 14px;', '--radius-panel: 14px;\n  --radius-pill: 999px;'),
    indexCss: t(k.indexCss)
      .replace(/ {2}--rail-[\w-]+: [^;]+;\n/g, '')
      .replace(/--surface-app: oklch\([^)]*\);/, '--surface-app: #f4f4f5;')
      .replace(/(\[data-theme="acme-light"\] \{)/, '$1\n  --app-own: #123456;')
      .concat('\n.app-own { color: var(--app-own); }\n'),
    indexHtml: t(k.indexHtml).replace(/content="#[0-9a-f]{6}"/, 'content="#2563eb"'),
  }
}

describe('adoptDefaultLook', () => {
  const defaults = () => {
    const names = deriveNames('acme', 'Acme')
    const k = kit()
    return {
      tokensCss: applyReplacements(k.tokensCss, names).text,
      indexCss: applyReplacements(k.indexCss, names).text,
      indexHtml: applyReplacements(k.indexHtml, names).text,
    }
  }

  it("takes the default tokens, keeps the app's own tokens and styles", () => {
    const k = kitTokens()
    const r = adoptDefaultLook({ current: oldCopy(), defaults: defaults() })
    expect(r.tokensCss).toContain(`--color-primary: ${k.light['--color-primary']};`)
    expect(r.tokensCss).toContain('--radius-pill: 999px;')
    expect(r.indexCss).toContain(`--rail-surface: ${k.light['--rail-surface']};`)
    expect(r.indexCss).toContain(`--surface-app: ${k.light['--surface-app']};`)
    expect(r.indexCss).toContain('--app-own: #123456;')
    expect(r.indexCss).toContain('.app-own { color: var(--app-own); }')
    expect(r.kept).toEqual(['theme-tokens.css @theme --radius-pill', 'index.css light --app-own'])
    expect(r.missing).toEqual([])
    expect(r.indexHtml).toContain(`content="${/content="(#[0-9a-f]{6})"/.exec(read(HTML))?.[1]}"`)
    expect(failures(r)).toEqual([])
  })

  it('re-applies brand.css on top of the new defaults', () => {
    const r = adoptDefaultLook({
      current: oldCopy(),
      defaults: defaults(),
      brandCss: '@theme { --brand-hue: 25; --radius-control: 6px; }',
    })
    const k = kitTokens()
    expect(r.brand?.hue?.to).toBe(25)
    expect(r.tokensCss).toContain(`--color-primary: ${atHue(k.light['--color-primary'], 25)};`)
    expect(r.tokensCss).toContain('--radius-control: 6px;')
    expect(r.indexCss).toContain(`--rail-surface: ${atHue(k.light['--rail-surface'], 25)};`)
    expect(r.indexHtml).toContain(
      `content="${r.brand?.indexHtml?.match(/content="([^"]+)"/)?.[1]}"`
    )
    expect(failures(r)).toEqual([])
  })
})

describe('pnpm design:docs --adopt-default-look', () => {
  let root: string
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
  const manifest = (kitCommit: string | null) =>
    write(
      '.rocketflare.json',
      JSON.stringify({
        kit: { version: '0.0.0', commit: kitCommit },
        app: { slug: 'acme', display: 'Acme', domain: 'acme.example.com' },
      })
    )

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'adopt-look-'))
    const old = oldCopy()
    write(TOKENS, old.tokensCss)
    write(INDEX, old.indexCss)
    write(HTML, old.indexHtml)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("--from a kit checkout: the kit's look in the copy's names, then brand.css", () => {
    manifest(null)
    write('docs/design/brand.css', '@theme { --brand-hue: 145; }\n')
    const r = run('--adopt-default-look', '--from', REPO)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/wrote apps\/web\/src\/shared\/theme-tokens\.css/)
    expect(r.stdout).toMatch(/kept index\.css light --app-own/)
    const tokens = readFileSync(path.join(root, TOKENS), 'utf8')
    expect(tokens).toContain('name: "acme-light";')
    expect(tokens).not.toContain('rocketflare-light')
    const k = kitTokens()
    expect(tokens).toContain(`--color-primary: ${atHue(k.light['--color-primary'], 145)};`)
    expect(readFileSync(path.join(root, INDEX), 'utf8')).toContain(
      `--rail-surface: ${atHue(k.light['--rail-surface'], 145)};`
    )
  })

  it("from the upgrade's mirror at the recorded kit commit", () => {
    const src = path.join(root, 'kit-src')
    for (const rel of [TOKENS, INDEX, HTML]) {
      mkdirSync(path.dirname(path.join(src, rel)), { recursive: true })
      writeFileSync(path.join(src, rel), read(rel))
    }
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git(src, 'init', '-q')
    git(src, 'add', '.')
    git(src, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'kit')
    const commit = git(src, 'rev-parse', 'HEAD').trim()
    git(root, 'clone', '-q', '--bare', src, path.join(root, '.upgrade/kit.git'))
    manifest(commit)
    const r = run('--adopt-default-look')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`from the kit at ${commit.slice(0, 12)}`)
    const tokens = readFileSync(path.join(root, TOKENS), 'utf8')
    expect(tokens).toContain('name: "acme-light";')
    expect(tokens).toContain('--radius-pill: 999px;')
    expect(readFileSync(path.join(root, TOKENS), 'utf8')).toContain(
      `--color-primary: ${kitTokens().light['--color-primary']};`
    )
  })

  it('says why it cannot run: no mirror, or this is the kit', () => {
    manifest('abc')
    const none = run('--adopt-default-look')
    expect(none.status).toBe(2)
    expect(none.stderr).toMatch(/run `pnpm kit:upgrade` first/)
    write('.rocketflare.json', JSON.stringify({ kit: { version: '0.0.0' }, app: null }))
    const kitItself = run('--adopt-default-look')
    expect(kitItself.status).toBe(2)
    expect(kitItself.stderr).toMatch(/this is the kit/)
    expect(run('--from', REPO).stderr).toMatch(/go with --adopt-default-look/)
  })
})

/**
 * `scripts/design-docs.mjs` — `docs/design/*.md` rendered into `docs/design/html/` in the app's
 * tokens with `docs/design/brand.css` layered on, its `--check`, `--contrast` and `--apply-brand`.
 *
 * The CLI runs as a child process against a throwaway checkout in the OS temp directory holding
 * copies of this checkout's token files and logo, so a copy's own palette is what is exercised. The
 * renderer and the sanitiser are also called directly for the untrusted-input cases. No network.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyBrand } from '../../../../scripts/lib/brand.mjs'
import { orderPages } from '../../../../scripts/lib/design-docs-lib.mjs'
import { renderMarkdown } from '../../../../scripts/lib/markdown-lite.mjs'
import { sanitizeSvg } from '../../../../scripts/lib/svg-sanitize.mjs'

const REPO = path.resolve(__dirname, '../../../..')
const SCRIPT = path.join(REPO, 'scripts/design-docs.mjs')
const COPIED = [
  'apps/web/src/shared/theme-tokens.css',
  'apps/web/src/ui/index.css',
  'apps/web/src/ui/index.html',
  'apps/web/src/ui/public/logo.svg',
]

let root: string
const design = (rel: string) => path.join(root, 'docs/design', rel)
const html = (rel: string) => path.join(root, 'docs/design/html', rel)
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(design(rel)), { recursive: true })
  writeFileSync(design(rel), text)
}
const run = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'design-docs-'))
  for (const rel of COPIED) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    copyFileSync(path.join(REPO, rel), path.join(root, rel))
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('pages', () => {
  it('orders by numeric prefix, unprefixed files last and alphabetical; the first is index.html', () => {
    expect(orderPages(['notes.md', '10-ten.md', '02-two.md', 'appendix.md', '01-one.md'])).toEqual([
      '01-one.md',
      '02-two.md',
      '10-ten.md',
      'appendix.md',
      'notes.md',
    ])
    write('02-shape.md', '# The shape\n\nBody.\n')
    write('01-destination.md', '# Destination\n\nStart here.\n')
    write('notes.md', 'No heading here.\n')
    const r = run()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe(html('index.html'))
    const index = readFileSync(html('index.html'), 'utf8')
    expect(index).toContain('<h1>Destination</h1>')
    const rail = [...index.matchAll(/<li><a href="([^"]+)"/g)].map(m => m[1])
    expect(rail).toEqual(['index.html', '02-shape.html', 'notes.html'])
    expect(readFileSync(html('notes.html'), 'utf8')).toContain('<h1>Notes</h1>')
    expect(existsSync(html('styles.css'))).toBe(true)
    expect(readFileSync(html('logo.svg'), 'utf8')).toBe(
      readFileSync(path.join(REPO, 'apps/web/src/ui/public/logo.svg'), 'utf8')
    )
  })

  it('rewrites a link to another design file to its page, keeping the fragment', () => {
    write('01-a.md', '# A\n\nSee [the shape](./02-shape.md#risks) and [home](01-a.md).\n')
    write('02-shape.md', '# Shape\n\n## Risks\n\nBack [to A](./01-a.md).\n')
    expect(run().status).toBe(0)
    const a = readFileSync(html('index.html'), 'utf8')
    expect(a).toContain('<a href="02-shape.html#risks">the shape</a>')
    expect(a).toContain('<a href="index.html">home</a>')
    const shape = readFileSync(html('02-shape.html'), 'utf8')
    expect(shape).toContain('<a href="index.html">to A</a>')
    expect(shape).toContain('<h2 id="risks">Risks</h2>')
  })

  it('renders the subset: lists (nested), tables, code, quotes, rules, emphasis', () => {
    const { blocks } = renderMarkdown(
      [
        '- one',
        '  - nested *em*',
        '- **two** `x<y`',
        '',
        '1. first',
        '2. second',
        '',
        '| a | b |',
        '|---|--:|',
        '| 1 | 2 |',
        '',
        '> quoted',
        '',
        '---',
        '',
        '```js',
        'if (a < b) {}',
        '```',
      ].join('\n')
    )
    const html = blocks.map(String).join('\n')
    expect(html).toContain('<ul>\n<li>one\n<ul>\n<li>nested <em>em</em></li>\n</ul></li>')
    expect(html).toContain('<li><strong>two</strong> <code>x&lt;y</code></li>')
    expect(html).toContain('<ol>\n<li>first</li>\n<li>second</li>\n</ol>')
    expect(html).toContain('<td style="text-align: end">2</td>')
    expect(html).toContain('<blockquote>\n<p>quoted</p>\n</blockquote>')
    expect(html).toContain('<hr>')
    expect(html).toContain('<pre><code class="language-js">if (a &lt; b) {}\n</code></pre>')
  })
})

describe('untrusted input', () => {
  it('escapes raw HTML and refuses unsafe link schemes', () => {
    const { blocks } = renderMarkdown(
      '<script>alert(1)</script> <img src=x onerror=alert(2)>\n\n[x](javascript:alert(3)) [y](JaVa\tScRiPt:alert(4)) ![z](data:image/svg+xml,<svg>)',
      { link: d => (/^https?:/.test(d) ? d : null), image: () => null }
    )
    const html = blocks.map(String).join('\n')
    // Every tag is the renderer's own: the input's tags are text, and no unsafe URL became a link.
    expect(html).not.toMatch(/<(script|img|a)\b/i)
    expect(html).toContain('<p>x [y](JaVa')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('sanitises an SVG: no script, style, foreignObject, on* handlers or javascript: URLs', () => {
    const svg = sanitizeSvg(
      `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">
  <script>alert(2)</script><style>body{display:none}</style>
  <foreignObject><div>html</div></foreignObject>
  <defs><marker id="arrow"><path d="M0 0"/></marker></defs>
  <a href="javascript:alert(3)"><text class="t-muted" onclick="alert(4)">label &amp; more</text></a>
  <use href="https://evil.example/x.svg#a"/><use xlink:href="#arrow"/>
  <path marker-end="url(#arrow)" fill="url(https://evil.example/p)" style="fill: var(--color-primary)"/>
  <rect fill="&#106;avascript:alert(5)"/>
</svg>`,
      { idPrefix: 'flow-1-', label: 'A <flow>' }
    )
    expect(svg).not.toBeNull()
    expect(svg).not.toMatch(/<script|<style|foreignObject|<div|\son\w+=|javascript|evil\.example/i)
    expect(svg).toContain('role="img" aria-label="A &lt;flow&gt;"')
    expect(svg).toContain('<marker id="flow-1-arrow">')
    expect(svg).toContain('xlink:href="#flow-1-arrow"')
    expect(svg).toContain('marker-end="url(#flow-1-arrow)"')
    expect(svg).toContain('<text class="t-muted">label &amp; more</text>')
    expect(svg).toContain('style="fill: var(--color-primary)"')
  })

  it('inlines a diagram into the page as a figure, sanitised', () => {
    write('01-a.md', '# A\n\n![The flow](diagrams/flow.svg "How it flows")\n')
    write(
      'diagrams/flow.svg',
      '<svg viewBox="0 0 4 4" onload="alert(1)"><script>alert(2)</script><rect class="box"/></svg>'
    )
    expect(run().status).toBe(0)
    const page = readFileSync(html('index.html'), 'utf8')
    expect(page).toContain('<figure class="diagram">')
    expect(page).toContain('<rect class="box"/>')
    expect(page).toContain('<figcaption>How it flows</figcaption>')
    expect(page).not.toMatch(/onload|<script/)
  })
})

describe('brand.css', () => {
  it('layers over the tokens in the stylesheet of the pages', () => {
    write('01-a.md', '# A\n')
    expect(run().status).toBe(0)
    const before = readFileSync(html('styles.css'), 'utf8')
    write(
      'brand.css',
      '@plugin "daisyui/theme" {\n  name: "anything-light";\n  --color-accent: #000000;\n}\n'
    )
    expect(run().status).toBe(0)
    const after = readFileSync(html('styles.css'), 'utf8')
    const accent = (css: string) => /\n {2}--color-accent: ([^;]+);/.exec(css)?.[1]
    expect(accent(after)).toMatch(/^light-dark\(oklch\(0% 0 0\), /)
    expect(accent(after)).not.toBe(accent(before))
    // dark is untouched: the brand set only light
    expect(accent(after)?.split(', oklch')[1]).toBe(accent(before)?.split(', oklch')[1])
  })

  it('applies each property to the file that defines it, updates theme-color, and warns about derived tones', () => {
    const files = {
      tokensCss: readFileSync(path.join(root, COPIED[0]), 'utf8'),
      indexCss: readFileSync(path.join(root, COPIED[1]), 'utf8'),
      indexHtml: readFileSync(path.join(root, COPIED[2]), 'utf8'),
    }
    const brand = `@theme { --font-sans: "Inter", ui-sans-serif, sans-serif; }
@plugin "daisyui/theme" { name: "x-light"; --color-primary: #7c3aed; }
[data-theme="x-light"] { --focus-ring: #7c3aed; --surface-app: #fafaf9; --not-a-token: #fff; }`
    const r = applyBrand(files, brand)
    expect(r.tokensCss).toMatch(/--color-primary: #7c3aed;/)
    expect(r.tokensCss).toContain('--font-sans: "Inter", ui-sans-serif, sans-serif;')
    expect(r.indexCss).toMatch(/--focus-ring: #7c3aed;/)
    expect(r.indexCss).toMatch(/--surface-app: #fafaf9;/)
    expect(r.indexHtml).toContain('<meta name="theme-color" content="#7c3aed"')
    expect(r.unknown).toEqual(['light --not-a-token'])
    expect(r.warnings.join('\n')).toMatch(/light --surface-active is still the kit's/)
    expect(r.warnings.join('\n')).toMatch(/light --tone-primary-surface/)
    expect(r.warnings.join('\n')).not.toMatch(/--focus-ring/)
    // Applying the same brand again changes nothing.
    expect(applyBrand({ ...files, ...r }, brand).tokensCss).toBe(r.tokensCss)
  })

  it('--apply-brand writes the merge into the app files in place', () => {
    write('brand.css', '@plugin "daisyui/theme" { name: "y-dark"; --color-accent: #2dd4bf; }\n')
    const r = run('--apply-brand')
    expect(r.status, r.stderr).toBe(0)
    const tokens = readFileSync(path.join(root, COPIED[0]), 'utf8')
    expect(tokens).toContain('--color-accent: #2dd4bf;')
    expect(tokens).toContain('--color-accent: #0f766e;') // the light theme's, untouched
  })
})

describe('--contrast', () => {
  it("passes on the app's own tokens", () => {
    const r = run('--contrast')
    expect(r.status, r.stdout).toBe(0)
    expect(r.stdout).toMatch(/light \(\S+-light\): all \d+ pairs pass/)
    expect(r.stdout).toMatch(/dark \(\S+-dark\): all \d+ pairs pass/)
  })

  it('fails on a bad brand, naming the pair, its ratio and the minimum, per theme', () => {
    write(
      'brand.css',
      '[data-theme="z-dark"] {\n  --text-muted: #3f3f46;\n}\n@plugin "daisyui/theme" { name: "z-light"; --color-primary: #93c5fd; }\n'
    )
    const r = run('--contrast')
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/light \(\S+\): \d+ failing/)
    expect(r.stdout).toMatch(
      /--color-primary #93c5fd on --surface-panel #ffffff: \d\.\d\d:1, minimum 4\.5:1/
    )
    expect(r.stdout).toMatch(/dark \(\S+\): \d+ failing/)
    expect(r.stdout).toMatch(
      /--text-muted #3f3f46 on --surface-app #131316: \d\.\d\d:1, minimum 4\.5:1/
    )
    expect(r.stderr).toMatch(/--focus-ring is still the kit's/)
  })
})

describe('output', () => {
  it('is deterministic, removes only its own stale pages, and --check reports drift', () => {
    write('01-a.md', '# A\n')
    write('02-b.md', '# B\n')
    expect(run().status).toBe(0)
    writeFileSync(html('mine.html'), '<p>not generated</p>')
    writeFileSync(html('notes.txt'), 'keep me')
    const first = readFileSync(html('02-b.html'), 'utf8')
    expect(run('--check').status).toBe(0)
    expect(run().status).toBe(0)
    expect(readFileSync(html('02-b.html'), 'utf8')).toBe(first)

    rmSync(design('02-b.md'))
    const check = run('--check')
    expect(check.status).toBe(1)
    expect(check.stderr).toContain('stale page: docs/design/html/02-b.html')
    expect(existsSync(html('02-b.html'))).toBe(true) // --check builds nothing

    expect(run().status).toBe(0)
    expect(existsSync(html('02-b.html'))).toBe(false)
    expect(existsSync(html('mine.html'))).toBe(true)
    expect(existsSync(html('notes.txt'))).toBe(true)
    expect(run('--check').status).toBe(0)

    write('01-a.md', '# A, edited\n')
    expect(run('--check').stderr).toContain('out of date: docs/design/html/index.html')
  })

  it('names a missing design folder', () => {
    const r = run()
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/no docs\/design\/\*\.md/)
  })

  it('resolves from the workspace root as `pnpm design:docs`', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'))
    expect(pkg.scripts['design:docs']).toBe('node scripts/design-docs.mjs')
    expect(execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })).toMatch(
      /--contrast/
    )
  })
})

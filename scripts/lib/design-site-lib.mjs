/**
 * The design site (`scripts/design-site.mjs`): `docs/design/*.md` rendered into a small static
 * site in the app's own tokens, so whoever is designing the app reads it in their own brand.
 *
 * `planSite(inputs)` is pure — the markdown, the token files, the brand and the logo in, every
 * output file's bytes out — so the same inputs always print the same site (it is committed with
 * the design, and a re-run without changes must not produce a diff) and `--check` is a plain
 * byte comparison. The CLI does the reading, the writing and the stale-page sweep.
 */
import { applyBrand, themeDeclarations } from './brand.mjs'
import { oklchText, parseColour, themeTokens } from './contrast.mjs'
import { escapeHtml, renderMarkdown } from './markdown-lite.mjs'
import { sanitizeSvg } from './svg-sanitize.mjs'

/** Every page the generator writes carries this, and only those are ever deleted as stale. */
export const GENERATOR_META = '<meta name="generator" content="rocketflare design-site">'

// ------------------------------------------------------------------- Pages

/**
 * The design files in reading order: a numeric prefix (`01-destination.md`) sorts by its number,
 * then by name; a file without one sorts after every numbered file, alphabetically.
 */
export function orderPages(files) {
  const key = f => {
    const m = /^(\d+)/.exec(f)
    return m ? [0, Number(m[1]), f] : [1, 0, f]
  }
  return [...files]
    .filter(f => /\.md$/i.test(f))
    .sort((a, b) => {
      const [ka, kb] = [key(a), key(b)]
      return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0)
    })
}

/** `file.md` → its page's file name; the first page is `index.html`. */
export function pageNames(ordered) {
  const used = new Set()
  const out = new Map()
  ordered.forEach((file, i) => {
    let name =
      i === 0
        ? 'index'
        : file
            .replace(/\.md$/i, '')
            .replace(/[^\w.-]+/g, '-')
            .toLowerCase()
    if (name === 'styles' || name === 'logo') name = `${name}-page`
    while (used.has(name)) name = `${name}-2`
    used.add(name)
    out.set(file, `${name}.html`)
  })
  return out
}

/** A title from a file name when the page has no `# ` heading: `02-the-shape.md` → `The shape`. */
function titleFromFile(file) {
  const words = file
    .replace(/\.md$/i, '')
    .replace(/^\d+[-_. ]*/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return words ? words[0].toUpperCase() + words.slice(1) : file
}

/** `s` without whitespace or control characters (U+0000 to U+0020, U+007F), which a browser ignores in a URL scheme. */
const withoutControls = s =>
  [...s].filter(ch => ch.charCodeAt(0) > 32 && ch.charCodeAt(0) !== 127).join('')

/** A link target from the markdown → the href to use, or null for an unsafe one. */
export function resolveLink(dest, names) {
  const raw = String(dest).trim()
  const probe = withoutControls(raw)
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe)
  if (scheme) return /^(https?|mailto)$/i.test(scheme[1]) ? raw : null
  if (probe.startsWith('//')) return `https:${raw}`
  if (raw.startsWith('#')) return raw
  const [path, ...hash] = raw.split('#')
  const fragment = hash.length ? `#${hash.join('#')}` : ''
  const file = path.replace(/^\.\//, '')
  if (names.has(file)) return names.get(file) + fragment
  if (file === '' || file.startsWith('/')) return null
  // Anything else relative is a file beside the design docs: the site sits one folder below them.
  return `../${file}${fragment}`
}

// ------------------------------------------------------------------- Tokens

const SYSTEM_FONTS = new Set(
  [
    'ui-sans-serif',
    'ui-serif',
    'ui-monospace',
    'ui-rounded',
    'system-ui',
    '-apple-system',
    'blinkmacsystemfont',
    'segoe ui',
    'helvetica neue',
    'helvetica',
    'arial',
    'sans-serif',
    'serif',
    'monospace',
    'cursive',
    'sf mono',
    'sf pro',
    'sf pro text',
    'menlo',
    'monaco',
    'consolas',
    'liberation mono',
    'courier new',
    'courier',
    'georgia',
    'times new roman',
    'times',
    'verdana',
    'tahoma',
    'trebuchet ms',
  ].map(f => f.toLowerCase())
)

/** The first family of a font stack when it is not a system font, so may be a Google Font. */
export function webFont(stack) {
  if (!stack) return null
  const first = stack
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '')
  if (!first || SYSTEM_FONTS.has(first.toLowerCase())) return null
  return /^[A-Za-z0-9 ]{2,60}$/.test(first) ? first : null
}

/** The Google Fonts stylesheet URL for the brand's web fonts, or null. */
export function googleFontsHref(fonts) {
  const families = [...new Set(fonts.filter(Boolean))]
  if (!families.length) return null
  const q = families.map(f => `family=${f.trim().replace(/ +/g, '+')}:wght@400;600;700`).join('&')
  return `https://fonts.googleapis.com/css2?${q}&display=swap`
}

/** The tokens the site uses, light and dark, with the brand layered on. */
export function siteTokens({ tokensCss, indexCss, brandCss }) {
  const merged = brandCss ? applyBrand({ tokensCss, indexCss }, brandCss) : null
  const tokens = merged?.tokensCss ?? tokensCss
  const index = merged?.indexCss ?? indexCss
  return {
    themes: themeTokens(`${tokens}\n${index}`),
    fonts: themeDeclarations(tokens),
    brand: merged,
  }
}

const FALLBACK_SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
const FALLBACK_MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

/** One `--name: light-dark(…)` line per colour token, in oklch. */
function colourDeclarations(themes) {
  const light = themes.light.tokens
  const dark = themes.dark.tokens
  const names = [...new Set([...Object.keys(light), ...Object.keys(dark)])]
  const lines = []
  for (const name of names) {
    const l = parseColour(light[name] ?? dark[name] ?? '')
    const d = parseColour(dark[name] ?? light[name] ?? '')
    if (!l || !d) continue
    const [lt, dt] = [oklchText(l), oklchText(d)]
    lines.push(`  ${name}: ${lt === dt ? lt : `light-dark(${lt}, ${dt})`};`)
  }
  return lines.join('\n')
}

/** The site's stylesheet: the merged tokens, then the kit's chrome over them. */
export function stylesheet({ themes, fonts }) {
  const sans = fonts['--font-sans'] ?? FALLBACK_SANS
  const mono = fonts['--font-mono'] ?? FALLBACK_MONO
  return `/* Generated by scripts/design-site.mjs from apps/web/src/shared/theme-tokens.css and the
   semantic blocks of apps/web/src/ui/index.css, with docs/design/brand.css layered over them.
   Do not edit: change the tokens or brand.css and run \`pnpm design:site\` again.

   Diagrams (docs/design/diagrams/*.svg) are inlined, so they may use these variables and the
   classes at the end of this file: box, box-inset, box-primary|success|warning|error|info,
   t-muted, t-sec, t-primary|success|warning|error, line, line-primary|warning|error,
   dot-primary|warning|muted. */

*,
*::before,
*::after {
  box-sizing: border-box;
  min-width: 0;
}

:root {
  color-scheme: light dark;
  scrollbar-gutter: stable;
  text-wrap: pretty;
  overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;

  --font-sans: ${sans};
  --font-mono: ${mono};

${colourDeclarations(themes)}

  /* Names the diagrams may use, over the DaisyUI ones above */
  --primary: var(--color-primary);
  --primary-content: var(--color-primary-content);
  --accent: var(--color-accent);
  --tone-primary: var(--color-primary);
  --tone-info: var(--color-info);
  --tone-success: var(--color-success);
  --tone-warning: var(--color-warning);
  --tone-error: var(--color-error);

  --radius-control: 5px;
  --radius-panel: 6px;
  --panel-pad: clamp(1rem, 0.75rem + 0.8vw, 1.5rem);
}

body {
  margin: 0;
  min-block-size: 100svh;
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.55;
  background: var(--surface-app);
  color: var(--text-primary);
}

h1,
h2,
h3,
h4,
h5,
h6 {
  text-wrap: balance;
  letter-spacing: -0.014em;
  line-height: 1.25;
  margin-block: 1.25em 0.5em;
}
h1 { font-size: clamp(1.375rem, 1.2rem + 0.6vw, 1.75rem); }
h2 { font-size: 1.1875rem; margin-block-start: 0; }
h3 { font-size: 1.0625rem; }
h4, h5, h6 { font-size: 1rem; }
p, ul, ol, blockquote, pre, .table-wrap, figure { margin-block: 0 0.9em; }
ul, ol { padding-inline-start: 1.4rem; }
li + li, li > ul, li > ol { margin-block-start: 0.25em; }
li > ul, li > ol { margin-block-end: 0; }
hr { border: 0; border-block-start: 1px solid var(--border-subtle); margin-block: 1.5em; }

img, svg { display: block; max-inline-size: 100%; block-size: auto; }

code, kbd, pre { font-family: var(--font-mono); font-size: 0.875em; }
:not(pre) > code {
  background: var(--surface-inset);
  border-radius: 4px;
  padding: 0.05em 0.35em;
}
pre {
  background: var(--surface-inset);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-panel);
  padding: 0.85rem 1rem;
  overflow-x: auto;
  line-height: 1.5;
}

blockquote {
  margin-inline: 0;
  padding: 0.6rem 1rem;
  border-inline-start: 3px solid var(--tone-primary-border);
  background: var(--tone-primary-surface);
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
  color: var(--text-secondary);
}
blockquote > :last-child { margin-block-end: 0; }

a { color: var(--color-primary); text-underline-offset: 2px; }
a:active { opacity: 0.75; }

:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-control);
}

th, td { font-variant-numeric: tabular-nums; }

/* App shell: the rail sits beside the main column while there is room and wraps above it when
   there is not. No breakpoint. */
.shell {
  display: flex;
  flex-wrap: wrap;
  min-block-size: 100svh;
}

.rail {
  flex: 1 1 15rem;
  max-inline-size: 100%;
  background: var(--surface-nav);
  border-inline-end: 1px solid var(--border-default);
  border-block-end: 1px solid var(--border-subtle);
  padding: 1rem 0.75rem;
}

.rail-inner {
  position: sticky;
  inset-block-start: 1rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.25rem 0.5rem 1rem;
  color: var(--text-primary);
  text-decoration: none;
  font-weight: 650;
}
.brand img { inline-size: 30px; flex: none; }
.brand small {
  display: block;
  font-weight: 400;
  font-size: 12px;
  color: var(--text-muted);
}

.rail nav ul { list-style: none; margin: 0; padding: 0; }
.rail nav li + li { margin-block-start: 2px; }
.rail nav a {
  display: block;
  padding: 0.45rem 0.6rem;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 14px;
}
@media (hover: hover) and (pointer: fine) {
  .rail nav a:hover { background: var(--surface-nav-hover); color: var(--text-primary); }
}
.rail nav a[aria-current="page"] {
  background: var(--surface-active);
  color: var(--color-primary);
  font-weight: 600;
}

.main {
  flex: 999 1 32rem;
  display: flex;
  flex-direction: column;
}

.page-header {
  background: var(--surface-header);
  border-block-end: 1px solid var(--border-default);
  padding: 1.1rem var(--panel-pad);
}
.page-header h1 { margin: 0; }

.content {
  padding: var(--panel-pad);
  display: grid;
  gap: 1rem;
  max-inline-size: 64rem;
  inline-size: 100%;
}

.panel {
  background: var(--surface-panel);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-panel);
  padding: var(--panel-pad);
}
.panel > :last-child { margin-block-end: 0; }
.prose > :not(figure, .table-wrap, pre, hr) { max-inline-size: 72ch; }

.table-wrap { overflow-x: auto; }
table {
  inline-size: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
th, td {
  text-align: start;
  vertical-align: top;
  padding: 0.55rem 0.6rem;
  border-block-end: 1px solid var(--border-subtle);
}
thead th {
  background: var(--surface-inset);
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 12.5px;
}
tbody tr:last-child td { border-block-end: 0; }

figure { margin-inline: 0; }
figure.diagram {
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-panel);
  padding: var(--panel-pad);
}
figure.diagram svg { inline-size: 100%; block-size: auto; }
figcaption { margin-block-start: 0.6rem; font-size: 13px; color: var(--text-muted); }
.diagram-inline svg { display: inline-block; block-size: 1.2em; inline-size: auto; vertical-align: middle; }
.missing { color: var(--color-error); font-weight: 600; }

/* SVG text and shapes take the tokens through these classes */
svg text { font-family: var(--font-sans); fill: var(--text-primary); }
svg .t-muted { fill: var(--text-muted); }
svg .t-sec { fill: var(--text-secondary); }
svg .t-primary { fill: var(--color-primary); }
svg .t-success { fill: var(--color-success); }
svg .t-warning { fill: var(--color-warning); }
svg .t-error { fill: var(--color-error); }
svg .box { fill: var(--surface-panel); stroke: var(--border-default); }
svg .box-inset { fill: var(--surface-inset); stroke: var(--border-default); }
svg .box-primary { fill: var(--tone-primary-surface); stroke: var(--tone-primary-border); }
svg .box-success { fill: var(--tone-success-surface); stroke: var(--tone-success-border); }
svg .box-warning { fill: var(--tone-warning-surface); stroke: var(--tone-warning-border); }
svg .box-error { fill: var(--tone-error-surface); stroke: var(--tone-error-border); }
svg .box-info { fill: var(--tone-info-surface); stroke: var(--tone-info-border); }
svg .line { stroke: var(--border-strong); fill: none; }
svg .line-primary { stroke: var(--color-primary); fill: none; }
svg .line-warning { stroke: var(--color-warning); fill: none; }
svg .line-error { stroke: var(--color-error); fill: none; }
svg .dot-primary { fill: var(--color-primary); }
svg .dot-warning { fill: var(--color-warning); }
svg .dot-muted { fill: var(--border-strong); }

.foot {
  margin-block-start: auto;
  padding: 1rem var(--panel-pad);
  font-size: 12.5px;
  color: var(--text-muted);
  border-block-start: 1px solid var(--border-subtle);
}

/* Page-to-page links at the foot of each page */
.next {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.75rem;
}
.next a {
  display: inline-block;
  padding: 0.5rem 0.9rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  text-decoration: none;
  font-weight: 600;
  font-size: 14px;
  background: var(--surface-panel);
}
@media (hover: hover) and (pointer: fine) {
  .next a:hover { background: var(--surface-hover); }
}
.next a.go { margin-inline-start: auto; }

@media print {
  .rail { display: none; }
}
`
}

// --------------------------------------------------------------------- Site

/**
 * Every output file of the site: `{ files: Map<name, string>, warnings }`.
 *
 * `inputs`: `{ pages: [{ file, source }], diagrams: Map<'diagrams/x.svg', string>, tokensCss,
 * indexCss, brandCss?, logo, appName }`.
 */
export function planSite(inputs) {
  const warnings = []
  const ordered = orderPages(inputs.pages.map(p => p.file))
  const sources = new Map(inputs.pages.map(p => [p.file, p.source]))
  const names = pageNames(ordered)
  const tokens = siteTokens(inputs)
  if (tokens.brand) {
    for (const p of tokens.brand.problems) warnings.push(`brand.css: ${p}`)
    for (const u of tokens.brand.unknown)
      warnings.push(`brand.css: ${u} is not defined by the app's tokens; ignored`)
  }

  const rendered = ordered.map(file => {
    let diagramCount = 0
    const hooks = {
      link: dest => resolveLink(dest, names),
      image: (src, alt, title, standalone) => {
        const rel = src.trim().replace(/^\.\//, '')
        if (/^diagrams\/(?:[\w-]+\/)*[\w.-]+\.svg$/i.test(rel) && !rel.includes('..')) {
          const svgSource = inputs.diagrams.get(rel)
          const stem = rel.replace(/^diagrams\//, '').replace(/\.svg$/i, '')
          diagramCount++
          const svg =
            svgSource === undefined
              ? null
              : sanitizeSvg(svgSource, {
                  idPrefix: `${stem.replace(/[^\w-]/g, '-')}-${diagramCount}-`,
                  label: alt,
                })
          if (!svg) {
            warnings.push(
              `${file}: ${rel} is ${svgSource === undefined ? 'missing' : 'not an SVG'}`
            )
            return `<span class="missing">Missing diagram: ${escapeHtml(rel)}</span>`
          }
          if (!standalone) return `<span class="diagram-inline">${svg}</span>`
          const caption = title ? `\n<figcaption>${escapeHtml(title)}</figcaption>` : ''
          return `<figure class="diagram">\n${svg}${caption}\n</figure>`
        }
        const href = resolveLink(src, names)
        if (href === null || /^mailto:/i.test(href) || /^http:/i.test(href)) return null
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`
      },
    }
    const { blocks } = renderMarkdown(sources.get(file), hooks)
    const h1 = blocks.findIndex(b => typeof b === 'object' && b.level === 1)
    const title = h1 === -1 ? titleFromFile(file) : blocks[h1].text.replace(/[*_`]/g, '')
    const body = h1 === -1 ? blocks : blocks.filter((_, i) => i !== h1)
    return { file, title, body }
  })

  const appName = inputs.appName || 'Rocketflare'
  const fontHref = googleFontsHref([
    webFont(tokens.fonts['--font-sans']),
    webFont(tokens.fonts['--font-mono']),
  ])
  const files = new Map()
  rendered.forEach((page, i) => {
    files.set(
      names.get(page.file),
      pageHtml({
        page,
        pages: rendered.map(p => ({ href: names.get(p.file), title: p.title })),
        index: i,
        appName,
        fontHref,
      })
    )
  })
  files.set('styles.css', stylesheet(tokens))
  files.set('logo.svg', inputs.logo)
  return { files, warnings, contrastTokens: tokens.themes }
}

/** Panels: whatever comes before the first `##`, then one per `##` section. */
function sections(body) {
  const groups = []
  let current = []
  for (const block of body) {
    if (typeof block === 'object' && block.level === 2 && current.length) {
      groups.push(current)
      current = []
    }
    current.push(block)
  }
  if (current.length) groups.push(current)
  return groups
    .map(group => {
      const head = typeof group[0] === 'object' && group[0].level === 2 ? group[0] : null
      const label = head ? ` aria-labelledby="${head.id}"` : ''
      return `<section class="panel prose"${label}>\n${group.map(String).join('\n')}\n</section>`
    })
    .join('\n')
}

function pageHtml({ page, pages, index, appName, fontHref }) {
  const title = escapeHtml(page.title)
  const app = escapeHtml(appName)
  const prev = pages[index - 1]
  const next = pages[index + 1]
  const nav = pages
    .map(
      (p, i) =>
        `          <li><a href="${escapeHtml(p.href)}"${i === index ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`
    )
    .join('\n')
  const fonts = fontHref
    ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${escapeHtml(fontHref)}">\n`
    : ''
  const nextLinks =
    prev || next
      ? `<nav class="next" aria-label="Previous and next page">${prev ? `<a href="${escapeHtml(prev.href)}">← ${escapeHtml(prev.title)}</a>` : ''}${next ? `<a class="go" href="${escapeHtml(next.href)}">${escapeHtml(next.title)} →</a>` : ''}</nav>\n`
      : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${GENERATOR_META}
<title>${title} · ${app} design</title>
<link rel="icon" href="logo.svg" type="image/svg+xml">
${fonts}<link rel="stylesheet" href="styles.css">
</head>
<body>
<div class="shell">
  <aside class="rail">
    <div class="rail-inner">
      <a class="brand" href="index.html"><img src="logo.svg" alt="" width="30" height="30"><span>${app}<small>Design</small></span></a>
      <nav aria-label="Design pages">
        <ul>
${nav}
        </ul>
      </nav>
    </div>
  </aside>
  <div class="main">
    <header class="page-header">
      <h1>${title}</h1>
    </header>
    <main class="content">
${sections(page.body)}
${nextLinks}    </main>
    <footer class="foot">Generated from <code>docs/design/</code> by <code>pnpm design:site</code>. Edit the markdown, then run it again.</footer>
  </div>
</div>
</body>
</html>
`
}

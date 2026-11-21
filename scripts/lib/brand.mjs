/**
 * A brand being tried: `docs/design/brand.css`, layered over the two files the app's palette
 * lives in. `apps/web/src/shared/theme-tokens.css` holds the DaisyUI palette (and `@theme` fonts);
 * `apps/web/src/ui/index.css` holds the derived tones (surfaces, text, `--focus-ring`,
 * `--tone-*-surface/-border`) in its `[data-theme="…"]` blocks; `apps/web/src/ui/index.html`
 * carries the primary again in `<meta name="theme-color">`.
 *
 * brand.css uses the same block shapes — an optional `@theme { --font-sans: … }`, and
 * `@plugin "daisyui/theme" { name: "…-light"; … }` / `[data-theme="…-dark"] { … }` blocks
 * (either shape, for either file's properties) — and holds only the properties it changes. A
 * block is matched by its theme name's `-light` / `-dark` suffix, so a renamed app still matches.
 *
 * `applyBrand` writes each property into whichever block DEFINES it, per theme, in place: the
 * same function previews the brand (the design pages and `--contrast` read its result in memory)
 * and adopts it (`design-docs.mjs --apply-brand` writes the result to disk), so what was checked
 * is what lands. Pure: text in, text out.
 */
import { declarations, themeKind } from './contrast.mjs'

/** The DaisyUI colours whose derived tones a brand must move with them. */
const DERIVED = {
  '--color-primary': [
    '--focus-ring',
    '--surface-active',
    '--tone-primary-surface',
    '--tone-primary-border',
  ],
  '--color-info': ['--tone-info-surface', '--tone-info-border'],
  '--color-success': ['--tone-success-surface', '--tone-success-border'],
  '--color-warning': ['--tone-warning-surface', '--tone-warning-border'],
  '--color-error': ['--tone-error-surface', '--tone-error-border'],
}

/** `[start, end)` of every comment in a CSS text. */
function commentRanges(css) {
  return [...css.matchAll(/\/\*[\s\S]*?\*\//g)].map(m => [m.index, m.index + m[0].length])
}
const inside = (ranges, i) => ranges.some(([a, b]) => i >= a && i < b)

/**
 * The token blocks of a CSS text: `{ kind: 'theme'|'light'|'dark', name, start, end }`, where
 * `[start, end)` is the body between the braces. Matches inside comments are skipped.
 */
export function tokenBlocks(css) {
  const ranges = commentRanges(css)
  const out = []
  const re = /@theme\s*\{|@plugin\s+"daisyui\/theme"\s*\{|\[data-theme="([\w-]+)"\]\s*\{/g
  for (const m of css.matchAll(re)) {
    if (inside(ranges, m.index)) continue
    const start = m.index + m[0].length
    const end = css.indexOf('}', start)
    if (end === -1) continue
    const body = css.slice(start, end)
    let kind
    let name = null
    if (m[0].startsWith('@theme')) kind = 'theme'
    else {
      name = m[1] ?? /name:\s*"([\w-]+)"/.exec(body.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? null
      kind = themeKind(name)
    }
    if (kind) out.push({ kind, name, start, end })
  }
  return out
}

/** A value a brand may set: a colour or a font stack, never a URL, an import or a block. */
function unsafeValue(value) {
  if (/[{}<>;\\]/.test(value)) return 'contains one of { } < > ; \\'
  if (/url\s*\(|@import|expression\s*\(|javascript:/i.test(value))
    return 'loads something (url(), @import, expression)'
  return null
}

/**
 * The overrides in a brand.css: `{ theme, light, dark }` maps of property → value, plus the
 * problems found (a block for no known theme, an unsafe value).
 */
export function parseBrand(brandCss) {
  const css = String(brandCss ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
  const overrides = { theme: {}, light: {}, dark: {} }
  const problems = []
  for (const block of tokenBlocks(css)) {
    for (const [prop, value] of Object.entries(declarations(css.slice(block.start, block.end)))) {
      const bad = unsafeValue(value)
      if (bad) problems.push(`${block.kind} ${prop}: ${bad}; ignored`)
      else overrides[block.kind][prop] = value
    }
  }
  const named = /@plugin\s+"daisyui\/theme"\s*\{|\[data-theme=/g
  const found = (css.match(named) ?? []).length
  const matched = tokenBlocks(css).filter(b => b.kind !== 'theme').length
  if (found > matched)
    problems.push('a theme block whose name ends in neither -light nor -dark was ignored')
  return { overrides, problems }
}

/**
 * `body` with `prop`'s declaration set to `value`, or null when the body does not declare it. A
 * comment on the rest of the replaced line goes too: it described the old value.
 */
export function setDeclaration(body, prop, value) {
  const ranges = commentRanges(body)
  const re = new RegExp(`(^|[\\s;{])(${prop.replace(/[-]/g, '\\-')})\\s*:`, 'g')
  for (const m of body.matchAll(re)) {
    const start = m.index + m[1].length
    if (inside(ranges, start)) continue
    const semi = body.indexOf(';', start)
    if (semi === -1) return null
    let after = semi + 1
    const trailing = /^[ \t]*\/\*[^\n]*?\*\/[ \t]*(?=\n|$)/.exec(body.slice(after))
    if (trailing) after += trailing[0].length
    return `${body.slice(0, start)}${prop}: ${value};${body.slice(after)}`
  }
  return null
}

/** Sets `prop` in every block of `kind` in `css` that declares it: `{ css, hits }`. */
function setInBlocks(css, kind, prop, value) {
  let out = css
  let hits = 0
  // Right to left, so an edit never moves a block still to be edited.
  for (const block of tokenBlocks(out)
    .filter(b => b.kind === kind)
    .reverse()) {
    const body = setDeclaration(out.slice(block.start, block.end), prop, value)
    if (body === null) continue
    out = out.slice(0, block.start) + body + out.slice(block.end)
    hits++
  }
  return { css: out, hits }
}

/** Every token of `kind` the CSS declares, merged in source order. */
function declared(css, kind) {
  const clean = css
  const out = {}
  for (const b of tokenBlocks(clean).filter(x => x.kind === kind))
    Object.assign(out, declarations(clean.slice(b.start, b.end).replace(/\/\*[\s\S]*?\*\//g, '')))
  return out
}

/**
 * The brand applied to the app's files: `{ tokensCss, indexCss, indexHtml, applied, unknown,
 * warnings, problems }`. `files` is `{ tokensCss, indexCss, indexHtml? }` as read from disk.
 * `applied` lists `{ kind, prop, value, files }`; `unknown` names a property neither file
 * defines for that theme (a typo, most often — nothing is invented); `warnings` names a derived
 * tone left at the kit's value beside a colour the brand changed, the half-applied brand.
 */
export function applyBrand(files, brandCss) {
  const { overrides, problems } = parseBrand(brandCss)
  let { tokensCss, indexCss } = files
  let indexHtml = files.indexHtml ?? null
  const applied = []
  const unknown = []
  for (const kind of ['theme', 'light', 'dark']) {
    for (const [prop, value] of Object.entries(overrides[kind])) {
      const t = setInBlocks(tokensCss, kind, prop, value)
      const x = setInBlocks(indexCss, kind, prop, value)
      tokensCss = t.css
      indexCss = x.css
      const where = [t.hits && 'theme-tokens.css', x.hits && 'index.css'].filter(Boolean)
      if (where.length) applied.push({ kind, prop, value, files: where })
      else unknown.push(`${kind === 'theme' ? '@theme' : kind} ${prop}`)
    }
  }
  const warnings = []
  for (const kind of ['light', 'dark']) {
    const before = { ...declared(files.tokensCss, kind), ...declared(files.indexCss, kind) }
    for (const [colour, derived] of Object.entries(DERIVED)) {
      if (!(colour in overrides[kind]) || overrides[kind][colour] === before[colour]) continue
      for (const tone of derived) {
        if (tone in overrides[kind] || before[tone] === undefined) continue
        warnings.push(
          `${kind} ${tone} is still the kit's ${before[tone]} although ${colour} changed to ` +
            `${overrides[kind][colour]}: set ${tone} for ${kind} in brand.css`
        )
      }
    }
  }
  const primary = overrides.light['--color-primary']
  if (indexHtml !== null && primary)
    indexHtml = indexHtml.replace(
      /(<meta name="theme-color" content=")[^"]*(")/,
      (_, a, b) => `${a}${primary.replace(/"/g, "'")}${b}`
    )
  return { tokensCss, indexCss, indexHtml, applied, unknown, warnings, problems }
}

/** The `@theme` declarations (fonts) of a CSS text. */
export function themeDeclarations(css) {
  return declared(css, 'theme')
}

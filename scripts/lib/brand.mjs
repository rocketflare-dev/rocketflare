/**
 * A brand being tried: `docs/design/brand.css`, layered over the two files the app's palette
 * lives in. `apps/web/src/shared/theme-tokens.css` holds the DaisyUI palette (and `@theme` fonts);
 * `apps/web/src/ui/index.css` holds the derived tones (surfaces, text, `--focus-ring`,
 * `--tone-*-surface/-border`) in its `[data-theme="…"]` blocks; `apps/web/src/ui/index.html`
 * carries the primary again in `<meta name="theme-color">`.
 *
 * A brand may set any token either file defines: colours, the rail (`--rail-*`), the chart series
 * (`--series-1…5`), depth (`--shadow-panel` / `--shadow-popover`), and in `@theme` the fonts
 * (`--font-sans` / `--font-mono`) and the radii (`--radius-control` / `-panel` / `-popover`).
 * `@theme { --brand-hue: <degrees or a colour>; }` turns the whole palette to one hue first,
 * keeping every lightness and chroma (`applyHue`, also the rename's `--colour`); the flare and
 * the state colours keep their own hue.
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
import {
  checkPair,
  checkTheme,
  declarations,
  parseColour,
  rgbToOklch,
  themeKind,
} from './contrast.mjs'

/** The DaisyUI colours whose derived tones a brand must move with them. */
const DERIVED = {
  '--color-primary': [
    '--focus-ring',
    '--surface-active',
    '--tone-primary-surface',
    '--tone-primary-border',
    '--rail-active',
    '--rail-focus-ring',
    '--selection-surface',
  ],
  '--color-info': ['--tone-info-surface', '--tone-info-border'],
  '--color-success': ['--tone-success-surface', '--tone-success-border'],
  '--color-warning': ['--tone-warning-surface', '--tone-warning-border'],
  '--color-error': ['--tone-error-surface', '--tone-error-border'],
}

// --------------------------------------------------------------------- Hue

/**
 * Tokens whose hue is their own under any brand: the flare (the logo's gold). State colours (info, success,
 * warning, error and their tones) are hex literals, so a hue rotation never reaches them.
 */
export const FIXED_HUE_TOKENS = ['--flare']

/** The brand.css `@theme` property that turns the whole palette to one hue (degrees or a colour). */
export const BRAND_HUE = '--brand-hue'

/** A numeric `oklch(L C H)` / `oklch(L C H / a)` literal; group 3 is the hue. */
const OKLCH_RE = /oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?(\s*\/\s*[\d.]+%?)?\s*\)/gi

/** The property a value at `index` belongs to (`--name`), or null outside a declaration. */
function propertyAt(css, index) {
  const start = Math.max(css.lastIndexOf(';', index), css.lastIndexOf('{', index)) + 1
  const names = [...css.slice(start, index).matchAll(/(--[\w-]+)\s*:/g)]
  return names.at(-1)?.[1] ?? null
}

const round = (n, places) => Number(n.toFixed(places)).toString()
const normaliseHue = h => Number((((h % 360) + 360) % 360).toFixed(2))

/**
 * The brand hue of the token files: the hue most of their `oklch()` literals sit on (the
 * neutrals, the primary, the rail and the selection all share it), or null when there are none.
 * Read from the text, never assumed, so a copy already moved off the kit's 35 still works.
 */
export function brandHue(css) {
  const ranges = commentRanges(css)
  const counts = new Map()
  for (const m of css.matchAll(OKLCH_RE)) {
    if (inside(ranges, m.index)) continue
    if (FIXED_HUE_TOKENS.includes(propertyAt(css, m.index))) continue
    const h = round(normaliseHue(Number.parseFloat(m[3])), 2)
    counts.set(h, (counts.get(h) ?? 0) + 1)
  }
  let best = null
  for (const [h, n] of counts) if (best === null || n > counts.get(best)) best = h
  return best === null ? null : Number(best)
}

/**
 * Every `oklch()` literal in `css` turned by `delta` degrees, keeping its lightness and chroma —
 * the lightness steps are what hold the contrast floors, so a rotation keeps them (WCAG luminance
 * moves a little with hue at the same lightness: the contrast gate is still the check). Literals
 * in comments and in a `FIXED_HUE_TOKENS` declaration are left alone; hex literals (the state
 * colours) are never touched. `{ css, rotated }`.
 */
export function rotateHue(css, delta) {
  const ranges = commentRanges(css)
  let rotated = 0
  const out = css.replace(OKLCH_RE, (whole, l, c, h, alpha, index) => {
    if (inside(ranges, index)) return whole
    if (FIXED_HUE_TOKENS.includes(propertyAt(css, index))) return whole
    rotated++
    const turned = round(normaliseHue(Number.parseFloat(h) + delta), 2)
    return `oklch(${l} ${c} ${turned}${alpha ?? ''})`
  })
  return { css: out, rotated }
}

/**
 * The hue of a colour given as `#hex`, `rgb()`, `oklch()` or a bare number of degrees, or an error
 * string: a grey has no hue to take.
 */
export function hueOf(colour) {
  const v = String(colour ?? '').trim()
  if (/^\d+(?:\.\d+)?$/.test(v)) {
    const n = Number(v)
    return n >= 0 && n <= 360 ? { hue: normaliseHue(n) } : { error: `hue ${v} is not 0–360` }
  }
  const rgb = parseColour(v)
  if (!rgb) return { error: `'${v}' is not a colour (a #hex, rgb(), oklch() or a hue in degrees)` }
  const [, chroma, hue] = rgbToOklch(rgb)
  if (chroma < 0.02) return { error: `'${v}' is a grey: it has no hue to take` }
  return { hue: Number(round(hue, 2)) }
}

/** `#rrggbb` for a colour this module reads, or null. */
export function hexOf(value) {
  const rgb = parseColour(value)
  return rgb ? `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}` : null
}

/** The light theme's `--color-primary` value in a CSS text, or null. */
function lightPrimary(css) {
  for (const b of tokenBlocks(css).filter(x => x.kind === 'light')) {
    const v = declarations(css.slice(b.start, b.end).replace(/\/\*[\s\S]*?\*\//g, ''))[
      '--color-primary'
    ]
    if (v) return v
  }
  return null
}

/** `index.html` with `<meta name="theme-color">` set to `colour`. */
export function setThemeColor(html, colour) {
  return html.replace(
    /(<meta name="theme-color" content=")[^"]*(")/,
    (_, a, b) => `${a}${colour.replace(/"/g, "'")}${b}`
  )
}

/**
 * The palette turned to `hue` (degrees): both token files rotated by the same amount from the
 * hue they are on now, and `<meta name="theme-color">` set to the new light primary as hex.
 * The one implementation behind the rename's `--colour` and brand.css `--brand-hue`.
 * `{ tokensCss, indexCss, indexHtml, from, to, rotated, primary }`.
 */
export function applyHue({ tokensCss, indexCss, indexHtml = null }, hue) {
  const from = brandHue(`${tokensCss}\n${indexCss}`)
  if (from === null) throw new Error('the token files have no oklch() colours to turn')
  const delta = normaliseHue(hue) - from
  const t = rotateHue(tokensCss, delta)
  const x = rotateHue(indexCss, delta)
  const primaryValue = lightPrimary(t.css)
  const primary = primaryValue ? hexOf(primaryValue) : null
  return {
    tokensCss: t.css,
    indexCss: x.css,
    indexHtml: indexHtml !== null && primary ? setThemeColor(indexHtml, primary) : indexHtml,
    from,
    to: normaliseHue(hue),
    rotated: t.rotated + x.rotated,
    primary,
  }
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
  // `--brand-hue` is not a token: it turns the whole palette first (as the rename's `--colour`
  // does), and every property the brand names explicitly then lands on top of the turned files.
  let hue = null
  if (BRAND_HUE in overrides.theme) {
    const value = overrides.theme[BRAND_HUE]
    delete overrides.theme[BRAND_HUE]
    const h = hueOf(value)
    if (h.error) problems.push(`@theme ${BRAND_HUE}: ${h.error}; ignored`)
    else {
      const r = applyHue({ tokensCss, indexCss, indexHtml }, h.hue)
      ;({ tokensCss, indexCss, indexHtml } = r)
      hue = { from: r.from, to: r.to, rotated: r.rotated }
      applied.push({
        kind: 'theme',
        prop: BRAND_HUE,
        value,
        files: ['theme-tokens.css', 'index.css'],
      })
    }
  }
  const base = { tokensCss, indexCss }
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
    const before = { ...declared(base.tokensCss, kind), ...declared(base.indexCss, kind) }
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
  if (indexHtml !== null && primary) indexHtml = setThemeColor(indexHtml, primary)
  return { tokensCss, indexCss, indexHtml, applied, unknown, warnings, problems, hue }
}

/** The `@theme` declarations (fonts) of a CSS text. */
export function themeDeclarations(css) {
  return declared(css, 'theme')
}

// ------------------------------------------------------------ The default look

const withoutComments = t => t.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * The token blocks of `into`, each body replaced by the matching block of `look` (`@theme`,
 * light, dark) with the declarations `mine` has and `look` lacks appended — a token of the app's
 * own survives. `into` and `mine` are both the app's file (index.css), or `into` IS `look`
 * (theme-tokens.css, taken whole). A kind `look` has and `into` lacks lands in `missing`.
 */
function lookBlocks({ into, look, mine, kept, missing, file }) {
  let out = into
  for (const kind of ['theme', 'light', 'dark']) {
    const fresh = tokenBlocks(look).find(b => b.kind === kind)
    if (!fresh) continue
    const target = tokenBlocks(out).find(b => b.kind === kind)
    const own = tokenBlocks(mine).find(b => b.kind === kind)
    const label = `${file} ${kind === 'theme' ? '@theme' : kind}`
    if (!target) {
      missing.push(`${label}: no such block to write`)
      continue
    }
    const body = look.slice(fresh.start, fresh.end)
    const theirs = declarations(withoutComments(body))
    const extra = own
      ? Object.entries(declarations(withoutComments(mine.slice(own.start, own.end)))).filter(
          ([prop]) => !(prop in theirs)
        )
      : []
    for (const [prop] of extra) kept.push(`${label} ${prop}`)
    const merged = extra.length
      ? `${body.replace(/\s*$/, '')}\n  /* Kept from this app: not a token of the default look. */\n${extra
          .map(([prop, value]) => `  ${prop}: ${value};`)
          .join('\n')}\n`
      : body
    out = out.slice(0, target.start) + merged + out.slice(target.end)
  }
  return out
}

const squash = t => withoutComments(t).replace(/\s+/g, ' ').trim()

/**
 * The top-level statements of a CSS text, in order: a rule or block at-rule (`a { … }`,
 * `@media … { … }`) as `{ prelude, start, end, open, body }`, or an at-statement (`@import …;`)
 * with `open: -1, body: null`. `[start, end)` is the whole statement, `open` the index of its `{`.
 * Nesting, comments and quoted strings are honoured, so a brace inside any of them ends nothing.
 */
export function topLevelRules(css) {
  const out = []
  let depth = 0
  let start = -1
  let open = -1
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2)
      i = (close === -1 ? css.length : close + 2) - 1
      continue
    }
    if (depth === 0 && start === -1) {
      if (/\s/.test(c)) continue
      start = i
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1
      i = j
    } else if (c === '{') {
      if (depth === 0) open = i
      depth++
    } else if (c === '}' && depth > 0) {
      depth--
      if (depth === 0) {
        const prelude = squash(css.slice(start, open))
        out.push({ prelude, start, end: i + 1, open, body: css.slice(open + 1, i) })
        start = -1
      }
    } else if (c === ';' && depth === 0) {
      out.push({ prelude: squash(css.slice(start, i)), start, end: i + 1, open: -1, body: null })
      start = -1
    }
  }
  return out
}

/** The top-level statements of `css` that are not one of its token blocks (`tokenBlocks`). */
function nonTokenRules(css) {
  const tokenStarts = new Set(tokenBlocks(css).map(b => b.start))
  return topLevelRules(css).filter(r => !tokenStarts.has(r.open + 1))
}

const nested = body => /[{}]/.test(withoutComments(body))

/**
 * The app's own top-level statements in `mine` carried into `into`, which was rebuilt from the
 * kit's file and so holds only the kit's. A statement `into` lacks is appended whole, after one
 * comment saying where it came from. A flat rule both have (`:root`, which holds the logo mark's
 * colours) keeps the app's value of each property and gains the app's extra ones: what sits
 * outside the token blocks is the app's brand, not the look. A nested one both have becomes the
 * app's. Each carried item lands in `carried` as `<file> <prelude>` or `<file> <prelude> <prop>`.
 */
function carryRules({ into, mine, carried, file }) {
  let out = into
  const appended = []
  for (const own of nonTokenRules(mine)) {
    const text = mine.slice(own.start, own.end)
    const theirs = nonTokenRules(out).find(r => r.prelude === own.prelude)
    if (!theirs) {
      appended.push(text)
      carried.push(`${file} ${own.prelude}`)
      continue
    }
    if (squash(out.slice(theirs.start, theirs.end)) === squash(text)) continue
    if (own.body === null || theirs.body === null || nested(own.body) || nested(theirs.body)) {
      out = out.slice(0, theirs.start) + text + out.slice(theirs.end)
      carried.push(`${file} ${own.prelude}`)
      continue
    }
    const kitDecls = declarations(withoutComments(theirs.body))
    let body = theirs.body
    const extra = []
    for (const [prop, value] of Object.entries(declarations(withoutComments(own.body)))) {
      if (!(prop in kitDecls)) extra.push([prop, value])
      else if (kitDecls[prop] !== value) body = setDeclaration(body, prop, value) ?? body
      else continue
      carried.push(`${file} ${own.prelude} ${prop}`)
    }
    if (extra.length)
      body = `${body.replace(/\s*$/, '')}\n${extra.map(([p, v]) => `  ${p}: ${v};`).join('\n')}\n`
    out = out.slice(0, theirs.open + 1) + body + out.slice(theirs.end - 1)
  }
  if (appended.length)
    out = `${out.replace(/\s*$/, '')}\n\n/* Kept from this app: its own rules, carried over by \`pnpm design:docs --adopt-default-look\`. */\n${appended.join('\n\n')}\n`
  return out
}

/**
 * The kit's default look adopted by an app, with the app's own brand re-applied on top:
 * `pnpm design:docs --adopt-default-look`. `current` is the app's three files as they are,
 * `defaults` the same three from the kit release being adopted, already in the app's names.
 *
 * - `theme-tokens.css` becomes the default file, keeping any token declaration of the app's own
 *   the defaults lack, in its block, and every statement of the app's outside the token blocks
 *   (a `[data-brand-logo]` rule, its `:root` logo colours) through `carryRules`.
 * - `index.css` keeps everything but its token blocks, which become the defaults' (keeping the
 *   app's extra declarations the same way): the rest of that file is styles, which the upgrade's
 *   own patch ports.
 * - `<meta name="theme-color">` in `index.html` becomes the default's.
 * - Then `brandCss` (the app's `docs/design/brand.css`), when there is one, through `applyBrand`,
 *   so a brand of a hue, fonts and a radius lands whole on the new look.
 *
 * Pure. `{ tokensCss, indexCss, indexHtml, kept, carried, missing, brand }`.
 */
export function adoptDefaultLook({ current, defaults, brandCss = null }) {
  const kept = []
  const missing = []
  const carried = []
  const tokensCss = carryRules({
    into: lookBlocks({
      into: defaults.tokensCss,
      look: defaults.tokensCss,
      mine: current.tokensCss,
      kept,
      missing,
      file: 'theme-tokens.css',
    }),
    mine: current.tokensCss,
    carried,
    file: 'theme-tokens.css',
  })
  const indexCss = lookBlocks({
    into: current.indexCss,
    look: defaults.indexCss,
    mine: current.indexCss,
    kept,
    missing,
    file: 'index.css',
  })
  const color = /<meta name="theme-color" content="([^"]*)"/.exec(defaults.indexHtml ?? '')?.[1]
  let indexHtml = current.indexHtml ?? null
  if (indexHtml !== null && color) indexHtml = setThemeColor(indexHtml, color)
  const brand = brandCss ? applyBrand({ tokensCss, indexCss, indexHtml }, brandCss) : null
  return {
    tokensCss: brand?.tokensCss ?? tokensCss,
    indexCss: brand?.indexCss ?? indexCss,
    indexHtml: brand ? brand.indexHtml : indexHtml,
    kept,
    carried,
    missing,
    brand,
  }
}

// --------------------------------------------------- Keeping the app's own look

/** State colours and their tones keep their own hue: never an anchor for a brand token. */
const STATE_TOKEN = /^--(?:color|tone)-(?:info|success|warning|error)(?:-|$)/

const OKLCH_ONE = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*\)$/i

/** `[L, C, H]` of a colour value: read exactly from an `oklch()` literal, else through sRGB. */
function lchOf(value) {
  const m = OKLCH_ONE.exec(String(value).trim())
  if (m) {
    const n = (s, of) => (s.endsWith('%') ? (Number.parseFloat(s) / 100) * of : Number(s))
    return [n(m[1], 1), n(m[2], 0.4), Number(m[3])]
  }
  const rgb = parseColour(value)
  return rgb ? rgbToOklch(rgb) : null
}

const clamp01 = n => Math.min(1, Math.max(0, n))
const lchText = ([l, c, h]) =>
  `oklch(${round(clamp01(l), 3)} ${round(Math.max(0, c), 3)} ${round(normaliseHue(h), 2)})`

/** Distance of two `[L, C, H]` colours in OKLab, so a grey's hue counts for nothing. */
function labDistance([l1, c1, h1], [l2, c2, h2]) {
  const r = Math.PI / 180
  const da = c1 * Math.cos(h1 * r) - c2 * Math.cos(h2 * r)
  const db = c1 * Math.sin(h1 * r) - c2 * Math.sin(h2 * r)
  return Math.sqrt((l1 - l2) ** 2 + da ** 2 + db ** 2)
}

/** A length in px for `8px` / `0.5rem`, else null. */
function px(value) {
  const m = /^([\d.]+)(px|rem)$/.exec(String(value).trim())
  if (!m) return null
  return Number(m[1]) * (m[2] === 'rem' ? 16 : 1)
}

const sameValue = (a, b) => a === b || (px(a) !== null && px(a) === px(b))

/** The declarations of one kind across both token files, merged. */
const declaredIn = (files, kind) => ({
  ...declared(files.tokensCss, kind),
  ...declared(files.indexCss, kind),
})

/**
 * One missing token's value in the app's palette. `kit` and `app` are the token maps of every
 * kind (`{ theme, light, dark }`), `delta` the turn from the kit's brand hue to the app's.
 *
 * - A value the kit holds EQUAL to a token the app has (`--rail-active` is the primary,
 *   `--radius-control` is `--radius-field`) takes the app's value verbatim.
 * - `--flare` keeps the kit's value: its hue is its own under any brand.
 * - A colour takes its nearest kit colour the app also has (never a state colour) as its anchor,
 *   and keeps the kit's offset from it in lightness, chroma and hue: the relation `applyHue`
 *   keeps when it turns the whole palette, read from the app's own colours instead.
 * - Anything else (a shadow, a mix) has its `oklch()` literals turned by `delta`.
 *
 * `{ value, from }`, `from` naming the anchor (or null).
 */
function deriveToken(prop, kind, kitValue, { kit, app, delta }) {
  for (const k of [kind, 'light', 'dark', 'theme']) {
    for (const [p, v] of Object.entries(kit[k])) {
      if (p === prop || !(p in app[k]) || STATE_TOKEN.test(p)) continue
      if (sameValue(v, kitValue)) return { value: app[k][p], from: p }
    }
  }
  if (FIXED_HUE_TOKENS.includes(prop)) return { value: kitValue, from: null }
  const mine = kind === 'theme' || !parseColour(kitValue) ? null : lchOf(kitValue)
  if (mine) {
    let best = null
    for (const [p, v] of Object.entries(kit[kind])) {
      if (p === prop || !(p in app[kind]) || STATE_TOKEN.test(p)) continue
      if (FIXED_HUE_TOKENS.includes(p)) continue
      const theirs = lchOf(v)
      const ours = lchOf(app[kind][p])
      if (!theirs || !ours) continue
      const d = labDistance(mine, theirs)
      if (!best || d < best.d) best = { p, d, theirs, ours }
    }
    if (best) {
      const { theirs, ours } = best
      // A grey anchor has no hue to keep an offset from: the kit's own hue, turned.
      const hue =
        theirs[1] < 0.005 || ours[1] < 0.005 ? mine[2] + delta : ours[2] + (mine[2] - theirs[2])
      return {
        value: lchText([ours[0] + (mine[0] - theirs[0]), ours[1] + (mine[1] - theirs[1]), hue]),
        from: best.p,
      }
    }
  }
  const turned = rotateHue(`${prop}: ${kitValue};`, delta).css
  return { value: turned.slice(prop.length + 2, -1), from: null }
}

/** `value` with its OKLCH lightness set to `l`, keeping its chroma and hue. */
function withLightness(value, l) {
  const [, c, h] = lchOf(value)
  return lchText([l, c, h])
}

/**
 * Nudges the lightness of the tokens in `added` (`prop → value`, one theme) until every contrast
 * pair involving one passes over `tokens` (the app's own) with them. The added side of a failing
 * pair moves away from the other side: the foreground first and, when it runs out of room, the
 * background instead. Mutates `added`; `{ moved, failing }`.
 */
function holdFloors(tokens, added) {
  const moved = new Set()
  const all = () => ({ ...tokens, ...added })
  const failingPairs = () =>
    checkTheme(all()).pairs.filter(p => !p.ok && !p.problem && (p.fg in added || p.bg in added))
  for (let pass = 0; pass < 40; pass++) {
    const failing = failingPairs()
    if (!failing.length) break
    for (const p of failing) {
      if (checkPair(all(), p.fg, p.bg, p.floor).ok) continue
      for (const t of [p.fg, p.bg].filter(x => x in added)) {
        const other = t === p.fg ? p.bg : p.fg
        const start = added[t]
        const l = lchOf(start)[0]
        const step = l >= (lchOf(all()[other])?.[0] ?? 0.5) ? 0.005 : -0.005
        let fixed = false
        for (let next = l + step; next > 0 && next < 1; next += step) {
          added[t] = withLightness(start, next)
          if (checkPair(all(), p.fg, p.bg, p.floor).ok) {
            fixed = true
            break
          }
        }
        if (fixed) {
          moved.add(t)
          break
        }
        added[t] = start
      }
    }
  }
  return { moved: [...moved], failing: failingPairs() }
}

/** A `--font-*` value naming a family of its own (not `var(--font-sans)`). */
const namesAFace = value => !/^var\(/.test(value.trim())

/**
 * Every token the kit's default look defines and the app's files lack, written into the app's own
 * blocks with values derived from the app's own palette: `pnpm design:docs --add-missing-tokens`,
 * for a copy keeping its look across a release that added tokens. `current` is the app's two
 * files, `defaults` the kit release's, already in the app's names.
 *
 * A token the app declares is never changed. Each added colour is derived from the app's palette
 * (`deriveToken`), then its lightness is nudged until every contrast pair it takes part in passes
 * (`holdFloors`). A missing `--font-*` naming a face is left out: the kit's face is part of the
 * new look, and the app's stays as it renders today.
 *
 * Pure. `{ tokensCss, indexCss, added: [{ file, kind, prop, value, from, adjusted }], skipped,
 * missing, failing }`. A non-empty `failing` (a pair no nudge could fix) means: write nothing.
 */
export function addMissingTokens({ current, defaults }) {
  const kinds = ['theme', 'light', 'dark']
  const kit = Object.fromEntries(kinds.map(k => [k, declaredIn(defaults, k)]))
  const app = Object.fromEntries(kinds.map(k => [k, declaredIn(current, k)]))
  const kitHue = brandHue(`${defaults.tokensCss}\n${defaults.indexCss}`) ?? 0
  const primary = hueOf(app.light['--color-primary'] ?? '')
  const appHue = brandHue(`${current.tokensCss}\n${current.indexCss}`) ?? primary.hue ?? kitHue
  const delta = appHue - kitHue
  const plan = []
  const skipped = []
  for (const kind of kinds)
    for (const [key, file] of [
      ['tokensCss', 'theme-tokens.css'],
      ['indexCss', 'index.css'],
    ])
      for (const [prop, kitValue] of Object.entries(declared(defaults[key], kind))) {
        if (prop in app[kind] || plan.some(x => x.kind === kind && x.prop === prop)) continue
        if (/^--font-/.test(prop) && namesAFace(kitValue)) {
          skipped.push(`${file} @theme ${prop}: the kit's face, part of its look; yours stays`)
          continue
        }
        plan.push({ key, file, kind, prop, kitValue })
      }
  for (const x of plan)
    Object.assign(x, deriveToken(x.prop, x.kind, x.kitValue, { kit, app, delta }))
  const failing = []
  const moved = new Set()
  for (const kind of ['light', 'dark']) {
    const added = Object.fromEntries(
      plan.filter(x => x.kind === kind && lchOf(x.value)).map(x => [x.prop, x.value])
    )
    const r = holdFloors(app[kind], added)
    for (const x of plan) if (x.kind === kind && x.prop in added) x.value = added[x.prop]
    for (const t of r.moved) moved.add(`${kind} ${t}`)
    for (const p of r.failing)
      failing.push(
        `${kind} ${p.fg} ${p.fgValue} on ${p.bg} ${p.bgValue}: ${p.ratio}:1, minimum ${p.floor}:1`
      )
  }
  const files = { tokensCss: current.tokensCss, indexCss: current.indexCss }
  const added = []
  const missing = []
  for (const key of ['tokensCss', 'indexCss'])
    for (const kind of kinds) {
      const mine = plan.filter(x => x.key === key && x.kind === kind)
      if (!mine.length) continue
      const target = tokenBlocks(files[key]).find(b => b.kind === kind)
      if (!target) {
        missing.push(
          `${mine[0].file} ${kind === 'theme' ? '@theme' : kind}: no such block to add ` +
            mine.map(x => x.prop).join(', ')
        )
        continue
      }
      const body = files[key].slice(target.start, target.end)
      const merged = `${body.replace(/\s*$/, '')}\n\n  /* Added by \`pnpm design:docs --add-missing-tokens\`: tokens of the kit's look, derived from this app's palette. */\n${mine
        .map(x => `  ${x.prop}: ${x.value};`)
        .join('\n')}\n`
      files[key] = files[key].slice(0, target.start) + merged + files[key].slice(target.end)
      for (const x of mine)
        added.push({
          file: x.file,
          kind,
          prop: x.prop,
          value: x.value,
          from: x.from,
          adjusted: moved.has(`${kind} ${x.prop}`),
        })
    }
  return { ...files, added, skipped, missing, failing }
}

// ------------------------------------------------------------------ Fonts

const SYSTEM_FACES =
  /^(?:ui-[\w-]+|system-ui|-apple-system|blinkmacsystemfont|segoe ui|roboto|helvetica(?: neue)?|arial|sans-serif|serif|monospace|cursive|sf mono|sf pro(?: text)?|menlo|monaco|consolas|liberation mono|courier(?: new)?|georgia|times(?: new roman)?|verdana|tahoma|trebuchet ms)$/i

/** The first family of a font stack when it is a face to load (not a system one), or null. */
function firstFamily(stack) {
  const first = String(stack ?? '')
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '')
  if (!first || /^var\(/.test(first) || SYSTEM_FACES.test(first)) return null
  return /^[A-Za-z0-9 ]{2,60}$/.test(first) ? first : null
}

/** The `@fontsource` package a family is published as: `IBM Plex Sans Variable` → `@fontsource-variable/ibm-plex-sans`. */
export function fontsourcePackage(family) {
  const variable = /\s+variable$/i.test(family)
  const slug = family
    .replace(/\s+variable$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `@fontsource${variable ? '-variable' : ''}/${slug}`
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

function dependencies(text) {
  try {
    const j = JSON.parse(text || '{}')
    return { ...j.devDependencies, ...j.dependencies }
  } catch {
    return {}
  }
}

/**
 * Whether each face the `@theme` block of `tokensCss` names is loaded: imported in `ui/main.tsx`
 * (or `@import`ed by `index.css`) and declared in `apps/web/package.json`, or loaded another way
 * (an `@font-face` of that family, a stylesheet link naming it in `index.html`). `kit` is the kit
 * release's `main.tsx` and `package.json` when known: they give the exact package and version of
 * the kit's own faces. `[{ family, tokens, pkg, version, imported, declared, loaded }]`.
 */
export function fontLoading({
  tokensCss,
  indexCss = '',
  mainTsx = '',
  packageJson = '',
  indexHtml = '',
  kit = {},
}) {
  const mine = dependencies(packageJson)
  const theirs = dependencies(kit.packageJson)
  const byFamily = new Map()
  for (const [prop, value] of Object.entries(themeDeclarations(tokensCss))) {
    if (!/^--font-/.test(prop)) continue
    const family = firstFamily(value)
    if (!family) continue
    byFamily.set(family, [...(byFamily.get(family) ?? []), prop])
  }
  return [...byFamily].map(([family, tokens]) => {
    const guess = fontsourcePackage(family)
    const slug = guess.split('/')[1]
    const fromKit = new RegExp(
      `['"](@fontsource(?:-variable)?/${escapeRe(slug)})(?:/[^'"]*)?['"]`
    ).exec(kit.mainTsx ?? '')
    const pkg = fromKit?.[1] ?? guess
    const imports = new RegExp(`['"]${escapeRe(pkg)}(?:/[^'"]*)?['"]`)
    const face = new RegExp(
      `@font-face\\s*\\{[^}]*font-family:\\s*["']?${escapeRe(family)}["']?\\s*[;}]`,
      'i'
    )
    const link = new RegExp(
      `family=${escapeRe(family.replace(/\s+variable$/i, '').replace(/ /g, '+'))}(?![\\w+])`,
      'i'
    )
    return {
      family,
      tokens,
      pkg,
      version: theirs[pkg] ?? null,
      imported: imports.test(mainTsx) || imports.test(indexCss),
      declared: pkg in mine,
      loaded: face.test(`${tokensCss}\n${indexCss}`) || link.test(indexHtml),
    }
  })
}

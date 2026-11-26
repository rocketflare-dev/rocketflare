/**
 * The kit's contrast floors (WCAG 2.x relative luminance), in ONE place: the UI gate
 * (`apps/web/tests/ui/contrast.test.ts`) asserts them over the tokens the app ships, and
 * `node scripts/design-docs.mjs --contrast` over the same tokens with `docs/design/brand.css`
 * layered on, so the brand step can nudge a palette until it passes before the app adopts it.
 *
 * The floors: text ≥ 4.5:1 on every surface it sits on, each DaisyUI colour ≥ 4.5:1 against its
 * `-content`, each semantic colour readable as text on the panel and on its own tone surface,
 * `--border-control` and `--focus-ring` ≥ 3:1, the shell's rail, series, selection and flare
 * (`SHELL_PAIRS`), and `--color-secondary` equal to `--text-secondary` (DaisyUI's
 * `text-secondary` utility must mean the token).
 *
 * Pure: it takes CSS text and returns data. A theme is found by its name's `-light` / `-dark`
 * suffix, so a renamed copy's `<slug>-light` matches without a code change.
 */

/** CSS without its comments. */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** `--name: value;` pairs of one block body, in source order. */
export function declarations(body) {
  const out = {}
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out[name] = value.trim()
  return out
}

/** `light` / `dark` for a theme name, by its suffix, else null. */
export function themeKind(name) {
  if (typeof name !== 'string') return null
  if (/-light$/.test(name)) return 'light'
  if (/-dark$/.test(name)) return 'dark'
  return null
}

/**
 * The tokens of each theme: every `@plugin "daisyui/theme"` block and every `[data-theme="…"]`
 * block, merged in source order (later wins) — which is the order the browser resolves them in,
 * since the app's `index.css` semantic blocks come after the DaisyUI theme it imports.
 */
export function themeTokens(css) {
  const clean = stripComments(css)
  const out = { light: { name: null, tokens: {} }, dark: { name: null, tokens: {} } }
  const blocks = [
    ...[...clean.matchAll(/@plugin\s+"daisyui\/theme"\s*\{([^}]*)\}/g)].map(m => ({
      index: m.index,
      name: /name:\s*"([\w-]+)"/.exec(m[1])?.[1],
      body: m[1],
    })),
    ...[...clean.matchAll(/\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g)].map(m => ({
      index: m.index,
      name: m[1],
      body: m[2],
    })),
  ].sort((a, b) => a.index - b.index)
  for (const block of blocks) {
    const kind = themeKind(block.name)
    if (!kind) continue
    out[kind].name ??= block.name
    Object.assign(out[kind].tokens, declarations(block.body))
  }
  return out
}

// ------------------------------------------------------------------ Colours

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

function hex(value) {
  const s = value.replace('#', '')
  const full = s.length === 3 ? [...s].map(c => c + c).join('') : s
  return [0, 2, 4].map(i => Number.parseInt(full.slice(i, i + 2), 16))
}

const toLinear = c => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const fromLinear = l => {
  const v = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055
  return clamp(Math.round(v * 255), 0, 255)
}

/** OKLCH (L 0–1, C, H degrees) → sRGB 0–255, clamped into gamut. */
function oklchToRgb(L, C, H) {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map(fromLinear)
}

/** sRGB 0–255 → OKLCH [L 0–1, C, H degrees]. */
export function rgbToOklch(rgb) {
  const [r, g, b] = rgb.map(toLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const C = Math.sqrt(A * A + B * B)
  let H = (Math.atan2(B, A) * 180) / Math.PI
  if (H < 0) H += 360
  return [L, C, C < 1e-4 ? 0 : H]
}

/** `oklch(L% C H)` text for an sRGB colour, rounded so the same input always prints the same. */
export function oklchText(rgb) {
  const [L, C, H] = rgbToOklch(rgb)
  const n = (v, d) => Number(v.toFixed(d)).toString()
  return `oklch(${n(L * 100, 2)}% ${n(C, 4)} ${n(H, 2)})`
}

const number = (s, percentOf = 1) =>
  s.endsWith('%') ? (Number.parseFloat(s) / 100) * percentOf : Number.parseFloat(s)

/**
 * sRGB 0–255 for a token value, or null when it is not a colour this module reads: `#rgb`,
 * `#rrggbb`, `rgb(r g b)` / `rgb(r, g, b)`, `oklch(L C H)` and `color-mix(in srgb|oklch, A p%, B)`.
 * The kit's own tokens are `oklch()` on the brand hue, hex for the state colours, and
 * `color-mix(in srgb, …)`.
 */
export function parseColour(value) {
  const v = String(value).trim()
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return hex(v)
  const rgb =
    /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)\s*(?:[/,]\s*[\d.]+%?\s*)?\)$/i.exec(v)
  if (rgb) return rgb.slice(1, 4).map(c => clamp(Math.round(number(c, 255)), 0, 255))
  const ok =
    /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/i.exec(v)
  if (ok) return oklchToRgb(number(ok[1]), number(ok[2], 0.4), Number.parseFloat(ok[3]))
  const mix = /^color-mix\(\s*in\s+(srgb|oklch)\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/i.exec(v)
  if (mix) {
    const a = parseColour(mix[2])
    const b = parseColour(mix[4])
    if (!a || !b) return null
    const p = Number(mix[3]) / 100
    if (mix[1].toLowerCase() === 'srgb') return a.map((c, i) => Math.round(c * p + b[i] * (1 - p)))
    const [la, ca, ha] = rgbToOklch(a)
    const [lb, cb, hb] = rgbToOklch(b)
    let dh = ha - hb
    if (dh > 180) dh -= 360
    if (dh < -180) dh += 360
    return oklchToRgb(la * p + lb * (1 - p), ca * p + cb * (1 - p), hb + dh * p)
  }
  return null
}

const luminance = rgb => {
  const [r, g, b] = rgb.map(c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio of two sRGB colours. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// -------------------------------------------------------------------- Pairs

const SEMANTIC = ['primary', 'accent', 'info', 'success', 'warning', 'error']
const FILLS = ['primary', 'secondary', 'accent', 'neutral', 'info', 'success', 'warning', 'error']
const TEXT = ['--text-primary', '--text-secondary', '--text-muted']
const TEXT_SURFACES = [
  '--surface-app',
  '--surface-panel',
  '--surface-inset',
  '--surface-raised',
  '--surface-nav',
  '--surface-hover',
]

/**
 * The tinted shell's pairs: rail text on the rail and on its hover and selected fills, the
 * rail's focus ring on the rail, each chart series as a graphic on the panel (3:1, WCAG 1.4.11),
 * ink on the text-selection and selected-row fills, the primary as text on a selected row, and
 * the flare on the rail-toned login panel it draws on; text, links and the selection on an
 * assistant chat turn (`--surface-bubble`), and the initials avatar's primary edge on the top bar.
 */
export const SHELL_PAIRS = [
  ['--rail-text', '--rail-surface', 4.5],
  ['--rail-text-muted', '--rail-surface', 4.5],
  ['--rail-text', '--rail-hover', 4.5],
  ['--rail-text-muted', '--rail-hover', 4.5],
  ['--rail-active-text', '--rail-active', 4.5],
  ['--rail-focus-ring', '--rail-surface', 3],
  ...[1, 2, 3, 4, 5].map(i => [`--series-${i}`, '--surface-panel', 3]),
  ['--text-primary', '--selection-surface', 4.5],
  ['--text-primary', '--surface-active', 4.5],
  ['--color-primary', '--surface-active', 4.5],
  ['--flare', '--rail-surface', 3],
  ...TEXT.map(t => [t, '--surface-bubble', 4.5]),
  ['--color-primary', '--surface-bubble', 4.5],
  ['--text-primary', '--selection-bubble', 4.5],
  ['--color-primary', '--surface-header', 3],
]

/** `[foreground, background, floor]` — the same list for both themes. */
export function contrastPairs() {
  return [
    ...TEXT.flatMap(t => TEXT_SURFACES.map(s => [t, s, 4.5])),
    ['--color-base-content', '--color-base-100', 4.5],
    ['--color-base-content', '--color-base-200', 4.5],
    ...FILLS.map(c => [`--color-${c}-content`, `--color-${c}`, 4.5]),
    ...SEMANTIC.map(c => [`--color-${c}`, '--surface-panel', 4.5]),
    ...SEMANTIC.filter(c => c !== 'accent').map(c => [`--color-${c}`, `--tone-${c}-surface`, 4.5]),
    ['--border-control', '--surface-panel', 3],
    ['--focus-ring', '--surface-panel', 3],
    ['--focus-ring', '--surface-app', 3],
    ...SHELL_PAIRS,
  ]
}

/** Tokens that must hold the same value: DaisyUI's `text-secondary` utility wins over the class. */
export const EQUAL_TOKENS = [['--color-secondary', '--text-secondary']]

/**
 * One pair's verdict. `ratio` is rounded to two places before it is compared, as the gate always
 * has; `problem` is set when a token is missing or is not a colour this module reads.
 */
export function checkPair(tokens, fg, bg, floor) {
  const result = { fg, bg, floor, fgValue: tokens[fg], bgValue: tokens[bg], ratio: null }
  for (const name of [fg, bg]) {
    if (tokens[name] === undefined)
      return { ...result, ok: false, problem: `${name} is not defined` }
    if (!parseColour(tokens[name]))
      return { ...result, ok: false, problem: `${name} is not a colour: ${tokens[name]}` }
  }
  const ratio = Number(contrastRatio(parseColour(tokens[fg]), parseColour(tokens[bg])).toFixed(2))
  return { ...result, ratio, ok: ratio >= floor }
}

/** Every pair and equality of one theme's tokens: `{ pairs, equal, failures }`. */
export function checkTheme(tokens) {
  const pairs = contrastPairs().map(([fg, bg, floor]) => checkPair(tokens, fg, bg, floor))
  const equal = EQUAL_TOKENS.map(([a, b]) => ({
    a,
    b,
    aValue: tokens[a],
    bValue: tokens[b],
    ok: tokens[a] !== undefined && tokens[a]?.toLowerCase() === tokens[b]?.toLowerCase(),
  }))
  return {
    pairs,
    equal,
    failures: pairs.filter(p => !p.ok).length + equal.filter(e => !e.ok).length,
  }
}

/**
 * The contrast floors `src/ui/index.css` promises in its header, asserted over the tokens it
 * actually emits (WCAG 2.x relative luminance): text ≥ 4.5:1 on every surface it sits on, each
 * DaisyUI colour ≥ 4.5:1 against its `-content`, each semantic colour readable as text on the
 * panel and on its own tone surface, `--border-control` and `--focus-ring` ≥ 3:1.
 *
 * Reads the CSS file, so a recolour (`/rf-adapt --colour`, or by hand) fails here naming the
 * token pair and the ratio. Pure parsing — the jsdom project only because it lives in tests/ui.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = ['../../src/shared/theme-tokens.css', '../../src/ui/index.css']
  .map(file => readFileSync(path.resolve(__dirname, file), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const THEMES = ['rocketflare-light', 'rocketflare-dark'] as const
type Theme = (typeof THEMES)[number]

function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out[name] = value.trim()
  return out
}

/** The DaisyUI theme block and the `[data-theme=…]` semantic block, merged. */
function tokens(theme: Theme): Record<string, string> {
  const blocks = [
    ...css.matchAll(/@plugin\s+"daisyui\/theme"\s*\{([^}]*)\}/g),
    ...css.matchAll(/\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g),
  ]
  const merged: Record<string, string> = {}
  for (const m of blocks) {
    const body = m.length === 3 ? m[2] : m[1]
    const name = m.length === 3 ? m[1] : /name:\s*"([\w-]+)"/.exec(body)?.[1]
    if (name === theme) Object.assign(merged, declarations(body))
  }
  return merged
}

type Rgb = [number, number, number]
const hex = (h: string): Rgb => {
  const s = h.replace('#', '')
  const full = s.length === 3 ? [...s].map(c => c + c).join('') : s
  return [0, 2, 4].map(i => Number.parseInt(full.slice(i, i + 2), 16)) as Rgb
}

/** `#hex` or `color-mix(in srgb, #a N%, #b)` — the only two forms the theme uses for colours. */
function colour(value: string): Rgb {
  const mix = /^color-mix\(in srgb,\s*(#[0-9a-f]+)\s+(\d+)%,\s*(#[0-9a-f]+)\)$/i.exec(value)
  if (mix) {
    const [a, b, p] = [hex(mix[1]), hex(mix[3]), Number(mix[2]) / 100]
    return a.map((c, i) => Math.round(c * p + b[i] * (1 - p))) as Rgb
  }
  if (/^#[0-9a-f]{3,6}$/i.test(value)) return hex(value)
  throw new Error(`unsupported colour value: ${value}`)
}

const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map(c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const SEMANTIC = ['primary', 'accent', 'info', 'success', 'warning', 'error'] as const
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

/** [foreground, background, floor] for one theme. */
function pairs(): Array<[string, string, number]> {
  return [
    ...TEXT.flatMap(t => TEXT_SURFACES.map((s): [string, string, number] => [t, s, 4.5])),
    ['--color-base-content', '--color-base-100', 4.5],
    ['--color-base-content', '--color-base-200', 4.5],
    ...FILLS.map((c): [string, string, number] => [`--color-${c}-content`, `--color-${c}`, 4.5]),
    ...SEMANTIC.map((c): [string, string, number] => [`--color-${c}`, '--surface-panel', 4.5]),
    ...SEMANTIC.filter(c => c !== 'accent').map((c): [string, string, number] => [
      `--color-${c}`,
      `--tone-${c}-surface`,
      4.5,
    ]),
    ['--border-control', '--surface-panel', 3],
    ['--focus-ring', '--surface-panel', 3],
    ['--focus-ring', '--surface-app', 3],
  ]
}

describe.each(THEMES)('theme %s meets its WCAG AA floors', theme => {
  const t = tokens(theme)

  it.each(pairs())('%s on %s ≥ %s:1', (fg, bg, floor) => {
    expect(t[fg], `${fg} is not defined in ${theme}`).toBeDefined()
    expect(t[bg], `${bg} is not defined in ${theme}`).toBeDefined()
    const r = ratio(colour(t[fg]), colour(t[bg]))
    expect(
      Number(r.toFixed(2)),
      `${fg} ${t[fg]} on ${bg} ${t[bg]} is ${r.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(floor)
  })

  it('--color-secondary equals --text-secondary (DaisyUI `text-secondary` must mean the token)', () => {
    expect(t['--color-secondary']?.toLowerCase()).toBe(t['--text-secondary']?.toLowerCase())
  })
})

/**
 * The contrast floors `src/ui/index.css` promises in its header, asserted over the tokens it
 * actually emits (WCAG 2.x relative luminance): text ≥ 4.5:1 on every surface it sits on, each
 * DaisyUI colour ≥ 4.5:1 against its `-content`, each semantic colour readable as text on the
 * panel and on its own tone surface, `--border-control` and `--focus-ring` ≥ 3:1.
 *
 * The pairs and the arithmetic live in `scripts/lib/contrast.mjs`, which
 * `node scripts/design-docs.mjs --contrast` also runs over a brand being tried in
 * `docs/design/brand.css`: one rule set, so a brand that passes there passes here.
 *
 * The shell's own pairs — the rail, the chart series, the selection, the flare — are part of
 * `contrastPairs()` (`SHELL_PAIRS`), so the brand step checks them as well.
 *
 * Reads the CSS files, so a recolour (the rename's `--colour`, brand.css, or by hand) fails here
 * naming the token pair and the ratio. Pure parsing — the jsdom project only because it lives in tests/ui.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkPair,
  contrastPairs,
  EQUAL_TOKENS,
  themeTokens,
} from '../../../../scripts/lib/contrast.mjs'

const css = ['../../src/shared/theme-tokens.css', '../../src/ui/index.css']
  .map(file => readFileSync(path.resolve(__dirname, file), 'utf8'))
  .join('\n')
const themes = themeTokens(css)

describe.each(['light', 'dark'] as const)('the %s theme meets its WCAG AA floors', kind => {
  const t = themes[kind].tokens

  it('is defined', () => {
    expect(themes[kind].name, `no theme named *-${kind}`).toBeTruthy()
  })

  it.each(contrastPairs())('%s on %s ≥ %s:1', (fg, bg, floor) => {
    const r = checkPair(t, fg, bg, floor)
    expect(r.problem, r.problem).toBeUndefined()
    expect(r.ratio, `${fg} ${t[fg]} on ${bg} ${t[bg]} is ${r.ratio}:1`).toBeGreaterThanOrEqual(
      floor
    )
  })

  it.each(EQUAL_TOKENS)('%s equals %s (DaisyUI `text-secondary` must mean the token)', (a, b) => {
    expect(t[a]?.toLowerCase()).toBe(t[b]?.toLowerCase())
  })
})

/**
 * DaisyUI ships its components in layers inside `utilities`, so an override in
 * `@layer components` loses to it whatever its specificity — the field label sat at 3.88:1 and an
 * inactive tab at 2.85:1 behind such a rule. jsdom resolves no cascade layers, so this asserts
 * where the rule is written: outside every `@layer` block, where it wins.
 */
describe('the text-ramp overrides of DaisyUI sit outside every layer', () => {
  const source = readFileSync(path.resolve(__dirname, '../../src/ui/index.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  )

  /** Each top-level rule whose selector list is exactly `selector`, with its body. */
  function unlayeredRules(selector: string): string[] {
    const out: string[] = []
    let depth = 0
    let start = 0
    for (let i = 0; i < source.length; i++) {
      const ch = source[i]
      if (ch === '{') {
        if (depth === 0) {
          const head = source.slice(start, i).trim().replace(/\s+/g, ' ')
          const end = source.indexOf('}', i)
          if (head === selector) out.push(source.slice(i + 1, end))
        }
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) start = i + 1
      } else if (ch === ';' && depth === 0) {
        start = i + 1
      }
    }
    return out
  }

  it.each([
    ['.label', '--text-secondary'],
    ['.tab', '--text-secondary'],
  ])('%s is coloured %s', (selector, token) => {
    const bodies = unlayeredRules(selector)
    expect(bodies.join('\n'), `no unlayered \`${selector}\` rule in index.css`).toMatch(
      new RegExp(`(^|[;\\s])color:\\s*var\\(${token}\\)`)
    )
  })

  it('an active or hovered tab is the ink', () => {
    const active = source.match(/\n\.tab:is\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\{([^}]*)\}/)
    expect(active, 'no unlayered `.tab:is(…)` rule').toBeTruthy()
    for (const state of [':hover', '.tab-active', '[aria-selected="true"]'])
      expect(active?.[1]).toContain(state)
    expect(active?.[2]).toMatch(/color:\s*var\(--text-primary\)/)
  })

  it('the xs sizes render at the 12px floor', () => {
    expect(unlayeredRules('.btn-xs').join('')).toMatch(/--fontsize:\s*0\.75rem/)
    expect(unlayeredRules('.badge-xs, .kbd-xs, .file-input-xs').join('')).toMatch(
      /font-size:\s*0\.75rem/
    )
  })
})

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
 * Reads the CSS file, so a recolour (`/rf-adapt --colour`, or by hand) fails here naming the
 * token pair and the ratio. Pure parsing — the jsdom project only because it lives in tests/ui.
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

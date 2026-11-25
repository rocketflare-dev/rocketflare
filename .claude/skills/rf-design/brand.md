# The style step

`rf-design` §4, or the whole run with `/rf-design --brand <file>`. The goal is a look that reads as
theirs: a palette, type, density, tone and shape they chose, that passes the kit's contrast floors.
That means WCAG AA: 4.5:1 for text, 3:1 for controls, the focus ring and chart series, in light and
dark.

## The kit's default, so you know what you are changing

Ember: a warm rust hue (35) with quiet neutrals, IBM Plex Sans, and the logo's gold as the flare.
A tinted shell on that one hue at low chroma: a lightly tinted canvas, a side rail in a deep tone
of the hue with light text, near-white panels with a soft shadow, a warm charcoal ink, and one
primary for actions and selection. JetBrains Mono for code. 8px corners on controls and 14px on
panels. Comfortable density. A five-step chart series derived from the hue. The gold "flare"
appears only in the sign-in drawing. It is a default, not a brand: one hue recolours all of it.
Every hued colour is `oklch(L C 35)` in
`apps/web/src/shared/theme-tokens.css` and `apps/web/src/ui/index.css`; the header of `index.css`
lists every token.

Show them the running app or `pnpm design:docs --open` before asking anything: most people decide
faster against something real.

## The questions, one at a time

Give your recommendation and its reason each time, as in `SKILL.md`.

1. **Density.** Comfortable, the default, suits most apps. Compact suits screens people work in
   all day (dispatch, a ledger, a queue). Compact is `data-density="compact"` on the root
   element; record the choice and the screens it applies to in `DESIGN.md`.
2. **Tone.** Quiet, the kit's default (one warm hue at low chroma), lets their data carry the colour. Warmer or
   more expressive means a stronger hue, a serif for headings, or a larger radius. Never more
   state colours or decoration.
3. **Shape.** The radius (`--radius-control`, `--radius-panel`, `--radius-popover`) and the depth
   (`--shadow-panel`, `--shadow-popover`). A panel has a shadow or a border, never both. Squarer
   corners read as a tool; rounder read as consumer.
4. **Palette.** The simplest brand is one hue: `--brand-hue` turns the whole shell, keeping every
   lightness so the floors hold. Their own primary, accent or neutrals go on top of that. The
   state colours (info, success, warning, error) and the flare keep their hue under any brand.
5. **Type.** The sans face, and optionally a heading serif. Find a free equivalent of their face.
6. **The sign-in image.** The right half of the sign-in page shows a drawing of the kit's rocket
   (`apps/web/src/ui/components/LoginArt.tsx`), coloured from the rail and flare tokens, so it
   follows their hue on its own. Offer three choices:
   - keep it in their colours;
   - their own imagery: replace the SVG in `LoginArt.tsx` with theirs, as an inline SVG that takes
     its colours from `currentColor` and the `.login-art*` classes, or an image in
     `apps/web/src/ui/public/`. Only artwork they own; never their logo redrawn by you;
   - no picture: `LOGIN_PANEL.art = 'type'` in `apps/web/src/ui/lib/login-panel.ts` shows the app's
     name and tagline large.

   Either way, ask for the tagline: one line in their words, recorded as `app.tagline` in
   `design.json`. The rename writes it into `login-panel.ts`. These are code changes, so they
   happen after sign-off, with the rename.

## What you may take from their brand

- **Inputs:** a pasted image (a logo, a photo of their signage, a screenshot of their site), a
  website address, or a brand-guide PDF. With a website, read its CSS for the colours it actually
  uses before trusting a screenshot.
- **Take:** the primary colour, an accent if they have one, whether their neutrals lean warm or
  cool, and the feel of their type: geometric, humanist, serif, condensed.
- **Never take:** their logo or icon artwork, font files, or a commercial font by name. Find a free
  equivalent for the type feel, and say which one and why it is close. Their real logo goes in by
  hand later (`rf-adapt` checklist row (f)).

Show what you extracted before writing anything: three to five swatches, the font pairing, and
where each came from ("the button colour on your booking page").

## Write `docs/design/brand.css`

`brand.css` uses the same blocks as the two token files and holds only what it changes:

```css
@theme {
  --brand-hue: 25;                 /* degrees, or a colour whose hue to take: #b45309 */
  --font-sans: "Hanken Grotesk Variable", ui-sans-serif, system-ui, sans-serif;
  --radius-control: 6px;
  --radius-panel: 10px;
}
@plugin "daisyui/theme" { name: "any-light"; --color-primary: oklch(0.52 0.15 25); }
[data-theme="any-light"] {
  --rail-active: oklch(0.52 0.15 25);
  --shadow-panel: 0 1px 2px oklch(0.3 0.02 25 / 0.08);
  --series-1: oklch(0.52 0.15 25);
}
[data-theme="any-dark"] { --color-primary: oklch(0.76 0.12 25); }
```

- A block matches by its name's `-light` / `-dark` ending, so any prefix works.
- `--brand-hue` is applied first; every other property lands on top of the turned palette.
- A brand may set any token the two files define: colours, the rail (`--rail-*`), the chart
  series (`--series-1` to `-5`), the selection, depth, and in `@theme` the fonts and radii. A
  name neither file defines is reported and ignored.
- An explicit primary moves its derived tones too: `--focus-ring`, `--surface-active`,
  `--tone-primary-*`, `--rail-active`, `--rail-focus-ring` and `--selection-surface`. The check
  below warns about each one left at the kit's value.
- Dark mode is not the light palette inverted: pick a lighter tone of the same hue.
- A new font needs its `@fontsource-variable/*` package in `apps/web/package.json` and an import
  in `apps/web/src/ui/main.tsx`. That is a code change, so it is made with the rename.

## Nudge until it passes

```
pnpm design:docs --contrast
```

This checks the tokens with `brand.css` layered on, using the same pairs and floors as
`tests/ui/contrast.test.ts`: text on every surface, the rail's text on the rail, its hover and its
selection, each chart series on a panel, ink on the selection, and the flare on the sign-in panel.
It prints each failing pair with its ratio. To fix a failure, move the tone's lightness and keep
the hue. A brand colour too light for white text usually needs a darker shade for buttons and
links, with the original kept for large surfaces.

Show them a before and after for every tone you moved:

| Token | Their colour | Adjusted | Why |
|---|---|---|---|

Re-run until it exits 0, then render the pages (`rf-design` §7). They judge the result in their own
style, and that, not the table, is when they say yes.

## Record it

Write `docs/design/06-brand.md`:
- what the style was borrowed from;
- the palette before and after;
- the fonts, the density, the tone and the shape;
- the sign-in image chosen, and the tagline;
- what was left for later (the logo, their own sign-in imagery, any tone they want a designer to
  look at).

Then `docs/design/DESIGN.md` (SKILL.md §5): the same decisions as rules a builder follows, short.

The style reaches the app only at the rename (`rf-adapt` checklist rows (e) and (f)), after
sign-off. Re-running this step when a real brand guide arrives replaces `brand.css`. After the
rename, `pnpm design:docs --apply-brand` writes it into the two token files, and `pnpm web test:ui`
confirms it. When a later kit release brings a new default look, `pnpm design:docs
--adopt-default-look` takes it and re-applies `brand.css` on top; it runs only when asked.

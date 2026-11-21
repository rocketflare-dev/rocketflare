# The brand step

`rf-design` §4, or the whole run with `/rf-design --brand <file>`. The goal is a palette and a type
feel that read as theirs and pass the kit's contrast floors. That means WCAG AA: 4.5:1 for text,
3:1 for controls and the focus ring, in both light and dark.

## What you may take

- **Inputs:** a pasted image (a logo, a photo of their signage, a screenshot of their site), a
  website address, or a brand-guide PDF. With a website, read its CSS for the colours it actually
  uses before trusting a screenshot.
- **Take:** the primary colour, an accent if they have one, whether their neutrals lean warm or
  cool, and the feel of their type: geometric, humanist, serif, condensed.
- **Never take:** their logo or icon artwork, font files, or a commercial font by name. Find a free
  equivalent for the type feel (Google Fonts has one for most), and say which one and why it's
  close. Their real logo goes in by hand later (`rf-adapt` checklist row (f)).

Show what you extracted before writing anything: three to five swatches with hex values, the font
pairing, and where each came from ("the button colour on your booking page").

## Write `docs/design/brand.css`

The brand lives in two kit files:
- `apps/web/src/shared/theme-tokens.css`: the palette and fonts;
- `apps/web/src/ui/index.css`: the derived tones, `--surface-active`, `--focus-ring` and the
  `--tone-primary-*` tints.

`brand.css` uses the same blocks as those files, the light and the dark one, and contains only the
properties it changes. It sets the derived tones as well as the primary: a new primary over the
kit's blue tints is the half-applied brand that looks wrong.

Hexes, as the kit's files use them. Dark mode is not the light palette inverted. Pick its primary
as a lighter tone of the same hue, the way the kit pairs blue-600 with blue-400.

## Nudge until it passes

```
pnpm design:docs --contrast
```

This checks the kit's tokens with `brand.css` layered on, using the same pairs and floors as
`tests/ui/contrast.test.ts`, and prints each failing pair with its ratio. To fix a failure, move
the tone's lightness and keep the hue. A brand colour too light for white text usually needs a
darker shade for buttons and links, with the original kept for large surfaces.

Show them a before and after for every tone you moved:

| Token | Their colour | Adjusted | Why |
|---|---|---|---|

Re-run until it exits 0, then render the pages (`rf-design` §7). They judge the result in their own
brand, and that, not the table, is when they say yes.

## Record it

Write `docs/design/06-brand.md`:
- what the brand was borrowed from;
- the palette before and after;
- the fonts;
- what was left for later (the logo, and any tone they want a designer to look at).

The brand reaches the app only at the rename (`rf-adapt` checklist row (e)), after sign-off.
Re-running this step when a real brand guide arrives replaces `brand.css`. After the rename,
`pnpm design:docs --apply-brand` writes it into the two kit files, and `pnpm web test:ui` confirms
it.

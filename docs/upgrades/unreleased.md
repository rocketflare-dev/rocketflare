---
version: unreleased
previous: 0.41.1
date: null
breaking: false
migrations: []
areas: [ui, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

`pnpm design:site` renders the design documents in `docs/design/` into a static site in the app's own brand, and checks or adopts a palette tried in `docs/design/brand.css` against the kit's contrast floors.

- `scripts/design-site.mjs` builds `docs/design/site/` from `docs/design/*.md` and inlines a sanitised `docs/design/diagrams/*.svg`; `--open`, `--check`, `--contrast`, `--apply-brand` (`docs/CONCEPTS.md` §7).
- The contrast floors and pairs moved from `apps/web/tests/ui/contrast.test.ts` into `scripts/lib/contrast.mjs`, which the test and `--contrast` share.
- New libraries: `scripts/lib/brand.mjs`, `scripts/lib/markdown-lite.mjs`, `scripts/lib/svg-sanitize.mjs`, `scripts/lib/design-site-lib.mjs`, each with a `.d.mts`.

## How to apply

1. Add `scripts/design-site.mjs` and ten library files from the kit release: `scripts/lib/contrast`, `scripts/lib/brand`, `scripts/lib/markdown-lite`, `scripts/lib/svg-sanitize` and `scripts/lib/design-site-lib`, each as `.mjs` and `.d.mts`.
2. Add `"design:site": "node scripts/design-site.mjs"` to the root `package.json` `scripts`.
3. Replace `apps/web/tests/ui/contrast.test.ts` with the kit's version, which imports its pairs from `scripts/lib/contrast.mjs`. A copy that added its own pairs to the test adds them to `contrastPairs()` in `scripts/lib/contrast.mjs` instead.
4. Add `apps/web/tests/config/design-site.test.ts` from the kit release.

## Conflicts to expect

- `apps/web/tests/ui/contrast.test.ts` → its pairs and arithmetic moved into `scripts/lib/contrast.mjs` → take the kit's file and move any pair you added into `contrastPairs()`.

## Verify

1. `pnpm web test:ui -- contrast` passes.
2. `pnpm web test:config -- design-site` passes.
3. `pnpm design:site --contrast` prints `all … pairs pass` for light and dark and exits 0.

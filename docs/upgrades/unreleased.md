---
version: unreleased
previous: 0.41.1
date: null
breaking: false
migrations: []
areas: [ui, config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

New apps start with `/rf-start`: setup, a design conversation with the owner (`/rf-design`) rendered as branded pages by `pnpm design:docs`, then a rename that applies the brand and makes `LICENSE` the owner's.

- `/rf-design` (new, `.claude/skills/rf-design/`): the shape questions (organisations, roles and words, AI, money, non-functional needs, hosting, licence, integrations and existing plugins), stages with "Done when", the brand step, and an independent review. It writes `docs/design/`. Rationale: `docs/CONCEPTS.md` §13 "A copy starts with a design".
- `/rf-start` (new): detach, setup, `/rf-design`, `/rf-adapt`, in that order; the website's prompt names it.
- `scripts/detach.sh` (new): the one detach. It stamps only the kit block's `commit` in `.rocketflare.json`. `install.sh` used to stamp the vendored example plugin's `source.commit` too, and `/rf-setup` §0 and the README's by-hand path stamped nothing.
- `/rf-adapt` checklist row (e) applies `docs/design/brand.css` when there is one, and the new row (h) writes the app's own `LICENSE`. The kit's MIT notice moves into `LICENSES/kit-MIT.txt`, a new `neverPort` path.
- `scripts/design-docs.mjs` builds `docs/design/html/` from `docs/design/*.md` and inlines a sanitised `docs/design/diagrams/*.svg`; `--open`, `--check`, `--contrast`, `--apply-brand` (`docs/CONCEPTS.md` §7).
- The contrast floors and pairs moved from `apps/web/tests/ui/contrast.test.ts` into `scripts/lib/contrast.mjs`, which the test and `--contrast` share.
- New libraries: `scripts/lib/brand.mjs`, `scripts/lib/markdown-lite.mjs`, `scripts/lib/svg-sanitize.mjs`, `scripts/lib/design-docs-lib.mjs`, each with a `.d.mts`.

## How to apply

1. Add `scripts/design-docs.mjs` and ten library files from the kit release: `scripts/lib/contrast`, `scripts/lib/brand`, `scripts/lib/markdown-lite`, `scripts/lib/svg-sanitize` and `scripts/lib/design-docs-lib`, each as `.mjs` and `.d.mts`.
2. Add `"design:docs": "node scripts/design-docs.mjs"` to the root `package.json` `scripts`.
3. Replace `apps/web/tests/ui/contrast.test.ts` with the kit's version, which imports its pairs from `scripts/lib/contrast.mjs`. A copy that added its own pairs to the test adds them to `contrastPairs()` in `scripts/lib/contrast.mjs` instead.
4. Add `apps/web/tests/config/design-docs.test.ts` from the kit release.
5. Copy three things from the kit release into the app, translated as usual: the `.claude/skills/rf-design/` folder (`SKILL.md`, `shape.md`, `brand.md`), the `.claude/skills/rf-start/` folder, and `scripts/detach.sh`. In an app that is already renamed, `/rf-start` only reports that every step is done.
6. Add the `rf-adapt` checklist's new row (h), "Licence", from the kit's `.claude/skills/rf-adapt/checklist.md`. `rf-adapt` is `neverPort`, so the patch does not carry it. Copy it by hand, along with the "From the design" paragraph of row (e).
7. If the app's root `LICENSE` is still the kit's MIT notice, copy it to `LICENSES/kit-MIT.txt` before changing anything, then walk checklist row (h) to write the app's own `LICENSE` and `package.json` `license` fields.
8. Add `"LICENSES/**"` to `neverPort` in `.rocketflare.json`, beside `"LICENSE"`.

## Conflicts to expect

- `apps/web/tests/ui/contrast.test.ts` → its pairs and arithmetic moved into `scripts/lib/contrast.mjs` → take the kit's file and move any pair you added into `contrastPairs()`.

## Verify

1. `pnpm web test:ui -- contrast` passes.
2. `pnpm web test:config -- design-docs` passes.
3. `pnpm design:docs --contrast` prints `all … pairs pass` for light and dark and exits 0.
4. `ls .claude/skills/rf-design` lists `SKILL.md`, `shape.md` and `brand.md`.
5. `head -1 LICENSE` names the app's owner, not the kit's author, and `LICENSES/kit-MIT.txt` exists.

---
breaking: false
migrations: []
areas: [plugins, scripts, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The kit now proves the latest release of every published plugin against each kit tag, one job per plugin plus all of them installed together, reported through the run and its summary, and `@testkit/unit` gains helpers for tests that assert only a plugin's own entries.

- New `@testkit/unit` exports: `isOwnContribution(id, key)`, `ownContributions(id, items, keyOf?)` and `expectOwnContributions(id, items, expectedKeys, keyOf?)`. The last throws unless the plugin's own namespaced entries (`<id>`, `<id>:…`, `<id>.…`, `<id>/…`) in a shared list are exactly the expected keys, and ignores every other plugin's (`docs/CONCEPTS.md` §16).
- `apps/web/src/plugins/CLAUDE.md` and `/rf-plugin` §6: a plugin's test over a shared registry asserts only the plugin's own entries.
- Kit repository only, removed by the rename: `.github/workflows/plugin-matrix.yml` and `scripts/plugin-matrix.mjs` replace `notify-plugins.yml`, and `pnpm kit:release` dispatches the matrix against `main` and prints `✔` or `⚠ <plugin> fails on main: <step>, <run>` without blocking.

## How to apply

- Optional: in an app plugin's tests, replace an exact assertion over a registry other plugins share (a provider, tool or nav list) with `expectOwnContributions('<plugin-id>', items, ['<plugin-id>:…'])` from `@testkit/unit`.

## Conflicts to expect

None.

## Verify

- `pnpm test config apps/web/tests/config/testkit-contributions.test.ts` passes.
- `pnpm gate` passes.

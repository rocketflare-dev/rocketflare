---
version: unreleased
previous: 0.17.8
date: null
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The kit declares the Launch kit contract in a root `launch.kit.json` (D36), checked by `scripts/kit-check.mjs` in the kit and in every renamed copy, so Launch drives a copy from the copy's own manifest.

- `launch.kit.json` → what the kit calls things and how Launch scaffolds, develops in, gates, ships and upgrades an app from it (`docs/CONCEPTS.md` §13).
- `scripts/kit-check.mjs` + `scripts/lib/{kit-manifest,toml-lite,yaml-lite}.mjs` → the static conformance check, shared with the meta-kit `rocketflare-dev/launch-kit`; `node scripts/kit-check.mjs [--exec]`.
- `scripts/rename.mjs` → a copy keeps `launch.kit.json`; the rename rewrites it through the token map except its `kit` block (`renameKitManifest`).
- `.rocketflare.json` → `kit.id` (`rocketflare`), the id Launch reads from a copy's app manifest; `launch.kit.json` is on the `manual` list.
- `kit.yml` → `Launch kit check` in `kit-checks`, and the same check on the renamed `my-app` copy.
- `apps/web/tests/config/{kit-check,kit-check-parsers,launch-kit-manifest}.test.ts` → the checker's own tests, and the manifest's values checked against the bootstrap, the dev server, the tomls and the RLS role.

## How to apply

1. Add `"id": "rocketflare"` as the first key of the `kit` block in `.rocketflare.json`, above `"name"`.
2. Add `"launch.kit.json"` to the `manual` list in `.rocketflare.json`, so later kit releases show its diff rather than patch it through the token map.
3. In `launch.kit.json`, which this upgrade added through the token map, set `kit.id` back to `rocketflare` and `kit.name` back to `Rocketflare`; every other renamed value (`session.env`) stays as the upgrade wrote it.
4. Run `pnpm lint:fix` so `launch.kit.json` and `.rocketflare.json` take Biome's layout.

## Conflicts to expect

None — every file is new except `.rocketflare.json`, which the upgrade never ports, and `scripts/rename.mjs` with its lib, which it ports only with `--include-kit-tooling`.

## Verify

1. `node scripts/kit-check.mjs --exec` prints `✔ conforms to the Launch kit contract (schema 1)` and exits 0.
2. `node -p 'require("./launch.kit.json").kit.id'` prints `rocketflare`.
3. `pnpm gate` passes.

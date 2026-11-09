---
version: unreleased
previous: 0.28.0
date: null
breaking: false
migrations: []
areas: [config, shared, api]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Three open dependency advisories are closed: AG-UI moves to 1.0.4, which drops its private zod 3, and two pnpm overrides pin the patched esbuild and postcss-selector-parser.

- `@ag-ui/core`, `@ag-ui/encoder` and `@ag-ui/proto` are pinned at `1.0.4` (were `1.0.3`). `@ag-ui/proto@1.0.4` takes zod as a peer, so the only zod left is the kit's own (GHSA-mrhx-c7xc-m3w5).
- `pnpm-workspace.yaml` gains `overrides`: `@esbuild-kit/core-utils>esbuild` → `0.25.12` (GHSA-67mh-4wv8-2f99, reached through `drizzle-kit`) and `@tailwindcss/typography>postcss-selector-parser` → `6.1.5` (GHSA-rj75-hqrm-r3gf).
- A copy upgraded to 0.28.0 may still resolve `source-map-js@1.2.1`, which the kit's lockfile already moved to `1.2.2`; the steps below refresh it.

## How to apply

1. In `apps/web/package.json`, set `@ag-ui/core`, `@ag-ui/encoder` and `@ag-ui/proto` to exactly `1.0.4`.
2. In `packages/shared/package.json`, set `@ag-ui/core` to exactly `1.0.4`.
3. In `pnpm-workspace.yaml`, add an `overrides:` map with `'@esbuild-kit/core-utils>esbuild': 0.25.12` and `'@tailwindcss/typography>postcss-selector-parser': 6.1.5`, merged into any `overrides:` the app already has.
4. Run `pnpm install` so `pnpm-lock.yaml` resolves the `@ag-ui/*` 1.0.4 pins and the two `pnpm-workspace.yaml` overrides; `pnpm kit:upgrade` ports no lockfile.
5. Run `pnpm update -r source-map-js` so every transitive `source-map-js` resolves `1.2.2`.
6. Once every Verify step passes, close any open Dependabot security PR for zod, esbuild or source-map-js without merging it: in a pnpm workspace those PRs leave the flagged package unchanged.

## Conflicts to expect

- `pnpm-workspace.yaml` → `overrides:` added → keep the app's own entries beside the kit's two.

## Verify

1. `pnpm why zod -r` lists no `zod@3.x`.
2. `pnpm why esbuild -r` lists no `esbuild@0.18.x`.
3. `pnpm why postcss-selector-parser -r` lists no version below `6.1.5`.
4. `pnpm why source-map-js -r` lists no `source-map-js@1.2.1`.
5. `pnpm web db:generate` exits 0, which proves `drizzle-kit` loads the schema under `esbuild@0.25.12`.
6. `pnpm gate` passes.

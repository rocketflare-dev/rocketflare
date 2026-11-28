---
breaking: false
migrations: []
areas: [plugins, scripts, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The kit now publishes its plugin surface as `docs/plugin-surface.json`, built by a parser instead of the type checker, and `docs/plugin-api.md` keeps only the entry list and the Markdown ledger.

- New `docs/plugin-surface.json`, written by `node scripts/plugin-api-doc.mjs`: every declared entry, each exported member's entry, kind and name (expanded context members included), the moved-symbol map, and the aliases (`@rf/*` is a second name for `@/plugins/api/*`). It records no signatures. `kit.yml` diff-checks it with `docs/plugin-api.md`.
- `scripts/plugin-api-doc.mjs` reads the declared entries with `oxc-parser` (new root devDependency) through `scripts/lib/module-exports.mjs`, not with `typescript6`. It lists the same 776 members the type checker did, and `apps/web/tests/kit-only/plugin-surface.test.ts` checks that against the checker.
- `readLedger` in `scripts/lib/surface.mjs` reads `docs/plugin-surface.json` first. It falls back to the `## Surface ledger` block of `docs/plugin-api.md` when the JSON is absent or malformed, and `ledger.source` says which file it read. `resolveSpecifier` resolves `@rf` and `@rf/*` like `@/plugins/api`.
- `docs/plugin-api.md` drops the per-entry signature dump and the "What you want to do" index. Its ledger rows keep four fields, but the fourth (the signature) is now always `-`, so a vendored `surface.mjs` still parses them.
- The "What you want to do" index is now hand-written in `.claude/skills/rf-plugin/reference.md`. A test checks that every name in it exists in the surface.
- `docs/plugin-surface.json` is a sealed generated file in `kit-guard`, like `docs/plugin-api.md`, and Biome skips it.

## How to apply

- Run `node scripts/plugin-api-doc.mjs` after porting, and commit `docs/plugin-surface.json` and `docs/plugin-api.md` as it writes them.
- An app that reads the signature column of the Markdown ledger should read the entry barrel instead, because the ledger now writes `-` there.

## Conflicts to expect

- `docs/plugin-api.md` → regenerated in a new, shorter shape → take the kit's version, then run `node scripts/plugin-api-doc.mjs`.

## Verify

- `node scripts/plugin-api-doc.mjs --check` prints `✔ the plugin surface is up to date`.
- `pnpm plugin check` passes.
- `pnpm gate` passes.

---
breaking: false
migrations: []
areas: [plugins, scripts, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

`pnpm plugin` now reads per-plugin release tags (`<id>-vX.Y.Z`, such as `analytics-v3.15.0`) as well as lockstep `X.Y.Z` tags, and takes whichever is the newer release of the plugin.

- `plugin add <id>`, `plugin add <repo> --subdir <dir>` and `plugin upgrade <id>` with no ref, and `plugin list --available`, resolve each plugin to the higher version of its own newest tag and the newest lockstep tag that holds it. Its own tag wins a tie, and another plugin's tag never counts (`docs/CONCEPTS.md` §16).
- A typed bare version (`plugin add analytics@3.15.0`, `plugin upgrade analytics --to 3.15.0`, a `ref` in `defaultPlugins`) means `<id>-vX.Y.Z` when that tag exists, else the lockstep tag. Pins to `3.14.0` keep working.
- `plugin list --available` heads a repository `each at its newest release` when its plugins sit at different tags, and `--json` gives each plugin's `tag`.
- Kit repository only, removed by the rename: the plugin matrix installs each plugin at its own newest release (a new `refs` matrix field, with `plugins_ref` as the fallback), and `.github/ci-plugins.json` and `kit:release`'s CI-plugin check take either tag form.
- The plugin repositories still release in lockstep at 3.14.0. Once they move to per-plugin tags, a copy on an older kit keeps resolving 3.14.0, which is stale but not broken, until this release brings the new resolver.

## How to apply

- Nothing to do. A plugin installed at a lockstep tag upgrades to its own `<id>-vX.Y.Z` release with `pnpm plugin upgrade <id>` once it has one.

## Conflicts to expect

None.

## Verify

- `pnpm plugin list --available` lists every published plugin with its version.
- `pnpm gate` passes.

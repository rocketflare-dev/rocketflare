---
breaking: false
migrations: []
areas: [config]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

`pnpm plugin check` resolves the imports of a plugin's compiled trees only, so an example a plugin ships under `docs/plugins/<id>/`, written to be copied elsewhere, no longer fails the install that copies it.

- `scripts/lib/plugin-lib.mjs` exports `pluginCodeDirectories(surface)`: a surface's directories under `apps/web/src/plugins/<id>/`, `packages/shared/src/plugins/<id>/` and `apps/cli/src/plugins/<id>/`, never `docs/plugins/<id>/` or a skill directory.
- The check's "plugin imports resolve" step in `scripts/plugin.mjs` walks those directories instead of every `paths` directory.

## How to apply

- Take `scripts/lib/plugin-lib.mjs`, `scripts/lib/plugin-lib.d.mts` and `scripts/plugin.mjs` as they are, if you have not changed them; otherwise add `pluginCodeDirectories` and call it where the unresolved-import step called `surfaceDirectories`.

## Conflicts to expect

None.

## Verify

- `pnpm plugin check` passes in an app with a plugin whose `docs/plugins/<id>/` holds TypeScript importing paths relative to the plugin's tree.
- `pnpm gate` passes.

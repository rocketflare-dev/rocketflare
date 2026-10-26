---
version: unreleased
previous: 0.23.0
date: null
breaking: false
migrations: []
areas: [plugins]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Plugin validation now inspects code with TypeScript AST analysis and project-aware module resolution instead of regex string matching.

- `scripts/lib/plugin-lib.mjs`: worker export detection (`workerExports`), config property extraction (`pluginPropertyMap`), and import isolation checks now parse files using the TypeScript compiler AST rather than regular expressions.
- `loadProjectCompilerOptions` and `findProjectTsconfig` derive compiler options from each file's enclosing project (`apps/web`, `apps/cli`, `packages/shared`) so path aliases and module resolution reflect the target workspace.
- `unresolvedPluginImports` supports Vite query imports (such as `?raw` and `?url`) without false unresolved errors and returns structured `UnresolvedPluginImport` objects instead of TypeScript diagnostic codes.

## How to apply

1. Copy `scripts/lib/plugin-lib.mjs` and `scripts/lib/plugin-lib.d.mts` from the kit.
2. Copy `apps/web/tests/config/plugin-lib.test.ts` from the kit.

## Conflicts to expect

None.

## Verify

1. `pnpm plugin check` passes.
2. `pnpm --filter @rocketflare/web exec vitest run --project config tests/config/plugin-lib.test.ts` passes.

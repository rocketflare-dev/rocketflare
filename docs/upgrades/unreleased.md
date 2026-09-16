---
version: unreleased
previous: 0.4.0
date: null
breaking: false
migrations: []
areas: [shared, api, ui, config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

**The kit gained the seam a plugin plugs into (D31, PR A1 of four).** A plugin is a separate git
repository copied into an app — never installed from npm, exactly like the kit itself — that
contributes contracts, routes, schema, UI, agent tools, jobs and CLI commands. This release adds the
host half of that contract; nothing is extracted into a plugin yet, and an app with no plugins
installed behaves exactly as it did.

Five barrels, each shipping an empty `as const` tuple that `pnpm plugin add|remove` writes one line
into, plus the types they hold:

| Barrel | Exports | Types |
|---|---|---|
| `packages/shared/src/plugins/index.ts` | `SHARED_PLUGINS`, `sharedPlugins` | `plugins/types.ts` (`SharedPlugin`) |
| `apps/web/src/plugins/server.ts` | `SERVER_PLUGINS`, `serverPlugins` | `apps/web/src/plugins/types.ts` |
| `apps/web/src/plugins/ui.ts` | `UI_PLUGINS`, `uiPlugins` | same file (`UiPlugin`) |
| `apps/web/src/plugins/schema.ts` | `export *` of plugin tables | — |
| `apps/cli/src/plugins/index.ts` | `CLI_PLUGINS`, `cliPlugins` | `apps/cli/src/plugins/types.ts` |

Each barrel exports the `as const` tuple AND a widened list beside it: the tuple is what type-level
derivations read, and an EMPTY tuple indexes to `never`, so everything that only iterates reads the
widened one.

The slots wired in this release: plugin `mounts` spread into the mount table of `api/index.ts` and
`apiPrefixes` into `API_PREFIXES`; `UiPlugin.routes` mapped per tier (`shell | noTenant | public`)
in `App.tsx`; `composeNav()` splicing plugin nav groups before a named core group ("Organisation" by
default); settings tabs appended after the kit's; query-key families merged into `queryKeys`;
`SharedPlugin.config` merged into the Worker's config schema; `onTenantCreated` and the `--demo`
seed iterating plugin hooks after the kit's own; `SharedPlugin.realtimeRoots` unioned into
`access.changed`; and `export * from '../../plugins/schema'` in the schema barrel (its position
among the sorted `export *` lines decides nothing — a name exported twice is TS2308, not a silent
shadow).

Two existing pieces were reshaped rather than added to:

- **Visibility (D29) is now a registry.** `services/access.ts` exports `VisibilityResource`
  (`{ key, noun, usageKey, predicate, setGroups, grantRows, countGrants }`) and
  `VISIBILITY_RESOURCES`; documents and analytics pages are two entries in it, and a plugin adds its
  own through `ServerPlugin.visibilityResources`. `setResourceGroups` and `grantsForResources` take a
  `kind: string` and dispatch through the registry instead of branching on a two-value union, and the
  409 `group_in_use` body is one count per registered resource. `countGroupGrants` MOVED from
  `services/groups.ts` to `services/access.ts` — `access.ts` already imports `groups.ts`, so leaving
  it where it was would have closed a module cycle.
- **`.rocketflare.json` learns `kind: 'plugin'`,** with a `source` block naming the repo a plugin
  came from. `scripts/lib/manifest.mjs` (`readManifest`) is now the one kit-vs-app predicate and the
  one reader of the git-ignored `.rocketflare.local.json` sidecar, which is where a plugin installed
  into the kit itself (or with `--local`) is recorded. `classifyPath` gains
  `skipped-plugin-owned`: a kit diff never touches a file an installed plugin owns, because the
  plugin has its own repository and its own release chain.

Tests: `tests/config/plugins.test.ts` (the "well-formed plugin" suite — ids, query-key namespacing,
the no-deep-import rule, the `ui.ts` allowlist and `lazy()` rule, all as pure helpers exercised with
fixtures so they mean something with zero plugins installed) and `tests/config/manifest-lib.test.ts`.
`vitest.config.ts` discovers `src/plugins/*/tests/{api,ui,config}` and `src/ui/index.css` gains an
`@source` line for `src/plugins/**/ui/**`.

## How to apply

Mechanical; no schema change and no new dependency. Take the new files whole
(`packages/shared/src/plugins/*`, `apps/web/src/plugins/*`, `apps/cli/src/plugins/*`,
`scripts/lib/manifest.{mjs,d.mts}`, the two test files) and the edits to the wiring points listed
above. Three things the patch cannot do for you:

1. **`packages/shared/package.json` gains a `./plugins` export entry** (beside `./ai`). The wildcard
   `./*` maps to a FILE, so `@rocketflare/shared/plugins` does not resolve without it. That file is
   on the manifest's `manual` list, so the upgrade will not edit it for you.
2. **`.gitignore` gains `.rocketflare.local.json`.** Without it, a plugin installed into a checkout
   with `--local` is committed, and every copy made from that commit inherits wiring for files it
   does not have.
3. If you renamed the kit, your barrels are already in your own vocabulary — the upgrade translates
   these files like any other source file, and a plugin you install later is translated on the way
   in by `pnpm plugin add`.

If you have customised the D29 visibility helpers, re-express your resource as a
`VisibilityResource` entry rather than a third branch: `visibleDocuments` / `visibleAnalyticsPages`
keep their signatures and are reused as the two core entries' `predicate`s, so the SQL is unchanged.

## Conflicts to expect

- `apps/web/src/api/services/access.ts` — the largest single edit; `setResourceGroups` and
  `grantsForResources` lost their `if (kind === 'document')` branches.
- `apps/web/src/api/services/groups.ts` and `apps/web/src/api/routes/groups.ts` — `countGroupGrants`
  moved, and the 409 sentence is built from the registry. If you added a resource to `GroupUsage`,
  it becomes a registry entry with a `usageKey`, and the type is now `Record<string, number>`.
- `apps/web/src/ui/lib/query-keys.ts` — the literal is now `CORE_QUERY_KEYS`, spread into an
  exported `queryKeys` that also carries the plugin families. Any local edit to the literal applies
  cleanly inside `CORE_QUERY_KEYS`.
- `apps/web/src/ui/components/SideNav.tsx` — the literal is now `CORE_NAVIGATION`, and
  `navigationConfig` is `composeNav(CORE_NAVIGATION, …)`. An app that reordered the nav keeps its
  edit inside `CORE_NAVIGATION`.
- `apps/web/src/config.ts` — `configSchema` is now `coreConfigSchema` extended with the plugin
  shape. `AppConfig` is still inferred from the core schema, deliberately.
- `apps/web/vitest.config.ts` and `apps/web/src/ui/index.css` if you changed either.

## Verify

`pnpm lint && pnpm typecheck && pnpm test && pnpm build` at the root, with
`git status --porcelain apps/web/worker-configuration.d.ts` empty. Then, specifically:

- `pnpm db:generate` emits **nothing** — this release adds no table.
- `pnpm --filter @rocketflare/web test:config` is green, including `plugins.test.ts` (15 cases with
  no plugins installed), `manifest-lib.test.ts` and the extended `kit-manifest.test.ts`.
- The UI is unchanged: the nav, `/settings` tabs and every route render exactly as before, because
  every plugin list is empty.
- `DELETE /api/groups/:id` on a group that still grants access still answers 409 `group_in_use` with
  `{ documents, dashboards }` and the same sentence.

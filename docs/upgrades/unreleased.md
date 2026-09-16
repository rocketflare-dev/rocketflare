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

**Then the closed sets were opened (PR A2 of four).** Every registry a plugin contributes to now
follows one pattern — the kit's literal becomes `CORE_X`, and `X = [...CORE_X, ...plugin X]` (or a
spread, for a record). The public name is unchanged in every case, so nothing that READS one of them
moves; what moves is where you ADD to it.

| Set | Was | Is now |
|---|---|---|
| job variants | `jobInputSchema` + `jobEnvelopeSchema` + `JOB_TYPES`, three hand-kept lists | `CORE_JOB_VARIANTS` — one list; `JOB_VARIANTS`, both unions, `JobType` and `JOB_TYPES` are DERIVED |
| job handlers | `handlers` + a `runHandler` switch repeating it | `coreHandlers`, merged with each plugin's `jobHandlers`; **the switch is deleted** |
| agent keys | `AGENT_KEYS` | `CORE_AGENT_KEYS` + `SharedPlugin.agentKeys` |
| agents | `AGENTS` | `CORE_AGENTS` + `ServerPlugin.agents` |
| agent forms | `AGENT_FORMS` | `CORE_AGENT_FORMS` + `UiPlugin.agentForms` |
| agent tools | `buildAgentTools` returns three | plus `ServerPlugin.agentTools(ctx)` |
| prompts | `PROMPT_REGISTRY` | `CORE_PROMPT_REGISTRY` + `ServerPlugin.prompts` |
| subjects | `Subjects = CoreSubject \| FeatureSubject` | `\| PluginSubject`, with `ServerPlugin.grants` run after the kit's matrix in `buildAbility` |
| features | `FEATURES`, `FEATURE_FLAGS` | `CORE_FEATURES` / `CORE_FEATURE_FLAGS` + `SharedPlugin.features` |
| crons | `SCHEDULED_TASKS` | `CORE_SCHEDULED_TASKS`, with a plugin's tasks APPENDED per cron |
| RLS exclusions | `RLS_EXCLUDED_TABLES` | unchanged; `ServerPlugin.rlsExcludedTables` is unioned in by `rls-coverage.test.ts` |
| cross-tenant allow-list | `UNSCOPED_ALLOWLIST` | `CORE_UNSCOPED_ALLOWLIST` + `ServerPlugin.unscopedAllowlist` (same keying: a path under `apps/web/` → the reason) |
| CLI | the commander chain | plus `for (const plugin of cliPlugins) plugin.register(program, action)`, last |

**Deleting `runHandler` is the one change worth reading twice.** It was a `switch` that named every
job type a second time, purely to narrow `job` for the call. The mapped type on the handler table
(`{ [T in CoreJobType]: JobHandler<T> }`) already proves completeness, and it proves it for a set
the kit cannot enumerate once plugins contribute to it — so dispatch is now
`handlers[job.type](job as never, ctx)` and a missing handler is a compile error in the table rather
than a fallthrough in the switch.

Two constraints the seam now states out loud. **`packages/shared/src/plugins/**` never imports one
of the five composers — `ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts`, `realtime.ts` —
AT RUNTIME**, because those five read the plugin barrel and two zod modules in a cycle crash at
module evaluation rather than failing to compile. A whole-declaration `import type { X } from` is
fine (it is erased, and it is how `SharedPlugin.features` is typed against the one
`FeatureDefinition`); `import { type X } from` is not, because eliding every specifier leaves an
empty import clause whose fate is the bundler's decision. `tests/config/shared-imports.test.ts`
checks all three spellings. And **a plugin declares `relations()` for its own tables only**: measured on drizzle-orm 0.45.2, a second `relations()` for
a core table merges at runtime but NOT at the type level (`ExtractTableRelationsFromSchema` unions
the two configs, `BuildRelationResult` then keys over their intersection), so adding one silently
strips `with:` from that table's query results app-wide. The note is in
`apps/web/src/plugins/schema.ts`.

`apps/web/src/plugins/types.ts` now names the agent runtime (`AnyAgentDefinition`,
`AgentToolContext`, `AgentForm`), which is the deletable `feature-agents` surface, so it is listed
in that surface's `registries[]` — an adopter who deletes the agent runtime deletes those four
fields too, exactly as they already delete lines from `worker.ts`, `api/index.ts` and `App.tsx`.

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

**If you added your own job types**, this is the one mechanical edit A2 asks of you. Move your
variant into `CORE_JOB_VARIANTS` — ONE entry, not the two you have in `jobInputSchema` and
`jobEnvelopeSchema` — delete your literal from `JOB_TYPES` (it is derived now), keep your handler
entry (the table is called `coreHandlers`), and **delete your `case` from `runHandler`**: that
function is gone, and a leftover copy of it will not compile. The wire format is byte-identical
before and after, so in-flight messages are unaffected. The same shape applies to your own agents
(`CORE_AGENT_KEYS`, `CORE_AGENTS`, `CORE_PROMPT_REGISTRY`, `CORE_AGENT_FORMS`), feature keys
(`CORE_FEATURES`, `CORE_FEATURE_FLAGS`) and crons (`CORE_SCHEDULED_TASKS`): the literal you were
editing kept its contents and changed its name, so your edit applies cleanly inside it.

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
- `packages/shared/src/jobs.ts` — the largest single edit of A2: the two hand-written unions are one
  `CORE_JOB_VARIANTS` tuple, and `JOB_TYPES` moved to the bottom as a derivation. An app with its
  own job types will reject here; the "How to apply" note above is the resolution.
- `apps/web/src/api/queues/jobs.ts` — `runHandler` is deleted and `handlers` is now two objects
  merged. A `case` of your own has nowhere to go back to.
- `apps/web/src/api/services/prompts.ts`, `services/agents/registry.ts`,
  `src/ui/pages/agents/forms/index.ts`, `src/api/scheduled.ts`, `packages/shared/src/permissions.ts`
  and `features.ts` — in each, one literal was renamed `CORE_*` and a merge was added beneath it.
  An edit inside the literal applies cleanly.
- `apps/web/tests/config/unscoped-allowlist.test.ts` and `tests/api/rls-coverage.test.ts` — both
  gained a union with the installed plugins; your own entries stay where they are.

## Verify

`pnpm lint && pnpm typecheck && pnpm test && pnpm build` at the root, with
`git status --porcelain apps/web/worker-configuration.d.ts` empty. Then, specifically:

- `pnpm db:generate` emits **nothing** — this release adds no table.
- `pnpm --filter @rocketflare/web test:config` is green, including `plugins.test.ts` (17 cases with
  no plugins installed, the last two being the `expectTypeOf` pins on the jobs union, the agent-key
  enum and the query keys — they are checked by `pnpm typecheck`, not at run time),
  `shared-imports.test.ts` (11, including the plugin runtime-import rule and its three
  spellings), `manifest-lib.test.ts` and the
  extended `kit-manifest.test.ts`.
- Jobs still round-trip: `tests/api/jobs-consumer.test.ts` and `queue-dispatch.test.ts` are
  unchanged and green, which is what proves the derived union parses exactly what the hand-written
  one did.
- The UI is unchanged: the nav, `/settings` tabs and every route render exactly as before, because
  every plugin list is empty.
- `DELETE /api/groups/:id` on a group that still grants access still answers 409 `group_in_use` with
  `{ documents, dashboards }` and the same sentence.

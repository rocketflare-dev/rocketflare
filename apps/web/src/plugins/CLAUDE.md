# The plugin seam (D31)

A plugin is a **separate git repository copied into an app** — never installed from npm, exactly
like the kit itself — that contributes contracts, schema, routes, jobs, agents, UI and CLI commands.
This directory is the host half: the types, the two web barrels, and every installed plugin's tree.
`docs/CONCEPTS.md` §16 is the decision record; `example-feature/` is the worked example.

The whole seam is **five barrel lines**. Installing a plugin is writing them; removing it is
deleting them. Nothing else in the kit ever names a plugin, which is what makes both reversible.

| Barrel | Exports | Read by |
|---|---|---|
| `packages/shared/src/plugins/index.ts` | `SHARED_PLUGINS` / `sharedPlugins` | the five composers: `ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts`, `realtime.ts` — plus `apps/web/src/config.ts` |
| `server.ts` | `SERVER_PLUGINS` / `serverPlugins` | `api/index.ts`, `utils/routes/api-prefixes.ts`, `queues/jobs.ts`, `scheduled.ts`, `agents/registry.ts`, `agents/tools/index.ts`, `prompts.ts`, `permissions/abilities.ts`, `utils/db/tenant-helpers.ts`, `services/access.ts`, `scripts/seed.ts`, the `rls-coverage` and unscoped-allowlist tests (never `db/schema/rls.ts` — a cycle) |
| `ui.ts` | `UI_PLUGINS` / `uiPlugins` | `App.tsx`, `SideNav.tsx`, `SettingsLayout.tsx`, `lib/query-keys.ts`, `pages/agents/forms/index.ts` |
| `schema.ts` | one `export *` per plugin | one `export *` line in `db/schema/index.ts` (position irrelevant — a duplicated name is TS2308) |
| `apps/cli/src/plugins/index.ts` | `CLI_PLUGINS` / `cliPlugins` | `cli.ts` |

**Two names per barrel, and the reason is not style.** The `as const` TUPLE is what type-level
derivations read (the job-variant union, the agent-key enum, the subject union). An EMPTY tuple
indexes to `never`, and `never.mounts` is a type error — so everything that only ITERATES reads the
widened list beside it. Use `SERVER_PLUGINS` in a type position, `serverPlugins` in a loop.

`types.ts` holds `ServerPlugin<S>` and `UiPlugin<S>`, generic over the plugin's own `SharedPlugin`
so `jobHandlers`, `agents`, `prompts` and `agentForms` are checked for exhaustiveness against the
keys THAT plugin declared: a missing handler is a type error in the plugin, not a dispatch failure
in the host. Each half is checked where it is written; only the merge is cast.

## What a plugin may and may not do

- **It namespaces everything with its id.** Tables `<id>_*` (hyphens dropped), job types
  `<id>.verb`, CASL subjects, prompt/agent/feature keys, query-key roots `<id>:…`, the API prefix
  `/api/<id>`, the CLI command `<id>`, AG-UI CUSTOM events `<id>.` — **never `kit.`**, which is the
  kit's namespace and may grow in a later release. The id itself is `^[a-z][a-z0-9-]*$` and never
  contains `rocketflare`: a plugin is written in KIT vocabulary so `applyReplacements` can translate
  it into a renamed app on the way in, and an id carrying the kit's name would be rewritten with
  everything else.
- **It has exactly four published entries** — `src/plugins/<id>/index.ts`, `<id>/ui/index.ts`,
  `packages/shared/src/plugins/<id>/index.ts` and `apps/cli/src/plugins/<id>/index.ts`. Everything
  else under it is private, which is what lets its semver cover a knowable surface. **No deep import
  across a plugin boundary**, in either direction, except the five barrel lines;
  `tests/config/plugins.test.ts` is the check. (`plugin.json` is the surface ANCHOR, read by the
  tooling, never imported.)
- **It ships no migration.** The HOST generates it once the schema barrel line exists:
  `pnpm db:generate --name plugin-<id>-<version>`, read the SQL, `pnpm db:migrate`. A plugin's own
  `migrations/` holds plain-SQL DATA fragments (backfills), never DDL — a kit or plugin migration
  copied in replaces drizzle's notion of current state with one that has never heard of the app's
  own tables.
- **It edits no toml and no `package.json`.** A binding, cron or `[vars]` key it declares in
  `plugin.json` is added to BOTH tomls by hand (`.claude/rules/cloudflare.md`) until Phase B's
  provisioning reads them.
- **It never renames anything across releases** — expand/contract only. `drizzle-kit`'s rename
  prompt has no non-interactive answer, so a rename stops an unattended install dead.
- **It composes, never redefines.** `grants` are additive over its own subjects; hooks are
  post-commit, idempotent and best-effort; `agentTools` are appended after the kit's. A change to
  the kit's own tables, to auth, to tenancy or to a cross-cutting middleware is a CORE change.
- **Its shared module imports no composer at runtime** (`ai/agents.ts`, `jobs.ts`,
  `permissions.ts`, `features.ts`, `realtime.ts`). Those five read the shared barrel, so importing
  one back closes a cycle, and two zod modules in a cycle crash at module evaluation rather than
  failing to compile. Whole-declaration `import type` is fine; `import { type X } from` is not.
  The same shape bites on the web side, where the barrels are read at MODULE SCOPE by
  `queues/jobs.ts`, `agents/registry.ts`, `prompts.ts`, `scheduled.ts`, `api-prefixes.ts` and
  `access.ts`: the two avoidances `example-feature` uses are `import type` for anything only needed
  as a type (`AgentToolContext`, `Tool`) and naming a file DIRECTLY rather than a barrel that
  re-exports the plugin (`db/schema/feature-flags`, not `db/schema`).

## Installing one by hand (until `pnpm plugin add`, Phase B)

1. Copy the plugin's three trees in at the identical paths (`apps/web/src/plugins/<id>/`,
   `packages/shared/src/plugins/<id>/`, `apps/cli/src/plugins/<id>/`).
2. Write the five barrel lines — an import and a tuple entry in each of `server.ts`, `ui.ts`,
   `packages/shared/src/plugins/index.ts`, `apps/cli/src/plugins/index.ts`, and one `export *` in
   `schema.ts`.
3. Add its surface to `.rocketflare.json` (`kind: 'plugin'`, its `anchor`, `paths`, `registries`
   and `source.repo`), or `.rocketflare.local.json` when installing into the kit itself.
4. `pnpm db:generate --name plugin-<id>-<version>` → read the SQL → `pnpm db:migrate`.
5. Any binding, cron or `[vars]` key from its `plugin.json` into BOTH tomls (+ `.dev.vars.example`).
6. `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

Removing one is the same list backwards: delete the trees, delete the five lines, delete the
surface, then `pnpm db:generate` emits the `DROP TABLE`s. Orphaned tables are not a stable state.
Phase B's `pnpm plugin add|remove` writes all of it and shows the plan before `--apply`.

## Adding a SLOT to the seam

A slot is a new field on `ServerPlugin`, `UiPlugin`, `SharedPlugin` or `CliPlugin`. Four steps, and
the last two are not optional:

1. The field on the interface, in `plugins/types.ts` (or the shared/CLI one), with a doc comment
   saying what it merges into and what the host does NOT do for it.
2. The consumer reads the widened list and merges it. If it opens a CLOSED set, follow the one
   pattern: the kit's literal becomes `CORE_X` and `X = [...CORE_X, ...plugin X]`, so the public
   name never moves and only where you ADD to it does.
3. A case in `tests/config/plugins.test.ts` (or the kit test that owns that registry) — written as
   a pure helper exercised with a FIXTURE, because a structural rule that only runs when a plugin is
   installed means nothing in a kit with none.
4. `docs/CONCEPTS.md` §16 and the matching `.claude/rules/*.md`, in the same commit.

Slots deliberately NOT on the interface: anything that would let a plugin change what a role may do
(`cannot`), write a migration, or edit a toml. Cross-plugin registries go through
`ServerPlugin.extensions` (`Record<string, readonly unknown[]>`) — `unknown[]` at the core boundary
is the point: the owning plugin narrows with zod and fails loudly, and the kit stays ignorant of
what anyone means by a "cube".

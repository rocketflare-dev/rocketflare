# The plugin seam (D31)

A plugin is a **separate git repository copied into an app** — never installed from npm, exactly
like the kit itself — that contributes contracts, schema, routes, jobs, agents, UI and CLI commands.
This directory is the host half: the types, the two web barrels, and every installed plugin's tree.
`docs/CONCEPTS.md` §16 is the decision record; `example-feature/` is the worked example.

The whole seam is **six barrel lines**. Installing a plugin is writing them; removing it is
deleting them. Nothing else in the kit ever names a plugin, which is what makes both reversible.

| Barrel | Exports | Read by |
|---|---|---|
| `packages/shared/src/plugins/index.ts` | `SHARED_PLUGINS` / `sharedPlugins` | the five composers: `ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts`, `realtime.ts` — plus `apps/web/src/config.ts` |
| `server.ts` | `SERVER_PLUGINS` / `serverPlugins` | `api/index.ts`, `utils/routes/api-prefixes.ts`, `queues/jobs.ts`, `scheduled.ts`, `agents/registry.ts`, `agents/tools/index.ts`, `prompts.ts`, `permissions/abilities.ts`, `utils/db/tenant-helpers.ts`, `services/access.ts`, `scripts/seed.ts`, the `rls-coverage` and unscoped-allowlist tests (never `db/schema/rls.ts` — a cycle) |
| `ui.ts` | `UI_PLUGINS` / `uiPlugins` | `App.tsx`, `SideNav.tsx`, `SettingsLayout.tsx`, `lib/query-keys.ts`, `pages/agents/forms/index.ts` |
| `schema.ts` | one `export *` per plugin | one `export *` line in `db/schema/index.ts` (position irrelevant — a duplicated name is TS2308) |
| `worker-exports.ts` | one `export *` per plugin | one `export *` line in `src/worker.ts` — the Worker's ENTRY module, which is the only place Cloudflare resolves a binding's `class_name` from |
| `apps/cli/src/plugins/index.ts` | `CLI_PLUGINS` / `cliPlugins` | `cli.ts` |

**The two `export *` barrels carry an empty marker.** `schema.ts` and `worker-exports.ts` declare
no const, so removing the last plugin would leave a file with no top-level export — which
TypeScript reads as a SCRIPT rather than a module, making its one importer TS2306 and stopping the
whole app typechecking. `addBarrelLine` displaces `export {}` and `removeBarrelLine` puts it back,
byte for byte.

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
  across a plugin boundary**, in either direction, except the six barrel lines;
  `tests/config/plugins.test.ts` is the check. (`plugin.json` is the surface ANCHOR, read by the
  tooling, never imported.)
- **It reaches the Worker's entry through the barrel, never by editing it.** A Durable Object or
  Workflow class is bound by `class_name` against the named exports of `src/worker.ts` and nowhere
  else, so a plugin shipping one puts `apps/web/src/plugins/<id>/worker-exports.ts` in its tree —
  a file that re-exports its classes and nothing else — and lists their names in `workerExports`.
  `plugin add` writes the barrel line; `plugin check` asserts the file exports every declared name.
  The `[[durable_objects.bindings]]`, `[[workflows]]` and `[[migrations]]` blocks stay the HOST's
  and are written by `pnpm provision cloudflare <env>` from the same manifest.
- **It ships no migration.** The HOST generates it once the schema barrel line exists:
  `pnpm db:generate --name plugin-<id>-<version>`, read the SQL, `pnpm db:migrate`. A plugin's own
  `migrations/` holds plain-SQL DATA fragments (backfills), never DDL — a kit or plugin migration
  copied in replaces drizzle's notion of current state with one that has never heard of the app's
  own tables.
- **It edits no toml and no `package.json`.** A binding, cron or `[vars]` key it declares in
  `plugin.json` is written into BOTH tomls by `pnpm provision cloudflare <env>`
  (`.claude/rules/cloudflare.md`) — including a `workflow` or `durable_object` block and, for a
  Durable Object, its `plugin-<id>-v1` `[[migrations]]` tag. The host owns every byte of its own
  files; the plugin only declares.
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

## Installing, upgrading and removing one

`pnpm plugin` (`scripts/plugin.mjs`) does all of it, and **every command prints its plan and stops
until `--apply`** — installing a plugin gives it full Worker and database access, so it is as
trusting as merging a pull request, and the plan is what a person says yes to.

```bash
pnpm plugin add <repo|path>[@ref] [--subdir <dir>] [--local]   # read the plan
pnpm plugin add <repo|path>[@ref] --apply                      # then install it
pnpm plugin upgrade <id> [--to <ref>] [--apply]                # its own releases, not the kit's
pnpm plugin remove <id> [--archive] [--apply]
pnpm plugin list · pnpm plugin check · pnpm plugin export <id> <dir>
```

`add --apply` copies the three trees (translated into this app's names by the same token map the
rename used), copies the plugin's release notes to `docs/plugins/<id>/upgrades/`, writes the six
barrel lines, installs the dependencies the manifest declares, and records the surface — in
`.rocketflare.json`, or in the git-ignored `.rocketflare.local.json` sidecar with `--local` and
always inside the kit itself. Exit codes: 0 ok · 1 error · 2 usage · 3 unreachable with no cached
mirror · 4 rejects remain (upgrade) · 5 no `rocketflare-plugin.json` at the source · 6 a
requirement is unmet · 7 the target path exists.

**What it will not do, ever**, and each is in the plan instead: generate or copy a migration
(`pnpm db:generate --name plugin-<id>-<version>` is yours, after the barrel line exists), edit a
wrangler toml or write a resource id (a declared binding, cron or `[vars]` key is printed with the
row you have to place), or apply anything you have not read.

A file in a plugin's repository that falls outside `apps/web/src/plugins/<id>/`,
`packages/shared/src/plugins/<id>/`, `apps/cli/src/plugins/<id>/`, `docs/plugins/<id>/`,
`migrations/`, `docs/upgrades/` or its own root metadata is a **refusal**, not a warning: an
install has to stay reversible by deleting a directory. The exception is the plugin REPOSITORY's
own tooling — `.github/`, `.claude/`, `scripts/`, `package.json`, `.gitignore` — which is neither
copied nor refused, because a plugin repo needs a CI workflow (half of decision 5) and a copy of
`release.mjs` to cut a release with.

`remove` deletes the trees, the six lines and the surface, then `pnpm db:generate` emits the
`DROP TABLE`s — which is correct here; the kit's warning is about importing a foreign SNAPSHOT, not
about your own barrel shrinking. `--archive` first writes a `--custom` migration copying each table
into schema `archive`. Orphaned tables are not a stable state.

**Authoring loop.** A local PATH is read directly rather than mirrored, so
`pnpm plugin add ../rocketflare-plugin-approvals --local --apply` installs a working copy, you edit
it in place with the host's own tests running on every `pnpm test`, and `pnpm plugin export
<id> <dir>` copies it back out with a regenerated `rocketflare-plugin.json`. `pnpm plugin check`
audits every installed plugin — anchor present, kit range satisfied, required plugins present, the
barrel line there for each half that is on disk, no `*.rej`, and a migration naming it when it
declares tables.

**A VENDORED plugin is upgraded by `pnpm kit:upgrade`, not by this script.** `example-feature`'s
`source.repo` is the kit's own repository with no subdirectory, so the kit release that moves it
forward is the one that moves it — and for the same reason its `requires.kit` range is not checked
(the same release cut both, so the range describes the kit it shipped inside).

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

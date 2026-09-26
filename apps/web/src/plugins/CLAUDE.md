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

- **It namespaces everything with its id.** Tables prefixed with the id's first hyphen-separated
  segment (`example-feature` → `example_*`, `analytics` → `analytics_*`; a longer prefix is welcome,
  not required — the prefix is a convention, and the CHECK is that no two installed plugins declare
  the same table name), job types
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
- **It declares compatibility as a FLOOR and a MEASUREMENT, never a prediction.** `minKit` is one
  bare `X.Y.Z` at the TOP level of `plugin.json` — the oldest kit it supports, with no ceiling,
  because a plugin cannot know which future kit will break it. `uses` is the host symbols it
  imports, written by `pnpm plugin export` and **never by hand**; the kit emits what it provides as
  the `## Surface ledger` block of `docs/plugin-api.md`, and compatibility is `uses \ ledger`. The
  old `requires.kit` range and `requires.pluginApi` version are refused by name, as is `minKit`
  nested under `requires` — one spelling, read in one place, and a misplaced one fails loudly
  rather than being quietly repaired.
- **It never renames anything across releases** — expand/contract only. `drizzle-kit`'s rename
  prompt has no non-interactive answer, so a rename stops an unattended install dead.
- **Its unauthenticated routes live under `/api/hooks/<id>` and nowhere else** (D34,
  `ServerPlugin.publicMounts`). Mounted before the authed table with no `authMiddleware` and no
  gate; the handler builds `publicCtx(c)` (no tenant, no auth fields), PROVES the caller —
  `verifyState` over a token it minted, a stored per-subscription secret, the provider's
  signature — and only then names the tenant that proof carried. It re-checks its own flag with
  `ctx.features(tenantId)` (a `requireFeature` gate reads `auth.features`, which does not exist
  here) and answers by enqueueing. `tests/config/plugins.test.ts` refuses a public mount outside
  the plugin's own `/api/hooks/<id>` and any authed mount under `/api/hooks`.
- **It puts text into the knowledge base through `ingestDocument` / `ingestDocumentFile`**, never
  by writing `documents` rows (D34). Pass `source: '<id>:<kind>'` and the item's upstream
  `externalId`, and a re-sync UPDATES the row rather than adding one; `deleteIngestedDocument`
  removes it. Visibility defaults to the whole organisation — a plugin syncing ONE person's data
  passes the owner's `userId` + `visibility: 'groups'` + `groupIds: []` (owner and admins only).
  A plugin that ingests declares `requires.surfaces: ["feature-knowledge"]`.
- **It composes, never redefines.** `grants` are additive over its own subjects; hooks are
  post-commit, idempotent and best-effort; `agentTools` are appended after the kit's (async
  allowed, `[]` for a tenant that has not turned the tool on, a throw is logged and skipped). A
  tenant credential goes through `sealSecret`/`openSecret`, never crypto of its own. A change to
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

**Every step it does not do is CLASSIFIED**, because an install is performed by an agent as often
as by a person and prose an agent may skim is not a control:

- **declarative** — nobody does it; the tooling does. These do not appear in the plan at all. The
  barrel lines, a declared binding, cron, route prefix or `[vars]` key, and a Durable Object's
  `[[migrations]]` tag are all here, which is why the plan is short.
- **agent** — an instruction PLUS the assertion that proves it ran. Every one carries `run`,
  `expect` and `assert`.
- **human** — a decision the tooling stops for: a secret's VALUE, a migration containing `DROP`,
  `--archive`, retiring a Durable Object namespace, deleting a live Cloudflare resource.

`--json` emits the same plan as data, with `kind` on every step, so a human step is a field rather
than a sentence in a paragraph. `pnpm plugin check --json` does the same for the audit.

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
<id> <dir>` copies it back out with a regenerated `rocketflare-plugin.json`.

## `pnpm plugin check` — the audit, written for an agent

**Every finding is `<file>:<line> <what is wrong> — <the exact change>`.** Saying only what is
wrong is right for a person with `reference.md` open beside them and useless to an agent, who has
only the line — and installs are performed by agents as often as by people, which is the same
observation that retired "by hand" from the step taxonomy. The line number appears only when the
thing complained about is AT a place in a file; a fabricated one sends a reader somewhere real and
wrong.

Per installed plugin: the anchor exists and parses; **every manifest field**, naming the field and
its legal values; `minKit`, `requires.surfaces` and `requires.plugins`; **every symbol in `uses`
against the kit's ledger**; a barrel line for each half on disk and no line for a half that is not;
no `*.rej`; a migration naming it when it declares tables; **every declared dependency really
present in the host `package.json`**; the **worker-exports barrel both ways**; **a tenant-isolation
test** when it declares tenant-scoped tables; and **`hooks.onTenantDeleted` when it declares a
`durable_object`**.

Two of those deserve their reason stated. The isolation test is the kit's one non-negotiable that
the kit itself cannot write — `docs/CONCEPTS.md` §16 and `.claude/rules/testing.md` both require
it *because the kit cannot* — and the check is structural, so it proves such a test EXISTS rather
than that it is right, and says so in the message. And a `durable_object` is state the FK cascade
cannot reach: a deleted tenant's DO state outlives it, and no other check can see that, because
its tables are gone and everything else reads as clean.

**There is no longer a tier a plugin opts into.** The audit used to warn rather than fail for a
plugin that declared no `requires.pluginApi`, because a released plugin could not retroactively
declare one. That field is gone with the prediction it encoded, and nothing left here is a rule a
released plugin cannot satisfy by being re-exported — so every installed plugin is checked
strictly. `--json` still carries `failures` and `warnings` as separate lists, because `ok` has to
keep meaning "this exits 0". CI runs the same command a person runs, so the local oracle and the
gating oracle cannot disagree.

**Two checks were DELETED rather than relaxed**, because each failed a plugin whose code was
correct: the anchor's version against the surface's (the anchor is now written by `plugin add` from
the source manifest, so they cannot differ), and the installed version against the `defaultPlugins`
pin (the gate already installs each default plugin at its pinned ref and runs the whole suite on
the result, which is the real proof).

**A VENDORED plugin is upgraded by `pnpm kit:upgrade`, not by this script.** `example-feature`'s
`source.repo` is the kit's own repository with no subdirectory, so the kit release that moves it
forward is the one that moves it — and for the same reason its `minKit` floor is not checked (the
same release cut both, so the floor describes the kit it shipped inside).

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

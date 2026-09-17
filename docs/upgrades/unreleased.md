---
version: unreleased
previous: 0.4.0
date: null
breaking: false
migrations:
  - "example_notes, a tenant-scoped table with two indexes, two foreign keys and an RLS policy"
areas: [shared, api, ui, cli, db, config, docs, scripts, provisioning]
touches_surfaces: [example-feature]
requires_surfaces: []
manual: false
---

## What changed

**The kit gained the seam a plugin plugs into (D31, PR A1 of four).** A plugin is a separate git
repository copied into an app — never installed from npm, exactly like the kit itself — that
contributes contracts, routes, schema, UI, agent tools, jobs and CLI commands. This release adds the
host half of that contract; nothing is extracted into a plugin yet, and an app with no plugins
installed behaves exactly as it did.

Five barrels, each shipping an `as const` tuple that one line per installed plugin goes into, plus
the types they hold. (`pnpm plugin add|remove` writes those lines — see B1–B2 below; an install is
those five lines, a surface entry and one `pnpm db:generate`.)

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

**Then the kit's own demonstration feature became a PLUGIN (PR A3 of four)** — the reference
plugin of decision 3, and the first thing installed through the seam A1 and A2 built. It is the
answer to "what does a plugin look like", and it is meant to be deleted.

`example-feature` now owns, in three directories and five barrel lines, everything it used to
scatter across the kit:

| Was | Is now |
|---|---|
| `CORE_FEATURES` / `CORE_FEATURE_FLAGS` entry | `SharedPlugin.features` |
| `EXAMPLE_FEATURE` in `ui/lib/feature-guards.ts` | `EXAMPLE_FEATURE_GUARD` beside the route and nav item it gates |
| the route in `App.tsx`, the item in `SideNav.tsx`, `ui/pages/ExampleFeature.tsx` | `UiPlugin.routes` / `UiPlugin.nav` + a lazy page under the plugin |
| `example.ping` in `CORE_JOB_VARIANTS` + `queues/handlers/example-ping.ts` | `SharedPlugin.jobs` + `ServerPlugin.jobHandlers`, renamed **`example-feature.ping`** |
| the demo flag row in `scripts/seed.ts` | `hooks.seedDemo` |

And it GAINED the parts a flag alone could not demonstrate: a tenant-scoped `example_notes` table
(`tenantRef` + `timestamps` + `tenantIsolation`, indexes led by `tenant_id`), a CRUD mount at
`/api/example-feature` behind `requireFeature`, `hooks.onTenantCreated`, an agent tool
(`list_example_notes`) on every run's `ctx.tools`, and two CLI commands
(`rocketflare example-feature ping|notes list`). So schema migration, tenant isolation and the four
lifecycle slots are all proven on something an adopter can delete in one command.

**`CORE_FEATURES` is now EMPTY, and that changes one contract.** `FEATURES` may legitimately be an
empty list, so `FeatureName` can be `never` and `featureNameSchema` can no longer be a `z.enum`
(which needs a non-empty tuple). It is now `z.string().refine(v => FEATURES.includes(v))` — the same
runtime check and the same output type, and it validates against what is INSTALLED rather than
against what was compiled in.

**One A2 derivation was wrong and is fixed here.** `(typeof SHARED_PLUGINS)[number]['agentKeys']`
reads a property off `as const` LITERALS, and a plugin that omits an optional field genuinely has no
such property — so installing a plugin with no agents was a compile error in `ai/agents.ts`, for
every other plugin. `DeclaredBy<P, K>` (`@rocketflare/shared/plugins`) narrows the union to the
members that DO declare the field first; with none it is `never`, which is exactly the empty
contribution these derivations want. All six sites use it (`agentKeys`, `promptKeys`, `jobs`,
`subjects`, `features`, `queryKeys`), as do `AgentKeyOf` and friends.

Two kit tests stopped borrowing a key they do not own. `tests/config/features.test.ts` and
`tests/api/feature-flags.test.ts` each register their own fixture flag now: the kit ships no flag,
`featureFlags.key` is PLATFORM state with `tenant_feature_overrides` cascading off it, and two files
resetting one key would delete each other's rows across tenants. The API one is `// @vitest-isolate`
because it mutates the shared registry. `tests/ui/feature-flag-nav.test.tsx` MOVED into the plugin
(`src/plugins/example-feature/tests/ui/`) — the nav item it looks for is the plugin's, and a test
that outlived it would be a false failure. Three assertions that pinned the exact agent-tool list
became prefix assertions, because a plugin's tools are appended after the kit's three.

**Finally, the docs caught up (PR A4 of four)** — no code, so nothing to apply, but it is where the
seam is explained rather than merely shipped. `docs/CONCEPTS.md` gains **§16 Plugins**: what a
plugin is and why it is copied rather than installed, the five barrels and the four published
entries, every slot and the kit registry it feeds, the `CORE_X` pattern, `DeclaredBy`, the
namespacing rules, the anchor/surface model with the sidecar and `skipped-plugin-owned`, "a plugin
tests its behaviour; the host tests that it is a well-formed plugin", the two measured constraints
(no runtime import of a composer; `relations()` for own tables only), the visibility registry, the
hooks, the host-generates-migrations rule, `example-feature` as the reference, the decisions table
and the known gaps. Sections 5, 12, 13, 14 and 15 were corrected where A2 and A3 made them untrue.
`docs/ADAPTING.md` §3 is rewritten around "write it as a plugin", and the layer rules
(`.claude/rules/*.md`) and the per-directory `CLAUDE.md` files name the plugin slot beside the core
location for each layer.


---

**Then the lifecycle became a script (PR B1–B2).** Phase A left the seam wired and one plugin
vendored into it, but installing a second one was five barrel lines, a hand-written surface entry
and a `db:generate` — every step of which is exactly the sort of thing that is done slightly
differently the second time. `scripts/plugin.mjs` (`pnpm plugin`) is now the whole lifecycle:

| Command | Does | Exit |
|---|---|---|
| `add <repo\|path>[@ref] [--subdir] [--local] [--apply]` | mirror a plugin repository (a local PATH is read directly — that is the authoring loop), read `rocketflare-plugin.json`, check `requires` three ways, refuse any file outside the plugin's four roots, **print the plan and stop** unless `--apply`; on apply copy the trees through `applyReplacements`, copy its notes to `docs/plugins/<id>/upgrades/`, write the five barrel lines, `pnpm add` its declared dependencies and append the surface | 0 · 5 no manifest · 6 requirement unmet · 7 target exists |
| `upgrade <id> [--to] [--from] [--apply]` | the kit-upgrade pipeline pointed at the PLUGIN's repository: classify, translate, `apply.patch`, `reference/`, `plan.json`, per-file `--reject` fallback; stamps `source` and `history[]` only on a clean apply | 0 · 4 rejects · 6 |
| `remove <id> [--archive] [--apply]` | refuses while another installed plugin requires it; deletes the trees, the barrel lines and the surface; `--archive` first writes a `--custom` migration copying each table into schema `archive` | 0 · 6 |
| `list` / `check` | what is installed; and the audit — anchor present, kit range satisfied, required plugins present, a barrel line for every half that is on disk, no `*.rej`, a journal entry naming the plugin when it declares tables | 0 · 1 |
| `export <id> <dir>` | copy an installed plugin back out as a plugin repository, with a regenerated `rocketflare-plugin.json` | 0 |

Common: 1 error · 2 usage · 3 unreachable with no cached mirror. Every command refuses a dirty tree
(`--allow-dirty`), and **none of them applies anything without `--apply`** — decision 1 says
installing a plugin is as trusting as merging a pull request, so the plan is what a person says yes
to.

Three refusals are the design rather than politeness. **It never copies a migration**: the host runs
`pnpm db:generate --name plugin-<id>-<version>` once the schema barrel line exists, because a
foreign snapshot describes a whole cumulative schema that has never heard of the app's own tables.
**It never edits a wrangler toml or writes a resource id**: a declared binding, cron, `[vars]` key
or `workerExports` class is a numbered row in the plan for a person to place. And **a file outside
`apps/web/src/plugins/<id>/`, `packages/shared/src/plugins/<id>/`, `apps/cli/src/plugins/<id>/`,
`docs/plugins/<id>/`, `migrations/`, `docs/upgrades/` or the repository's own root metadata is a
refusal, not a warning** — an install has to stay reversible by deleting a directory. (A plugin
repository's own `.github/`, `.gitignore` and `package.json` are recognised and simply not copied:
a plugin needs CI of its own, and its dependencies are declared in the manifest and installed into
the HOST's packages.)

**A VENDORED plugin is the kit's.** `source.repo` equal to the kit's own repository with no
subdirectory — which is `example-feature` — means `plugin upgrade` prints "upgrade it with
`pnpm kit:upgrade`" and exits 0, and `requires.kit` is not checked at all. The same release cut
both, so that range describes the kit the plugin shipped inside rather than a claim about
compatibility; checking it would make the kit fail `plugin check` against itself for the whole of
any release that raises it.

**`pnpm kit:upgrade` learned the other half.** It prints the installed plugins before it classifies
anything, exits **6** when the target kit version leaves an installed plugin's `requires.kit` range
(three honest answers: stay, remove the plugin, or `--force` with eyes open), and annotates a kit
change to any file in a plugin's `registries[]` as **`touches-plugin-registry`** — the five barrels
are shared, so the kit can move ground under a plugin, and the conflict would otherwise land on
somebody who wrote neither side.

**Four helpers moved out of `scripts/upgrade.mjs` into `scripts/lib/`** so both scripts run one
pipeline rather than two that drift: `git-lib.mjs` (the git wrappers, `ensureMirror`, `mirror()`,
`collectChanges`, `collectRenames`, `notesBetween`, `makeWriter`) and, pure beside it,
`plugin-lib.mjs` (the id rules, the five barrel definitions and the idempotent sorted line writer,
the file-root classification, `checkRequirements`, the surface builder, `archiveSql` and the plan
text). `upgrade-lib.mjs` gained `satisfies(version, range)` — a 40-line semver matcher for
`>=`/`>`/`<=`/`<`/`=`/bare/`^`/`~`/`*` and space-separated conjunctions, which THROWS on anything
else rather than guessing, because a silent `false` reads as an incompatible plugin and a silent
`true` installs one. `upgrade.mjs` also now reads the manifest through `readManifest()`, so a
plugin recorded in the sidecar is visible to it.

**The platform half of an install is provisioning's, not a hand edit.** A plugin's `bindings[]`,
`crons[]`, `apiPrefixes[]` and `vars[]` become ONE numbered step in the plan — `pnpm provision
cloudflare <env>` per environment — and a `secret: true` var becomes a `.dev.vars.example` key plus
`pnpm provision secrets <env>`; `remove` prints the inverse and removes none of it, because
provisioning has no delete-block op and a live bucket is not something a script drops because a
directory went. A binding whose `type` is outside `kv | queue | r2` is refused at INSTALL, naming
the type. That list lives twice — `plugin-lib.mjs` for the plain-Node install script and
`apps/web/scripts/provision/plugin-resources.ts` for provisioning — and `plugin-lib.test.ts`
asserts they are identical, so narrowing one without the other fails the suite. The provisioning
side is its own entry (see the Decision-12 section of this release).

**`scripts/release.mjs` is parameterised by repository kind.** `releaseContext()` answers
`kit | app | plugin`, and a PLUGIN repository — a checkout with a `rocketflare-plugin.json` at its
root and no `.rocketflare.json` — cuts releases with the same machinery: the same four headings,
the same `previous` chain, the same `CHANGELOG.md` section, stamping that manifest's `version` (and
its `package.json` if it has one) instead of `kit.version`. `releaseNotes(notesDir)` takes its
directory for the same reason. `scripts/changelog-nudge.mjs` fires in a plugin repository too, with
the sentence adjusted: a host absorbs a plugin release by reading its notes, so a release with none
is the same permanent gap.

Tests: `tests/config/plugin-lib.test.ts` (the id rules, the barrel writer — including a
byte-identical round trip against all five REAL barrels, since an install that leaves a lint diff
cannot be committed — the file-root refusals, `checkRequirements` and the vendored skip, the surface
builder, the plan text, and an end-to-end `export` → re-badge → `add` in a temp directory asserting
a plan run writes nothing at all) and a table of 27 `satisfies` cases in `upgrade-lib.test.ts`.

**Provisioning learns a plugin's platform declarations (D31, Decision 12).** A plugin ships no
wrangler toml — the two files are the host's, always — so its `plugin.json` declares what the
Cloudflare account has to provide, and `pnpm provision cloudflare <env>` now applies it instead of
a human editing both files by hand.

- **New: `apps/web/scripts/provision/plugin-resources.ts`** — the one owner of the naming rule and
  the one validator of the four platform declarations. Resources are
  `<app>-<id>-<name>[-staging]`, and `<APP>_<ID>_<NAME>[_STAGING]` for a KV namespace (mirroring the
  kit's own `<APP>_RATE_LIMIT[_STAGING]`); the `binding` name is identical in both environments.
  Supported `type`s are `kv`, `queue`, `r2`. Anything else — `d1`, `vectorize`,
  `analytics_engine`, `hyperdrive` — is a **loud refusal naming the type**, never a silent skip: a
  binding quietly not created is a Worker that deploys and then 503s on its first request.
  `hyperdrive` is refused deliberately — the host owns the one database.
- **`plugin.json` gains a documented shape for four fields** that were declared but unread:

  ```json
  "bindings":    [{ "type": "kv", "binding": "APPROVALS_CACHE", "name": "cache" },
                  { "type": "queue", "binding": "APPROVALS_QUEUE", "name": "jobs", "consumer": true },
                  { "type": "r2", "binding": "APPROVALS_FILES", "name": "files" }],
  "crons":       ["30 * * * *"],
  "apiPrefixes": ["/approvals-hook"],
  "vars":        [{ "key": "APPROVALS_MAX_ITEMS", "example": "50" },
                  { "key": "APPROVALS_WEBHOOK_SECRET", "example": "", "secret": true }]
  ```

  `secret` is new and defaults to false: a non-secret var is a `[vars]` key in both tomls, a secret
  one is a Worker secret offered by `pnpm provision secrets <env>`.
- **`cf-provision.sh` takes a resource list** rather than its fixed four. The kit's Hyperdrive, KV,
  Queue and R2 are the default list and its CLI is unchanged; `PLUGIN_RESOURCES` (a JSON array of
  `{ type, name, binding }`, in the ENVIRONMENT — nothing in it is secret and nothing is left on
  disk) appends to it. The connection-string redaction rule is untouched.
- **`patch-toml.ts` gains four byte-preserving, idempotent ops**: insert-or-update a binding block
  (`[[kv_namespaces]]` / `[[queues.producers]]` + `[[queues.consumers]]` / `[[r2_buckets]]`, placed
  after the last block of the same kind, or appended at the end of the file when there is none),
  append a cron, append a `[vars]` key (after the last assignment in the table, and never rewriting
  an existing key's value), and append a `run_worker_first` prefix as both `p` and `p/*`. A
  DIFFERENT existing id or name for the same `binding` is refused unless `--force`.
- **`pnpm provision cloudflare <env>`** writes the declarations into **both** tomls first (binding
  blocks with a `<PLACEHOLDER>` KV id, crons, `[vars]` keys, `run_worker_first` prefixes), then
  creates that environment's resources and patches its ids. Both files, because the ordinary parity
  test compares those across the pair on every `pnpm test`; the other environment's placeholder is
  refused by `REQUIRE_PROVISIONED=1` until it is provisioned too — exactly how `<HYPERDRIVE_ID>`
  already behaves.
- **`wrangler-parity.test.ts`** applies the same rules to plugin resources through the pure
  `pluginParityIssues()`, exercised against a FIXTURE plugin and fixture tomls as well as against
  what this checkout has installed — with `example-feature` declaring nothing, an installed-only
  assertion would pass because there is nothing to check.

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
   these files like any other source file, and a plugin you install later will be translated on
   the way in by `pnpm plugin add` (until that script lands, translate it as you copy it).

**A3 asks two things of an app that kept the demo.** If you still have `example-feature` wired into
your own `CORE_FEATURES`, `App.tsx`, `SideNav.tsx` and `jobs.ts`, you have a choice: take the plugin
whole (the three directories, the five barrel lines, the `.rocketflare.json` surface and
`pnpm db:generate`) and delete your copies, or keep your copies and skip the plugin entirely — in
which case leave your `CORE_FEATURES` entry where it is, since `featureNameSchema` works either way.
**If you queue `example.ping` anywhere, it is now `example-feature.ping`** and it only exists with
the plugin installed; the old type will fail `jobInputSchema` at the producer, which is the loud
failure you want rather than a message nothing handles.

**This release adds a migration, and the host generates it — the kit's own
`0012_plugin-example-feature-0.1.0.sql` is NOT ported** (`kit:upgrade` never applies a kit
migration). After the plugin's files and the schema barrel line are in place, run
`pnpm db:generate --name plugin-example-feature-0.1.0` and then `pnpm db:migrate`; you should get
exactly one `CREATE TABLE "example_notes"` with its two indexes, two foreign keys and one RLS
policy, numbered in your own journal.

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


**B1–B2 add no schema and no dependency.** Take `scripts/plugin.mjs`, `scripts/lib/git-lib.{mjs,d.mts}`
and `scripts/lib/plugin-lib.{mjs,d.mts}` whole, plus the edits to `scripts/upgrade.mjs`,
`scripts/release.mjs`, `scripts/release-check.mjs`, `scripts/changelog-nudge.mjs` and the two test
files. Two things the patch cannot do for you:

1. **The root `package.json` gains `"plugin": "node scripts/plugin.mjs"`.** That file is on the
   manifest's `manual` list, so the upgrade will not edit it.
2. **`.gitignore` already covers `.upgrade/`**, which is where the plugin mirrors and artifacts now
   live too (`.upgrade/plugins/<repo>.git`, `.upgrade/plugins/work/<id>/<ref>/`). If you narrowed
   that entry, widen it back.

If you had written your own helper around `scripts/upgrade.mjs`, note that `ensureMirror`,
`collectChanges`, `collectRenames`, `notesBetween` and the artifact writer are no longer defined in
it — they are imported from `scripts/lib/git-lib.mjs`, with `ensureMirror(repo, dir, options)`
taking the mirror directory as an argument and RETURNING the mirror handle.

**Provisioning (Phase B, step 3).**

1. Take the four changed provisioning files (`apps/web/scripts/provision.ts`,
   `apps/web/scripts/provision/patch-toml.ts`, the new
   `apps/web/scripts/provision/plugin-resources.ts`, `apps/web/scripts/cf-provision.sh`) and the two
   test files. They are kit core; a copy with no plugins installed behaves exactly as before.
2. The comment near the bindings in both `wrangler*.toml` is cosmetic — take it or leave it.
3. If you have a plugin installed that needs a KV namespace, queue or bucket, add its `bindings[]`,
   `crons[]`, `apiPrefixes[]` and `vars[]` to its `plugin.json` in the shape above and run
   `pnpm provision cloudflare staging` then `pnpm provision cloudflare production`, then
   `pnpm types` and commit `apps/web/worker-configuration.d.ts`.

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
- `packages/shared/src/permissions.ts` and `features.ts` (A3) — `CORE_FEATURES` and
  `CORE_FEATURE_FLAGS` are now empty and `featureNameSchema` is a refined `z.string()`. An app with
  flags of its own keeps them inside those two literals and needs no other change.
- `apps/web/src/ui/App.tsx`, `SideNav.tsx` and `ui/lib/feature-guards.ts` — the example route, nav
  item and `EXAMPLE_FEATURE` const are deleted. If you edited the nav around that item, the deletion
  will reject; remove your copy by hand.
- `packages/shared/src/jobs.ts` and `apps/web/src/api/queues/jobs.ts` — the `example.ping` variant
  and its handler entry are deleted, and `queues/handlers/example-ping.ts` with them.
- `apps/web/scripts/seed.ts` — the demo feature-flag row moved into the plugin's `seedDemo`.
- `apps/web/tests/api/{chat,chat-tools,agent-research,agent-tools}.test.ts` — four tool-list
  equality assertions became prefix assertions.


- `scripts/upgrade.mjs` — the largest edit of B1: about 120 lines of git plumbing are gone and the
  call sites now use a `kit` mirror handle (`kit.show(to, path)`, `kit.commitOf(ref)`,
  `kit.latestTag()`). A local edit inside one of those helpers has nowhere to go back to; move it
  into `scripts/lib/git-lib.mjs`.
- `scripts/release.mjs` — `main` now reads a `releaseContext()` and stamps a LIST of version files.
  An app that taught it to bump another file adds an entry to that list.
- `scripts/release-check.mjs` — `releaseNotes()` takes an optional `notesDir`; a caller passing
  nothing is unaffected.
- `package.json` (root) — one new script, in a file you own.

Provisioning (Phase B, step 3):

- `apps/web/scripts/provision/patch-toml.ts`: `patchBindingId` was renamed `patchBindingKey` and
  takes the key (`id` / `queue` / `bucket_name`) as an argument; its intervening-line pattern is now
  `[^\n]+` rather than `[^\n]*`, so a match can no longer run past a blank line into the next block.
  If you extended that file, re-apply on top of the new signature.
- `apps/web/scripts/cf-provision.sh`: the four inline creation blocks became `ensure_hyperdrive`,
  `ensure_kv`, `ensure_queue` and `ensure_r2` functions driven by one loop over the resource list.
  Any local edit inside those blocks moves into the matching function.
- `apps/web/tests/config/wrangler-parity.test.ts` gains imports from `../../scripts/provision/*`.
  A copy that rewrote the parity test will reject that hunk; the new `describe` is self-contained
  and can be appended by hand.

## Verify

`pnpm lint && pnpm typecheck && pnpm test && pnpm build` at the root, with
`git status --porcelain apps/web/worker-configuration.d.ts` empty. Then, specifically:

- `pnpm db:generate` emits **nothing** AFTER you have generated and applied
  `plugin-example-feature-0.1.0`. A2 by itself adds no table; A3 adds exactly one.
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
- The example feature behaves as it always did for a reader: with `example-feature` off under
  Admin → Feature flags there is no nav item, no `/example-feature` page and
  `GET /api/example-feature/notes` is a 404 `feature_disabled` — for a global admin too. Turn it on
  and all three appear.
- `pnpm seed --demo` prints an `example-feature  2 notes, example-feature flag at 50% rollout` line
  and `/documents`-style pages are unaffected; `rocketflare example-feature ping --json` prints the
  queued envelope, and `wrangler dev` logs `example-feature.ping: pong`.
- `src/plugins/example-feature/tests/{api,ui,config}` run inside the host's own projects — the api
  file covers the 404 gate, CRUD, ownership, `onTenantCreated`, the enqueue and the tool, and pins
  that **tenant B can neither list, read nor delete tenant A's notes**.

Then, for B1–B2 specifically:

- `pnpm plugin --help` prints the six commands and the exit codes; `pnpm plugin list` shows
  `example-feature` with its version, repo and install date; `pnpm plugin check` exits **0** and
  says `example-feature` is vendored, so its `requires.kit` is not checked.
- `pnpm plugin upgrade example-feature` exits 0 and points at `pnpm kit:upgrade` rather than
  fetching anything.
- `pnpm plugin export example-feature /tmp/p` writes 20 files and a `rocketflare-plugin.json`;
  `pnpm plugin add /tmp/p --local` then exits **7** (`already installed`), which is the collision
  guard doing its job.
- `pnpm --filter @rocketflare/web test:config` is green, including `plugin-lib.test.ts` (36 cases)
  and `upgrade-lib.test.ts` (58).
- `node scripts/release.mjs 9.9.9 --dry-run` lists `package.json version` and
  `.rocketflare.json kit.version`, and writes nothing.

Provisioning (Phase B, step 3):

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build      # green
pnpm web exec vitest run --project config tests/config/plugin-resources.test.ts   # 19 passing
bash apps/web/scripts/cf-provision.sh --help                # usage line mentions PLUGIN_RESOURCES
```

With a plugin installed that declares a KV binding: `pnpm provision cloudflare staging` leaves a
`[[kv_namespaces]] binding = "<ITS_BINDING>"` block in **both** tomls, a real id in the staging file
and `<KV_<ID>_<NAME>_ID>` in production, `pnpm test` green, and
`REQUIRE_PROVISIONED=1 pnpm web test:config` failing on that placeholder until
`pnpm provision cloudflare production` runs.


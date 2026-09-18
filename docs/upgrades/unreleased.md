---
version: unreleased
previous: 0.6.1
date: null
breaking: true
migrations: []
areas: [api, ui, shared, db, cli, config]
touches_surfaces: [example-feature]
requires_surfaces: []
manual: false
---

## What changed

### Deleting a tenant now purges what the cascade cannot reach

**The FK cascade was never the whole story.** Until now `deleteTenant` was one
SQL `DELETE` plus a nudge, and the FK cascade in `tenantRef()` was the entire cleanup mechanism —
which is only the whole story for rows. R2 objects under `tenants/<id>/` were never removed, so
every deleted organisation left its uploads, avatars and knowledge originals in the bucket for ever.
That was a live bug, not a hypothetical.

Deletion is now two halves. The `DELETE` and its cascade are unchanged and still synchronous; a new
`tenant.purge` job on `JOBS_QUEUE` carries everything else. It runs each installed plugin's new
`ServerPlugin.hooks.onTenantDeleted(db, tenantId, env)` — best-effort and individually try/caught,
exactly like `onTenantCreated` — and then the kit's own purge of the R2 prefix.

Two orderings in `deleteTenant` are load-bearing and commented as such: the `JOBS_QUEUE` binding is
proved **before** the `DELETE`, because the purge is the only thing that can ever reach a deleted
tenant's state and a misconfigured deployment must fail while the tenant still exists to describe;
and the message is sent **after** the row is gone, so nothing is ever purged for an organisation
that still exists.

`StorageService` gained `listPage` and `deleteMany`. The existing `list` is now a loop over
`listPage`, so its behaviour is unchanged — but accumulating every key of a large tenant in a 128 MiB
isolate, and then spending one subrequest per object to delete it, is not something the purge could
do. `deleteMany` is one R2 call per page.

**Durable Object state is purgeable only because instance names are derived.** Nothing enumerates
the instances of a namespace, so state is reachable only where the KEYS are known: a plugin derives
every instance name from the tenant id, keeps the set finite, and the purge loops the names the
plugin DECLARES rather than trying to discover instances. `NotificationsHub` is already that shape.
A plugin wanting one DO per row cannot be purged under this rule; the escape hatch — a purge-intent
ledger, a `tenant_id` column with no FK so it survives the cascade — is documented on the hook and
deliberately **not built**.

### The release and plugin tooling

**`pnpm kit:release` could not cut a release.** `resolveDefaultPlugin` could only `git ls-remote` a
default plugin, which proves a ref exists but cannot read a file out of it — so every release failed
with "cannot read its requires.kit range" unless `--skip-plugin-check` was passed, which made the
check one that effectively did not exist. It now fetches the plugin at its pinned ref into the same
blobless bare mirror `pnpm plugin` already keeps and reads the manifest out of it, falling back to
the recorded surface when a ref predates the file and refusing outright when the manifest is not
JSON.

**Released history is verifiable again.** `release-check --tag 0.2.0` and `0.3.0` failed on
`feature-analytics`, a surface retired when analytics became a plugin — the test knew about retired
surfaces and the release gate did not. That list is now `retiredSurfaces` in `.rocketflare.json` and
both readers use it. An entry is never deleted: the note files it exempts are releases, and released
history is never rewritten.

Also: `requires` is refreshed from the plugin's manifest at the version being installed rather than
silently frozen at first install, and that range is checked *before* the upgrade applies;
`coreEdits` are re-applied on upgrade (and edits a new release no longer declares are reverted);
`plugin check` fails when an installed plugin's version differs from what `defaultPlugins` pins;
`satisfies` accepts `||` alternation and `>= 0.5.0`, and a malformed range now exits 6 rather than
throwing to a generic 1; an undeclared `requires.kit` records `null` rather than `'*'`, so an
undeclared plugin is no longer silently ungated; and the changelog check is anchored, so `## 0.6.10`
no longer satisfies a search for `## 0.6.1`.

Four duplicated statements of the porting-note schema became one `noteProblems()`; four copies of
`defaultPlugins` validation became one `scripts/default-plugins.mjs` both workflows call; and the
tag-versus-version check, which lived in three places including two inline shell steps in
`deploy.yml`, became one.

### The plugin surface is injected context, not imported symbols

**The documented plugin contract was "four published entries per plugin". The measured contract was
128 distinct (module, symbol) pairs across 55 kit modules** — including six-level relative climbs
into `apps/web/tests/**` — because `deepImportIssue` guarded core→plugin and plugin→plugin but not
plugin→core, the one direction that breaks when the kit moves.

Almost all of that sprawl was already a method in waiting. The kit injected context in five places
that were never recognised as a family, so they had drifted (`cfg` in the request and agent
contexts, `config` in the job and cron ones), and nearly every imported symbol already took that
context as its first argument. So the surface is now **one context family**: `RequestCtx`, `JobCtx`,
`CronCtx`, `ToolCtx`, `AgentCtx`, `WorkflowCtx`, `HookCtx`, `SeedCtx`, plus `DetachedCtx` for a
callback that runs outside a handler. Methods replace imports — `ctx.guard(...)`, `ctx.uuid('id')`,
`ctx.enqueue(...)`, `ctx.nudge(...)`, `ctx.page(...)`, `ctx.notFound(...)`.

**They are thin adapters over the kit's internal contexts, not the same objects**, which is what
lets the plugin surface stay still while kit internals move. It is also why standardising on
`config` cost no kit route a single edit: the adapter is the only place `cfg` is named.

`WorkflowCtx` encodes the rules a plugin would otherwise get wrong: `ctx.step(name, opts, fn)` hands
`fn` a fresh per-step `db`, everything is awaited, and a duplicate step name throws — the platform
otherwise replays the cached result, which reads as "the agent ignored my approval". Durable Object
access is `ctx.durableObject(binding, tenantId, key?)`, which builds the id itself, **so a plugin
never calls `idFromName`** and the tenant prefix is structural rather than conventional.

Two surfaces cannot be injected and are declared entries instead. **`@/db/schema/kit`** carries the
seven build-time symbols drizzle-kit needs at module scope (`tenantRef`, `timestamps`,
`tenantIsolation`, `RESOURCE_VISIBILITY_VALUES`, and `tenants`/`users`/`groups` as FK targets); it
sits beside `rls.ts`, not above it, because of the cycle that file already documents. **`uiKit` is
split in two**: `@/plugins/api/ui-wiring` is what a plugin's `ui/index.ts` may import, and
`@/plugins/api/ui` is for lazy pages only — not new policy, just a name for the rule
`uiEntryIssues` already enforced, because the UI entry ships in the main bundle for every reader.

**The test harness is `@testkit`**, two entries: integration (the database, bindings, `request`,
`json` and the fixtures) and unit (`makeRequestCtx`, `makeJobCtx`, `makeCronCtx`, `makeWorkflowCtx`,
`makeToolCtx`). It is registered in `tsconfig.json` and `vitest.config.ts` and **deliberately not in
`vite.config.ts`**, so importing it from `src/` fails the build rather than shipping fixtures to a
browser. **The builders refuse a fake `db`** — they require a handle blessed by `setupTestDatabase`,
tracked in a `WeakSet` rather than by shape, because `{ execute: vi.fn() }` passes a shape check and
is precisely the object the rule exists to refuse. A fake context may test branching, guards and
response shape; anything touching data is on real Postgres by construction. The cost, accepted and
stated: there is no fast database-free test of a data-touching handler.

**Enforcement is conditional on the plugin declaring `requires.pluginApi`** — declared means
strictly checked, undeclared means warned. That is not a transition hack; it is the permanent rule
for third-party plugins, and it dissolves a real circularity, because a plugin's CI resolves its
matrix from *released* kit tags and so cannot declare a version that does not exist yet.
Every failure names the file, the line and the exact replacement, because installs are performed by
agents and a diagnostic that only says what is wrong is useless to one.

### A plugin's classes reach the Worker through a sixth barrel

A plugin that ships a Durable Object or Workflow class used to declare `workerExports` in its
manifest, and the install plan **printed** "export { ApprovalsHub } … in apps/web/src/worker.ts".
**A printed instruction is not a mechanism.** An unattended install applies nothing it reads, so the
tree deployed without the class and answered every request that reached it with a binding error —
the same failure `coreEdits` was introduced to remove, one file along.

So `apps/web/src/plugins/worker-exports.ts` is now the sixth barrel — one `export *` per installed
plugin, written by `pnpm plugin add` and removed by `pnpm plugin remove`, exactly as `schema.ts` is
— and `worker.ts` carries one permanent line that names no plugin. `coreEdits` was not the fix
either: using it here would have every class-shipping plugin mutating `worker.ts`, which is
precisely what a barrel prevents.

**`workflow` and `durable_object` join the provisionable binding types**, and the rationale comment
for the refusal list now says why those two graduated and `d1`/`vectorize` did not — the barrel is
what makes a class reachable from the entry module, and the others still have no such mechanism.
`pnpm provision cloudflare <env>` writes `[[workflows]]` and `[[durable_objects.bindings]]` into
**both** tomls with the `-staging` account-scoped rule. Note that a DO binding's identity key in the
toml is `name`, not `binding` — the kit's own is `name = "NOTIFICATIONS_HUB"` — so a patcher keyed
on `binding` inserts a duplicate block on every run.

**Durable Object migration tags are append-only and host-owned.** *DO migrations are to `worker.ts`
what SQL migrations are to `db/schema`.* Installing writes `plugin-<id>-v1`; the manifest's required
`storage: 'sqlite' | 'none'` picks `new_sqlite_classes` versus `new_classes`; an existing tag is
never rewritten, because it records what this Worker has already told Cloudflare and renumbering one
loses a namespace.

**"By hand" is retired as a phrase.** Every step the tooling does not perform is classified, because
an install is performed by an agent as often as by a person and prose an agent may skim is not a
control: **declarative** (the tooling does it — the barrel lines, bindings, crons, prefixes, vars
and the DO tag, all now absent from the plan entirely), **agent** (an instruction plus the assertion
that proves it ran — each carries `run`, `expect` and `assert`), **human** (a decision the tooling
stops for — a secret's value, a migration containing `DROP`, `--archive`, retiring a DO namespace,
deleting a live Cloudflare resource). `--json` on `add`, `remove` and `check` emits the same plan as
data with `kind` on every step, so a human step is a field rather than a sentence.

### Releasing a repository that holds several plugins, and proving one against a kit branch

`releaseContext()` already took a `root` parameter and was only ever called with its default, so a
repository whose manifests live in subdirectories and which has none at the root fell through to
`kind: 'unknown'` and exited 1. The parameter is now passed: `node scripts/release.mjs <version>
--plugin <subdir>`, repeatable. Repeatable rather than comma-separated because the value is a path,
and splitting a path on a comma invents an escaping rule for a character a path may legally contain.

`versionFiles` stamps the root `package.json` **plus every `rocketflare-plugin.json` in the
repository**, found by a bounded walk rather than a `plugins/*` glob, since `--plugin` takes an
arbitrary subdir. That is not cosmetic: `pnpm plugin check` compares the version recorded in an
installed surface against the anchor manifest, so a manifest left at an older number makes every
install of that plugin report a mismatch. Lockstep is the model and plain `X.Y.Z` tags follow from
it — no tag prefixes, no per-plugin namespacing, because a tag has to stay resolvable by
`git ls-remote`, which cannot resolve a bare SHA. Accepted cost: a fix to one plugin bumps every
plugin's version. `requires.pluginApi` stays per manifest, never hoisted — which kit contract a
plugin compiles against is a different question from which release shipped it.

**`release-check.mjs` auto-discovers rather than taking `--plugin`**: a gate you can forget to pass
a flag to is not a gate, and a plugin whose version nobody stamped is exactly what it catches. It
also needed `behaviourFiles(changed, { within })`, because `^(apps|packages)/` matches nothing
against `plugins/<id>/apps/web/…` — so the porting-note gate was silently passing in a monorepo,
which is the one place it had never been run.

**`plugin-ci.yml` gains `kit_ref` and `plugin_subdirs`.** `kit_ref` proves a plugin against a kit
**branch**, which is what makes a coordinated kit-and-plugin change verifiable rather than hopeful:
a plugin cannot declare `>=0.7.0` before 0.7.0 exists, so without it the two repositories can only
be cross-tested after one has already released. `plugin_subdirs` drives an **include-matrix of
`{kit, plugin}` pairs** — deliberately not a cross product, because each plugin is proved against
the kit versions its OWN range admits, and a shared ceiling is normal while a shared floor is not.

**`notify-plugins.yml` closes the gap that a kit release notified nothing.** There was no `schedule`
and no `repository_dispatch` anywhere, so a plugin outside `defaultPlugins` learned the kit had
moved whenever somebody next happened to push to it — for a stable plugin, months. A tag now
dispatches `kit-released`, with a weekly schedule as the backstop, and both are no-ops without
`PLUGINS_DISPATCH_TOKEN`.

### The plugin API has its own version, and a generated reference

`requires.kit` answers *which kit releases* a plugin works with. It cannot also answer *which API
surface it compiles against* — conflating the two is the root of the pin-drift this release is
fixing. So `PLUGIN_API = { current, minSupported }` is **two integers** in a zero-import leaf,
`packages/shared/src/plugins/contract.ts` (zero-import because everything under
`packages/shared/src/plugins/**` is forbidden from importing the five composers at runtime — two zod
modules in a cycle crash at module evaluation rather than failing to compile). Both integers are
mirrored in `.rocketflare.json` as `kit.pluginApi`, because a `.mjs` script cannot import a `.ts` —
the same deliberate duplication `SUPPORTED_PLUGIN_BINDING_TYPES` already lives with — and a test
pins the two together so they cannot drift.

**The comparison is integer, never a range**, and that is the point rather than a simplification: a
range language is what let a malformed `requires.kit` throw to a generic exit 1 instead of the
documented "requirement unmet". A plugin declares `requires.pluginApi`; **declared means strictly
checked, undeclared means warned.** That is not a migration hack — it is the permanent rule for
third-party plugins, and it dissolves a real circularity, because a plugin's CI resolves its matrix
from *released* kit tags and so cannot declare a version that does not exist yet.

**`docs/plugin-api.md` is generated by `scripts/plugin-api-doc.mjs`, committed, and diff-checked in
the gate** beside the existing `worker-configuration.d.ts` step — that was already the precedent for
a committed artefact that must not drift from its source. It does three jobs: **version
enforcement** (a changed or removed member with no bump to `PLUGIN_API.current` fails, naming the
member), **break attribution** (`used by`, derived from the plugins actually installed), and
**agent discovery** — a capability index, first in the file, so an agent writing a plugin reads one
document instead of inferring the surface from 19 module paths and 128 symbols. The gate step
carries `if: !inputs.plugins`, because the `used by` annotations legitimately change when
`defaultPlugins` are installed; it is a property of the checkout, like the secrets scan beside it.

One defect found while building it is worth stating, because it is the failure mode of every
generator that reads a type graph: run without `node_modules`, neither `zod` nor `drizzle-orm`
resolves, every inferred type silently degrades to `any`, and **the document generates cleanly while
recording a surface that is wrong** — handing the next person a dozen bogus "changed" entries and an
instruction to bump the version for a change nobody made. The generator now refuses to run without
dependencies and fails on any `TS2307`.

### `pnpm plugin check` becomes the agent's oracle

It checked six things and deliberately said what was wrong rather than how to fix it — right for a
person with `reference.md` open beside them, **wrong for an agent**, and installs are now performed
by agents as often as by people. It is now fifteen checks, every failure formatted
`<file>:<line> <what is wrong> — <the exact change>`, with `--json` carrying the same results and
**CI running the same check**, so the local and the gating oracle cannot disagree.

New: the anchor is valid JSON at all; every manifest field against its legal values (naming the
field, not "invalid manifest"); `requires.pluginApi`; `workerExports` in **both** directions (a class
the half does not export is a deploy Cloudflare refuses for a `class_name` nothing exports; a class
the manifest does not name is invisible to provisioning); a `durable_object` binding with no
`hooks.onTenantDeleted`; a declared dependency missing from the host's `package.json`; a declared
dependency whose range the host contradicts; and a plugin declaring tenant-scoped tables with no test
proving another organisation cannot read them.

That last one had been mandatory in prose since D31 and **enforced by nothing**. The check proves
such a test EXISTS, not that it is correct, and says so in its own message; combined with
`@testkit`'s refusal of a fake `db`, the cheap wrong version is now hard to write.

**Severity is two-tier.** Every NEW rule warns for a plugin declaring no `requires.pluginApi` and
fails for one that does. That is forced rather than chosen: the second gate pass installs a released
plugin predating all of this, which cannot be retroactively changed. The six pre-existing checks
stayed unconditional failures, and `warnings` is a separate list from `failures` so `ok` keeps
meaning "this exits 0".

**A dependency clash warns rather than refuses.** A plugin needing a newer major is how a shared
dependency moves at all, so refusing would make an ordinary upgrade impossible without editing
somebody else's manifest. It surfaces as a **human** step, plus `dependencyClashes` in `--json` and a
warning on stderr as `pnpm add` is about to overwrite the range.

**One install bug fixed**: `m.subdir ?? source.subdir ?? ''` falls through only on nullish, so a
manifest shipping `"subdir": ""` beat an explicit `--subdir` flag and recorded the surface as
root-relative, breaking `plugin upgrade` later. Hit for real installing from a monorepo.

**Comment-stripping is now the rule for every source-scanning check**, and this is the part worth
carrying into your own code. Three checks matched substrings against raw source, and one was
**pre-existing kit code** — `workerExports` tested `\b<name>\b`, which a class named only in a comment
satisfied. Another was caught by its own fixture, which passed while plainly breaking the rule.
**A structural check must read comment-free code, or it validates prose**; a green check that proves
nothing is worse than no check at all.

### Two plugins can no longer claim one table name

The kit said a plugin's tables are `<id>_*` "with the hyphens dropped". **Its own reference plugin
broke that rule** — `example-feature` ships `example_notes`, not `examplefeature_notes` — and the
rule was asserted in seven places including the reference plugin's own file header. An honest check
would have failed the kit's own example, which is why none was ever written.

The rule now says what is true and what matters: *every table starts with the first
hyphen-separated segment of its plugin's id (`example-feature` → `example_*`, `analytics` →
`analytics_*`); a longer prefix is welcome, not required; and two plugins must never collide.* The
prefix is a convention a human picks — every call site treats the id as a prefix for collision
avoidance and nothing anywhere derives a table name from an id, so a mechanical rule would buy no
mechanism, only a rename.

**The collision itself is now checked**, by `tableClashes` in `pnpm plugin check`, and it fails
**unconditionally** rather than through the warn/fail tier the other new rules use. The tier asks
"could a released plugin retroactively satisfy this?" — and here neither plugin is non-compliant
alone. The fault is the combination, and the host cannot run it either way.

**Why this was missing is the part worth reading.** The kit believed TypeScript was already catching
it: `example-notes.ts`, `db/schema/CLAUDE.md` and §16 all said a duplicate would surface as TS2308.
That is false. TS2308 is a duplicated export SYMBOL; two plugins calling `pgTable('orders', …)`
under different symbol names compile perfectly. A single `DROP TABLE` would then take the other
plugin's data. **A believed-in guarantee that does not exist is worse than a known gap**, because
nobody writes the check.

## How to apply

There is no migration and no schema change.

- **`deleteTenant` has a new signature**: `deleteTenant(db, tenantId, jobs, realtime?)`. The kit has
  one call site, `apps/web/src/api/routes/tenant.ts`. If you call it yourself, pass the queue
  binding — `c.env.JOBS_QUEUE` — as the third argument. It throws `JobsQueueNotConfiguredError`
  without one, by design.
- **If you implement `StorageService` yourself** (rather than using `createR2Storage`), add
  `listPage` and `deleteMany`. A test double is the likely case: the kit's own `MemoryR2Bucket`
  needed real cursor semantics, because a stub that always answers `truncated: false` makes a broken
  paging loop look correct.
- **If you removed the jobs queue**, you have removed tenant purging with it; keep your own cleanup
  on the delete path.
- A plugin holding tenant state outside Postgres should now declare `hooks.onTenantDeleted`. A
  plugin whose only state is its tables needs nothing — the cascade already took them.

**The tooling changes need nothing from you.** `.rocketflare.json` gains one additive key,
`retiredSurfaces`; if you have retired a surface of your own and carry an exemption for it in
`apps/web/tests/config/upgrade-notes.test.ts`, move that id into the new key and delete the local
list. If you call `satisfies` from your own scripts it is now `satisfiesResult(version, range)`
returning `{ ok, problem }`.

**If you have no plugins of your own, there is nothing to do.** The kit's own reference plugin,
`example-feature`, is migrated, and it is the worked example to read.

If you do have one, the migration is mechanical and the check tells you each edit:

1. Add `"requires": { "pluginApi": "1" }` to its `plugin.json`. Until you do, it is warned rather
   than failed — so you can migrate in your own time, but nothing is verifying it meanwhile.
2. Routes take `RequestCtx` (`const ctx: RequestCtx = requestCtx(c)`), job handlers `JobCtx`, cron
   tasks `CronCtx`, agent tools `ToolCtx`, hooks `HookCtx`/`SeedCtx`.
3. Schema files import from `@/db/schema/kit` — **by relative path**, because drizzle-kit bundles
   them and resolves no tsconfig path alias.
4. `ui/index.ts` imports only `@/plugins/api/ui-wiring`; pages import `@/plugins/api/ui`.
5. Tests import `@testkit/integration` and `@testkit/unit` instead of climbing into `tests/`.

**One TypeScript subtlety worth knowing before it costs you an afternoon**: `ctx.notFound(...)`
returns `never`, but TypeScript applies never-return narrowing only when every name in the call
target is explicitly annotated. `const ctx = requestCtx(c)` is inferred, so the guard throws at
runtime while the compiler still believes the row may be undefined. Annotate it —
`const ctx: RequestCtx = requestCtx(c)`.

**A plugin shipping a Durable Object or Workflow class** now needs three things, and
`pnpm plugin check` asserts all three: a `src/plugins/<id>/worker-exports.ts` re-exporting its
classes, those names listed in the manifest's `workerExports`, and `storage` on each
`durable_object` binding. A class in the barrel but not the manifest is invisible to provisioning;
the reverse is a binding pointed at nothing.

It must also declare `hooks.onTenantDeleted` — a Durable Object holds state the FK cascade cannot
reach, and the `tenant.purge` job above is what reaches it.

Then run `pnpm provision cloudflare <env>` once per environment; it is an `agent` step rather than a
declarative one, because the toml *editing* disappeared but somebody still has to run the command
against an account with credentials.

**Single-plugin repositories and the kit itself are unaffected** — `--plugin` is additive and
`releaseContext` is the identity when `root === repoRoot`.

For a repository holding several plugins: `node scripts/release.mjs <version> --plugin <subdir>`,
then `node scripts/release-check.mjs --tag <version>`, which discovers the rest. If you want a kit
release to notify your plugin repositories, add a fine-grained PAT as `PLUGINS_DISPATCH_TOKEN`
(Contents: read, Metadata: read on those repositories) and name them in `notify-plugins.yml`; the
receiving repository needs `repository_dispatch: types: [kit-released]` on its own workflow, or the
notification arrives and does nothing.

**Declare `requires.pluginApi` in your plugin's manifest.** It is `"1"` for this release, and
`example-feature` is the worked example. Until you declare it your plugin is warned rather than
failed, so you can migrate in your own time — but nothing is verifying it meanwhile.

**If you change a member of any declared entry**, regenerate and commit the document
(`node scripts/plugin-api-doc.mjs`) and bump `PLUGIN_API.current` — in both
`packages/shared/src/plugins/contract.ts` and `.rocketflare.json`. The gate fails otherwise, naming
the member, which is the whole point of the artefact being committed.

One limitation to know: a printed type over 300 characters is truncated in the ledger, so a change
beyond that point is not caught. Drizzle tables are exempt — they summarise to
`table "users" { id, email, … }`, which keeps the column names a plugin points a foreign key at
inside the checked region.

**Run `pnpm plugin check` after upgrading.** It is the fastest way to find what this release expects
of a plugin you own, because every failure carries its own fix. Declare `requires.pluginApi` to opt
into strict checking; until you do, the new rules warn rather than fail.

A reported dependency clash is information, not an error: decide whether your plugin or the other
declaration should move, and edit the manifest that should lose.

**Check your own plugins' table names against each other** — `pnpm plugin check` now does it for the
installed set, but only once they are installed together. Renaming a table is an expand/contract
migration, so finding a clash late is expensive.

If you documented the old "hyphens dropped" rule anywhere in your own app, correct it; nothing
enforced it and nothing ever will.

## Conflicts to expect

`apps/web/src/api/services/tenants.ts` and `apps/web/src/api/services/storage.ts` if you have edited
either; both are core files the patch rewrites in place. `packages/shared/src/jobs.ts` gains one
variant in `CORE_JOB_VARIANTS` — if you have added job variants of your own the list will conflict,
and the resolution is to keep both. `apps/web/src/plugins/types.ts` gains one optional field.

`scripts/lib/upgrade-lib.mjs`, `scripts/lib/plugin-lib.mjs`, `scripts/plugin.mjs`,
`scripts/release.mjs` and `scripts/release-check.mjs` are substantially rewritten; an app that has
edited any of them should expect rejects and re-apply its own change on top. `.github/workflows/`
loses two inline shell steps in favour of `scripts/default-plugins.mjs`.

`apps/web/src/plugins/types.ts`, `apps/web/tests/helpers/plugins.ts`, `apps/web/vitest.config.ts`
and `apps/web/tsconfig.json` all change. If you deleted `example-feature` (it exists to be deleted)
every file under it is dropped from the patch, which is the intended behaviour and not a failure.
`apps/web/src/ui/components/shared/index.ts` gains exports, and `LoadingIndicator` moves into that
barrel.

`apps/web/src/worker.ts` gains one line. `scripts/plugin.mjs` and `scripts/lib/plugin-lib.mjs` are
substantially rewritten again (the plan builder and the barrel table), so an app that has edited
either should expect rejects. `apps/web/tests/helpers/plugins.ts` gains `worker-exports` in both
`BARRELS` and `RESERVED_PLUGIN_IDS` — without both, that barrel reads as a plugin named
`worker-exports` and its own export line reads as a deep import into one.

`scripts/release.mjs`, `scripts/release-check.mjs` and `scripts/lib/upgrade-lib.mjs` are
substantially rewritten. `.github/workflows/plugin-ci.yml` gains two inputs and restructures its
matrix — note that a plugin repository pinning `plugin-ci.yml@main` cannot use either input until
this release reaches the kit's default branch.

`.rocketflare.json` gains `kit.pluginApi` and `.github/workflows/gate.yml` gains one step. Neither
conflicts with an app's own edits unless you have restructured that workflow.

`scripts/plugin.mjs` and `scripts/lib/plugin-lib.mjs` are substantially rewritten — three separate
workstreams touched them this release — so an app that has edited either should expect rejects and
re-apply its own changes on top. `.github/workflows/ci.yml` gains a job.

`docs/CONCEPTS.md` §§13 and 16 are substantially rewritten and gain decisions 14–22.
`.claude/rules/*.md`, both `CLAUDE.md` plugin sections and the three skills change wording.
`scripts/lib/plugin-lib.mjs` and `scripts/plugin.mjs` gain the collision check.

## Verify

Delete a tenant that owns an uploaded file, then check the bucket:

```bash
pnpm --filter @rocketflare/web exec wrangler r2 object list <app>-files --prefix "tenants/<id>/"
```

Under `wrangler dev` the consumer runs in-process, so the same terminal logs
`tenant.purge: removed N object(s)`. Running the job a second time must delete 0 and still ack —
that is the idempotency the at-least-once delivery depends on.

The two checks that were broken:

```bash
node scripts/release.mjs <next> --dry-run     # passes WITHOUT --skip-plugin-check
node scripts/release-check.mjs --tag 0.3.0    # no longer reports 'feature-analytics'
```

The contract enforces itself, so the check is to break it deliberately:

```bash
# in any plugin file — the failure must name the file, the line and the replacement
echo "import { tenantIsolation } from '../../../db/schema/rls'" >> <a plugin file>
pnpm --filter @rocketflare/web test:config     # fails, naming the edit
```

And the bundle boundary — **which the two builds protect asymmetrically, so check both**:

```bash
# add `import '@testkit/integration'` to a file under apps/web/src/ui/
pnpm --filter @rocketflare/web build:ui    # FAILS: Rollup cannot resolve it. The alias is
                                           # deliberately absent from vite.config.ts.

# add the same import to a file under apps/web/src/api/
pnpm --filter @rocketflare/web build:api   # SUCCEEDS — and that is the point. wrangler resolves
                                           # tsconfig paths, so the kit is bundled rather than
                                           # refused: measured at +866 KB on a 1.98 MB Worker.
```

So on the API side the build is **not** the protection — `tests/config/plugins.test.ts`'s source
scan is, and it is the only thing standing between a stray import and 866 KB of test fixtures in
production. Do not weaken that scan on the assumption the bundler will catch it.

The barrel's round trip, which is the property that makes an install reversible:

```bash
pnpm plugin add <a plugin declaring workerExports> --apply
pnpm plugin remove <id> --apply
git diff --exit-code apps/web/src/plugins/worker-exports.ts   # must be byte-identical
```

`removeBarrelLine` has to be the exact inverse of `addBarrelLine`, including restoring the
`export {}` empty marker — a file with no top-level export is a script, not a module, and TypeScript
answers TS2306 at its one importer.

```bash
node scripts/release.mjs <next> --dry-run    # in the kit: byte-identical output to before
```

And in a monorepo, the resolve step of `plugin-ci.yml` is worth exercising directly rather than
trusting — **YAML that parses says nothing about an embedded shell-quoted node script**, which is
the only kind of break that file can have, since it never runs on a push to the kit itself. The
script is therefore written to a file in the WORKSPACE, not `$RUNNER_TEMP`: ESM resolves a relative
specifier against the module's own directory, so the same file one directory away would look
identical and never find the kit.

The version gate, which is the check that makes the number mean anything:

```bash
# delete a member from any context, e.g. RequestCtx.uuid in plugins/api/http.ts
node scripts/plugin-api-doc.mjs      # exit 3: "removed  @/plugins/api :: RequestCtx.uuid"
```

And the generator must be idempotent — running it twice leaves no diff.

Point it at a plugin you have deliberately broken — a manifest field with a bad value, a
`workerExports` name nothing exports, a `durable_object` binding with no `onTenantDeleted`, a missing
isolation test:

```bash
pnpm plugin check           # one line per failure, each naming the file and the exact edit
pnpm plugin check --json    # the same results as data, warnings separate from failures
```

The human and `--json` forms must report identically, and CI runs the same check.

```bash
pnpm plugin check    # with two plugins installed that declare the same table name:
                     # names both plugins, the shared table, and says to rename one and release it
```

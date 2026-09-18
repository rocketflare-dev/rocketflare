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

**A deleted tenant's state outside Postgres is now deleted too.** Until now `deleteTenant` was one
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

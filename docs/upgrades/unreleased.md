---
version: unreleased
previous: 0.6.1
date: null
breaking: true
migrations: []
areas: [api, shared, config]
touches_surfaces: []
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

## Conflicts to expect

`apps/web/src/api/services/tenants.ts` and `apps/web/src/api/services/storage.ts` if you have edited
either; both are core files the patch rewrites in place. `packages/shared/src/jobs.ts` gains one
variant in `CORE_JOB_VARIANTS` — if you have added job variants of your own the list will conflict,
and the resolution is to keep both. `apps/web/src/plugins/types.ts` gains one optional field.

`scripts/lib/upgrade-lib.mjs`, `scripts/lib/plugin-lib.mjs`, `scripts/plugin.mjs`,
`scripts/release.mjs` and `scripts/release-check.mjs` are substantially rewritten; an app that has
edited any of them should expect rejects and re-apply its own change on top. `.github/workflows/`
loses two inline shell steps in favour of `scripts/default-plugins.mjs`.

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

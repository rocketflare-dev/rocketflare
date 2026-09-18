---
version: unreleased
previous: 0.6.1
date: null
breaking: true
migrations: []
areas: [api, shared]
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

## Conflicts to expect

`apps/web/src/api/services/tenants.ts` and `apps/web/src/api/services/storage.ts` if you have edited
either; both are core files the patch rewrites in place. `packages/shared/src/jobs.ts` gains one
variant in `CORE_JOB_VARIANTS` — if you have added job variants of your own the list will conflict,
and the resolution is to keep both. `apps/web/src/plugins/types.ts` gains one optional field.

## Verify

Delete a tenant that owns an uploaded file, then check the bucket:

```bash
pnpm --filter @rocketflare/web exec wrangler r2 object list <app>-files --prefix "tenants/<id>/"
```

Under `wrangler dev` the consumer runs in-process, so the same terminal logs
`tenant.purge: removed N object(s)`. Running the job a second time must delete 0 and still ack —
that is the idempotency the at-least-once delivery depends on.

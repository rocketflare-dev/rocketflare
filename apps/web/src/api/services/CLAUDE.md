# Services

Plain modules; routes validate → authorise → call a service → respond. AI lives in `ai/`
(`ai/CLAUDE.md`), agent runs in `agents/` (`agents/CLAUDE.md`).

## Shape

- Signature `(db, cfg, logger, …args)` — dependencies are passed, never imported as process
  globals. No service reads `c.env`, `process.env` or a module-level `config`
- A binding (KV, Queue, R2, AI) is a parameter typed from `Cloudflare.Env`. A service that
  **queues** takes it after the logger — `createInvitation(db, cfg, logger, jobs, input)`,
  `decideAccessRequest(db, cfg, logger, jobs, input)` (`jobs: JobsQueue`, a structural slice so
  tests pass a `RecordingQueue`). A service that **nudges** takes `realtime?: Realtime` trailing
  (`updateTenant(db, tenantId, patch, realtime?)`, `notify(db, input, realtime?)`) or inside its
  `input` (`changeMemberRole`, `removeMember`, `acceptInvitation`)
- Storage routes build the seam themselves: `createR2Storage(c.env.FILES)` → `StorageService`, 503
  `storage_not_configured` without the binding
- The only paths to a binding: `jobs.ts` (`enqueueJob`) → `JOBS_QUEUE`, `realtime.ts` (`nudge*`) →
  `NOTIFICATIONS_HUB`, `ai/resolve.ts` → `ai_configs` / `agent_models` / `AI`, `agents/runs.ts` →
  `AGENT_RUN_WORKFLOW`
- **Deleting a tenant**: `deleteTenant` proves the queue binding (`requireJobsQueue`) BEFORE the
  `DELETE` — a deployment that cannot purge must fail while the tenant still exists — then enqueues
  `tenant.purge` with the id and slug (`../queues/CLAUDE.md`)
- `utils/db/tenant-helpers.ts` `onTenantCreated` is post-commit: every installed plugin's hook, each
  best-effort in its own try/catch and handed `features`

## Realtime (`realtime.ts`)

- The **only** caller of `NOTIFICATIONS_HUB`: `nudge(realtime, event)` (tenant-wide),
  `nudgeUser(realtime, userId, event)`, `nudgeUsers(realtime, userIds, event)`, over the
  `Broadcaster` seam (`createHubBroadcaster(env)` → `idFromName(tenantId)` → typed RPC stub)
- Every nudge goes through `realtime.defer` (`waitUntil`), is never awaited on the response path and
  is a no-op without the binding. In a Workflow step there is no `waitUntil`: use
  `createStepRealtime()` and await `.settle()`
- Build events with `realtimeEvent(type, tenantId, payload?)`. Types and the query-key invalidation
  map (`REALTIME_INVALIDATIONS`) live in `@rocketflare/shared/realtime` — add a type there, never in
  a route. The payload is a nudge (`{ id }`, or `{ entity, id }` for `entity.changed`); the client
  re-queries
- Emit **after** the transaction commits (`acceptInvitation` defers its two nudges past the
  `db.transaction`)

## Visibility (`access.ts`)

- `accessScopeOf(auth)` → `{ tenantId, userId, groupIds, bypass }` (`bypass` = `isAdminLevel`).
  A resource's predicate is **ANDed with the tenant predicate and never replaces it**; a hidden row
  is the SAME 404 as an absent one. `fullAccessScope(tenantId)` is for maintenance paths only
- A restrictable resource is a `VisibilityResource` (`{ key, noun, usageKey, predicate, setGroups,
  grantRows, countGrants }`): `CORE_VISIBILITY_RESOURCES` (documents) plus each plugin's
  `ServerPlugin.visibilityResources`, composed by the `visibilityResources()` FUNCTION.
  `setResourceGroups` / `grantsForResources` / `countGroupGrants` dispatch through it — never an
  `if (kind === …)` branch; an unknown kind throws. The 409 `group_in_use` count includes every one
- Drizzle: the EXISTS subquery uses a LITERAL alias (a column object renders with whatever table
  alias is in scope where the fragment lands — wrong rows, still compiles), and a raw predicate
  cannot go into `db.query.X.findFirst` (it renames the table) — use `db.select()`
- A value a plugin needs at module scope lives in the leaf `access-sql.ts` and is re-exported here,
  or the plugin barrel cycle leaves it `undefined` at import

## Feature flags (`features.ts`, `../../permissions/features.ts`)

- **One seam**: `resolveFeatures(cfg, flagRows, { tenantId, userId })` is the only place the two
  layers combine — `FEATURES_ENABLED` (fail-closed, consulted only for an `environmentGated` flag)
  and the `feature_flags` / `tenant_feature_overrides` rollout. A third source unions in there and
  no consumer changes. `[]` without a tenant
- **Keys are code**: `CORE_FEATURES` (`@rocketflare/shared/permissions`) + metadata in
  `CORE_FEATURE_FLAGS` (`@rocketflare/shared/features`). No migration; an orphaned row is inert;
  no create endpoint by design
- **`featureBucket` is a wire format** — changing the hash, separator or modulus reshuffles every
  live rollout (golden vectors in `tests/config/features.test.ts`). Never hash the percentage in:
  that is what keeps a rollout monotonic
- Admin CRUD is `routes/admin.ts` behind `globalAdminMiddleware`; the override sub-routes call
  `requireMultiTenant`, the list and `PATCH` do not. `GET /api/features` is the member-level
  effective list (and the CLI's — a Bearer key cannot reach `/api/admin/*`)

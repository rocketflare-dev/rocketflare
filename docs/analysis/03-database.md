# 03 — Database layer

Sources: `~/work/mirevue` (structural reference, Node + `pg` + Postgres RLS) and
`~/work/guidemode/apps/server` (Cloudflare substrate reference, Workers + Hyperdrive → Neon).
Target: a single-package, Workers-first, Mirevue-shaped kit.

Headline findings, in priority order:

1. **Mirevue's RLS is session-scoped, not transaction-scoped.** It works because every
   tenant-scoped request *pins one `pg.PoolClient`* for its whole lifetime and stamps
   `set_config('app.tenant_id', $1, false)` on it. Mirevue's own rollout doc forbids a
   transaction-mode pooler in front of it. **Hyperdrive is a transaction-mode pooler.**
   The mechanism does not port as-is; a transaction-scoped rewrite is feasible but untested.
2. **GM does no RLS at all** (predicate-only). Grep for `POLICY|rls|set_config|tenantIsolation|
   current_setting` across `src/ scripts/ migrations/` returns nothing relevant.
3. **GM's Worker DB client lifecycle is leaky**: a fresh `postgres()` client per request
   (and per workflow step / queue batch / cron), never `.end()`ed. Only `.end()` in `src/` is
   the test-cleanup path (`src/db/client.ts:73`).
4. Everything *around* RLS in Mirevue — `tenantIsolation()` helper, `db-roles.ts`, the
   catalog-driven coverage test, the `off|pin|enforce` rollout modes, boot-time posture log —
   is well built and should ship in the kit as the **documented upgrade path**, inert by default.

---

## 1. Drizzle client construction

### Mirevue — `src/db/client.ts`, `src/db/tenant-scope.ts`, `src/api/middleware/database.ts`

- Single driver, `pg` (node-postgres), `drizzle-orm/node-postgres`. `Database = NodePgDatabase<typeof schema>`
  (`src/db/client.ts:25`). Chosen explicitly because `drizzle(poolClient)` and `drizzle(pool)`
  produce the same type, so a pinned connection can be handed to any `db: Database` signature
  (`src/db/client.ts:8-22`).
- Every `Pool` is registered in a module `Set` so `closeDatabase()` ends *all* of them
  (`src/db/client.ts:70-93`); `DEFAULT_POOL_MAX = 10`, connection budget documented per replica
  (`src/db/client.ts:56-63`).
- `getSystemPool()` / `getDatabase()` are process-level singletons that rebuild after
  `closeDatabase()` (`src/api/middleware/database.ts:44-63`); `databaseMiddleware` sets the
  *owner* handle as `c.get('db')` (`:65-73`).
- Tenant handle is never ambient: `withAuthAndDb` calls `withTenantScope(tenantId, fn)` and passes
  `{ db, unscopedDb, scoped }` to the handler (`src/api/utils/routes/route-helpers.ts:75-135`).
  `scoped: ScopedRunner` re-enters a *fresh* scope for work that outlives the handler (SSE bodies,
  tool calls) via `AsyncLocalStorage.snapshot()` (`:121-122`).
- `ScopedRunner` / `scopedOn(db)` abstraction (`src/db/client.ts:40-53`) — a good seam to keep.

### GM — `src/db/client.ts`, `src/api/middleware/database.ts`

- Two drivers, autodetected by URL: `isNeonUrl()` = host contains `.neon.tech` or `neon.database`
  (`src/db/client.ts:24-26`) → `@neondatabase/serverless` `neon()` HTTP driver; otherwise
  `postgres` (postgres.js). `Database` is a **union type** of both drizzle DBs (`:18`), which the
  file admits is only "compatible at runtime".
- **Hyperdrive connection string acquisition** (`src/db/client.ts:97-127` and
  `src/api/middleware/database.ts:15-27`):

  ```ts
  const previewUrl = env.PREVIEW_DATABASE_URL
  const hyperdrive = c.env?.HYPERDRIVE as { connectionString?: string } | undefined
  const databaseUrl =
    previewUrl || (hyperdrive?.connectionString ?? getRequiredEnv(env, 'DATABASE_URL'))
  const db = createDatabase(databaseUrl)
  ```

  Precedence: `PREVIEW_DATABASE_URL` (per-PR Neon branch, bypasses shared Hyperdrive) →
  `env.HYPERDRIVE.connectionString` → `DATABASE_URL`. Hyperdrive's `connectionString` is a plain
  `postgresql://` URL to the local Hyperdrive proxy, so it goes to postgres.js, never the Neon
  HTTP driver (the Hyperdrive host does not match `isNeonUrl`). In `wrangler dev`,
  `localConnectionString` supplies it (`wrangler.toml:180-183`).
- **Lifecycle**: `createDatabase()` is called *per request* in the middleware, per invocation in
  `scheduled.ts:80`, `api/index.ts:581` (queue consumer), and repeatedly inside workflow steps
  (`api/workflows/change-scoring-workflow.ts:104,126,154,184,204`). No `ctx.waitUntil(sql.end())`
  anywhere. postgres.js opens lazily and Workers tear the socket down with the isolate, so this
  "works" but leaks connections into Hyperdrive's pool for the socket-idle window and re-pays
  connection setup on every request instead of reusing within an isolate.
- No `prepare: false`, no `max`, no `idle_timeout` options set on postgres.js
  (`src/db/client.ts:57`, `:119`). Hyperdrive supports protocol-level prepared statements (what
  postgres.js uses) but not SQL `PREPARE/EXECUTE`, so this is fine.
- `postgresClient` cleanup slot stores only the *last* client in test mode (`:11`, `:61-63`) — the
  same "only closes the last pool" bug Mirevue fixed with its `Set` (`mirevue/src/db/client.ts:65-69`).

### Kit decision

- **Base: GM's `createDatabaseWithHyperdrive` shape** (it is the one that knows about
  `env.HYPERDRIVE`), rebuilt with Mirevue's discipline:
  - one driver on the request path: **postgres.js over Hyperdrive** (Hyperdrive requires TCP;
    the Neon HTTP driver cannot use it). Keep `@neondatabase/serverless` only as an optional
    fallback for `PREVIEW_DATABASE_URL`/no-Hyperdrive dev, or drop it and require Hyperdrive
    `localConnectionString` everywhere → **single `Database` type** (`PostgresJsDatabase<typeof schema>`),
    killing GM's union type.
  - client built once per *request/invocation* in middleware, stored on `c.var.db`, and
    **ended in `c.executionCtx.waitUntil(client.end())`** after the response (or `finally` in
    workflows/queue/cron). Expose `createDatabase(url)` returning `{ db, close }`.
  - postgres.js options: `max: 5` per isolate is plenty (Hyperdrive is the real pool),
    `onnotice` filter (GM `src/db/client.ts:40-43`, minus the `pg_search` special case).
- Strip: `pg_search` notice filter, `PREVIEW_DATABASE_URL` unless the kit ships Neon-branch
  previews (recommend keeping the *hook*, it is three lines).
- Keep from Mirevue: `ScopedRunner`, `scopedOn`, `TenantScope*Error` classes, the "tenant handle
  is passed, never ambient" contract. Drop `AsyncLocalStorage` re-entrancy detection unless RLS
  enforce is enabled (Workers `nodejs_compat` does expose `AsyncLocalStorage`, so it *can* stay).

---

## 2. Schema conventions

Both repos: one file per table (or tight table group) under `src/db/schema/`, barrel `index.ts`,
`drizzle.config.ts` pointing at `./src/db/schema/index.ts`, out `./migrations`, `dialect: 'postgresql'`,
`strict: true, verbose: true` (mirevue `drizzle.config.ts:1-15`, gm `drizzle.config.ts:1-17`).

| Convention | Mirevue | GM | Kit |
|---|---|---|---|
| PK | `uuid('id').primaryKey().defaultRandom()` everywhere (`schema/keys.ts:9`) | same (`schema/keys.ts:8`) | uuid v4 via `defaultRandom()`; ULID not used anywhere — do not add |
| `tenantId` | `uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' })` | same | same, first index column always `tenant_id` |
| Timestamps | inconsistent: 23 of ~33 files use `withTimezone: true`; `keys.ts`, `tenants.ts`, `users.ts` are naive `timestamp` | naive `timestamp` | **standardise `timestamp(..., { withTimezone: true })`**; add a `timestamps()` spread helper (`createdAt`/`updatedAt`) — neither repo has one |
| extraConfig | **array form** `table => [index(...), tenantIsolation('x')]` (`schema/keys.ts:29-38`) | deprecated **object form** `table => ({ idx: index(...) })` (`schema/keys.ts:29-40`) | array form (required for `pgPolicy`) |
| Enums | `pgEnum` per file, exported (`schema/domains.ts:17-49`) | `pgEnum` | same |
| Relations | `relations()` next to each table | same | same |
| Types | `export type X = typeof x.$inferSelect / NewX = $inferInsert` (`schema/domains.ts:171-172`) | ad hoc | Mirevue pattern |
| Global tables | documented exceptions listed in `schema/CLAUDE.md` and `RLS_EXCLUDED_TABLES` | none formally | Mirevue pattern |
| Schema `CLAUDE.md` | table registry + RLS "READ THIS BEFORE ADDING A TABLE" section (`schema/CLAUDE.md`) | table registry by domain | Mirevue's, trimmed to the core tables |
| Rules file | `.claude/rules/database.md` (globs `src/db/**`, `migrations/**`) — multi-tenancy + RLS contract | `.claude/rules/server/database.md` — multi-tenancy + migration workflow + query patterns | Mirevue base; keep GM's "Query Patterns" snippet |

Core tables to carry into the kit (present in both): `tenants`, `users`, `user_sessions`,
`tenant_users` (composite PK, `role` enum), `keys` (hashed API keys, prefix, soft revoke via
`revokedAt`/`isActive`), `oauth_providers`, `tenant_settings`, `team_invitations`,
`notifications`. Mirevue's `tenant_users` additionally has `support`/`directory` roles and an
org-profile block (`schema/tenant-users.ts:26-78`) — strip the profile columns and `directory`, keep
`support` (it is the admin-into-customer-org mechanism). Mirevue `tenants.status` enum
(`active|suspended`) is worth keeping; GM's onboarding/`isOssCorpus` flags are product-specific.

Soft delete: neither repo has a generic `deletedAt` convention; `keys.revokedAt` is the only
soft-revoke. Do not invent one for the kit.

---

## 3. Row-Level Security (Mirevue) — in depth

### 3.1 The policy helper — `src/db/schema/rls.ts`

```ts
const TENANT_GUC = sql`nullif(current_setting('app.tenant_id', true), '')::uuid`

export function tenantIsolation(table: string, column = sql`tenant_id`) {
  return pgPolicy(`${table}_tenant_isolation`, {
    as: 'permissive', for: 'all', to: APP_ROLE,
    using: sql`${column} = ${TENANT_GUC}`,
    withCheck: sql`${column} = ${TENANT_GUC}`,
  })
}
```
(`rls.ts:36-44`). One shared predicate object on purpose: drizzle-kit diffs rendered SQL text, so
a per-table copy with a stray space emits 36 `ALTER POLICY` statements (`rls.ts:19-22`).
`membershipIsolation()` scopes `users` (no `tenant_id`) via
`id in (select user_id from tenant_users where tenant_id = <GUC>)` (`rls.ts:79-88`).
`tenants` is policied on `id` via the second argument (`schema/tenants.ts:22`).
`RLS_EXCLUDED_TABLES` lists the five unpolicied tables with reasons (`rls.ts:106-112`).
Generated SQL: `migrations/0039_brainy_bromley.sql` (`ENABLE ROW LEVEL SECURITY` ×30 +
`CREATE POLICY ... TO "mirevue_app" USING (...) WITH CHECK (...)`). No `FORCE ROW LEVEL SECURITY`
anywhere — owner bypass is what keeps auth paths, migrations and rollback working (`rls.ts:27-31`).
`drizzle.config.ts` deliberately does **not** enable `entities: { roles: true }`; the role is
created out-of-band (`rls.ts:6-9`).

### 3.2 How tenant context is set — `src/db/tenant-scope.ts:221-261`

```ts
client = await pool.connect()                       // PIN one PoolClient
const db = databaseFromClient(guard(client, scope))
await db.execute(sql`select set_config('app.tenant_id', ${tenantId}, false)`)  // is_local = FALSE
return await scopeStore.run({ tenantId, db }, () => fn(db))
// finally:
scope.open = false
await client.query(`select set_config('app.tenant_id', '', false)`).catch(() => {})
client.release()
```

**Mechanism: session-level GUC on a pinned connection.** `is_local = false` means the setting
survives across transactions for the life of the backend session; it is *not* transaction-scoped.
It is pool-safe only because (a) exactly one request holds the `PoolClient` at a time, (b) the GUC
is set unconditionally on entry so a failed reset cannot leak into the next occupant
(`tenant-scope.ts:239-244`), and (c) a `Proxy` over `client.query` throws `TenantScopeClosedError`
after release (`:275-320`). The proxy also serialises overlapping queries because a pinned client
is one connection (`pg@9` removes the internal queue) (`:299-310`), and is careful not to look like
a `Pool` so `db.transaction()` stays on the pinned connection (`:286-297`).

Consequence spelled out in Mirevue itself (`docs/RLS-ROLLOUT.md` §6): *"Never put a
transaction-mode pooler (PgBouncer in `transaction` mode) in front of this. The tenant is a
session-level GUC and does not survive a transaction boundary. Session mode only."* Pool size
becomes a hard concurrency cap (`tenant-scope.ts:20-25`: app 20 + system 10 + pg-boss 3 + NOTIFY 1).

### 3.3 The restricted role — `scripts/db-roles.ts`

- Role `mirevue_app` (`APP_ROLE_NAME`, `db-roles.ts:37`), created via SQL with
  `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`, per-role
  `statement_timeout 30s`, `idle_in_transaction_session_timeout 15s`, `lock_timeout 5s`
  (`:224-235`), `GRANT USAGE ON SCHEMA public`, `ALTER DEFAULT PRIVILEGES FOR ROLE <owner>` for
  tables and sequences (`:236-247`). Owner name is parsed from `DATABASE_URL`; app password from
  `APP_DATABASE_URL`, whose username *must* equal the role name (`:171-186`).
- **Two phases straddling migrations** (`:99-118`): `--phase=role` **before** `migrate.ts`
  (`CREATE POLICY ... TO mirevue_app` fails if the role is absent) and `--phase=grants` **after**
  (`GRANT ... ON ALL TABLES`, `GRANT ... ON ALL SEQUENCES`, then `REVOKE ALL` on the four
  infrastructure tables — must be last in the same transaction, `:258-300`). The grants phase
  throws if none of the REVOKE targets exist (wrong DB or migrations not run, `:290-299`).
- Role is created even with `APP_DATABASE_URL` unset — as `NOLOGIN`; LOGIN is only ever added,
  never removed (`:22-35`). Post-check asserts `rolsuper=false, rolbypassrls=false` (`:312-321`).
- Wired in `docker-entrypoint.sh:7-19` (role → migrate → grants → queue-init → fixtures → seed)
  and `package.json` `db:migrate` script; CI/test does the same in `tests/setup.ts:70-84`.

### 3.4 Rollout modes — `TENANT_SCOPE_MODE=off|pin|enforce` (`src/config.ts:23-24`, `docs/RLS-ROLLOUT.md`)

- `off` (default): `withTenantScope` returns the shared owner handle, byte-identical request path.
- `pin`: pins + stamps on the **owner** pool. RLS inert (owner bypasses) but the plumbing —
  pinning, GUC, lifetime guard, pool saturation → 503 — soaks in production. Caught 10 real
  failures in CI (`RLS-ROLLOUT.md` §3).
- `enforce`: pins on the **app** pool (`APP_DATABASE_URL`, required by config validation,
  `src/config.ts:160-164`). Boot-time `logTenantScopeStatus()` connects as the app role and asks
  Postgres `current_user`, `rolsuper`, `rolbypassrls`, `count(pg_policies)`; logs at `error` if
  inert (`tenant-scope.ts:143-212`). Rollback = set `off`; policies stay, nothing to migrate.
- Error mapping: Postgres `42501` → `TenantIsolationViolationError` (500, generic body),
  pool timeout → 503 (`src/api/utils/core/errors.ts:400-494`).

### 3.5 CI gates

- `tests/api/rls-coverage.test.ts` reads the **live catalog** (`pg_class`/`pg_attribute`/
  `pg_policy`), not the schema files: every table with a `tenant_id` must have RLS enabled and a
  policy naming the app role; the unpolicied set must equal `RLS_EXCLUDED_TABLES` exactly; every
  policy is `PERMISSIVE`, `ALL`, `WITH CHECK = USING`, contains the GUC predicate; the role has
  `rolsuper=false, rolbypassrls=false`; the four REVOKEd tables have no privilege (`:60-233`).
- `tests/api/rls.test.ts`: predicate-less queries return zero rows / raise `42501` under enforce;
  fail-closed when GUC unset; membership join semantics; pre-tenant auth paths still work on the
  owner pool (`:117-597`).
- `tests/api/tenant-scope.test.ts`: pinning properties under `pin` (transaction stays on the
  pinned backend pid, nested scope reuse, conflict, guard, pool saturation, serialisation).
- `tests/api/unscoped-allowlist.test.ts`: source-scans `src/` for `unscopedDb` call sites and pins
  the three allowed cross-tenant reads.
- The whole api suite runs under `enforce` (`.env.test` sets `APP_DATABASE_URL` +
  `TENANT_SCOPE_MODE`; `.github/workflows/ci.yml:57-66`).

### 3.6 Can this work over Hyperdrive → Neon from a Worker?

Evidence gathered from Cloudflare and Neon docs (fetched 2026-09-01):

| Constraint | Finding | Impact on Mirevue's design |
|---|---|---|
| Pooling mode | Hyperdrive pools in **transaction mode**; "a single Worker invocation may obtain multiple connections"; on return "the connection is RESET such that the SET commands will not take effect on subsequent queries" | **Session GUC + pinning is dead.** Every statement outside a transaction may land on a different backend with no `app.tenant_id` → fails closed (zero rows), not open — but the app is unusable. |
| `SET` inside a transaction | Supported "for the duration of a transaction or a query". Docs warn that wrapping many operations in one transaction to keep SET state "will affect the performance and scaling of Hyperdrive, as the connection cannot be reused" | A rewrite is possible: `BEGIN; select set_config('app.tenant_id', $1, **true**); ...; COMMIT` per request (`db.transaction(tx => ...)`). Pins for the transaction only, so the pool cap concern moves from Node to Hyperdrive. |
| Query caching | Hyperdrive caches "eligible read-only query responses"; docs are **silent** on whether reads inside a transaction or after `SET` are cached. Cache key is query text + params (comments ignored). `--caching-disabled` exists per config. | **Cross-tenant cache risk**: the predicate-less query RLS exists to catch has *identical* text and params across tenants; only the GUC differs. If Hyperdrive caches it, tenant B receives tenant A's cached rows. Predicated queries are safe (tenantId is a bound param). Either the spike proves transactional reads are uncached, or the RLS-mode Hyperdrive config **must** be `--caching-disabled`. |
| Unsupported | `LISTEN/NOTIFY`, advisory locks, SQL-level `PREPARE/EXECUTE/DISCARD`, "any modification to per-session state not explicitly documented" | Mirevue's `pg-notify.ts` and pg-boss don't port (kit uses Queues/DO — other subsystem). `cleanDatabaseForTestFile`'s `pg_advisory_lock` is local-test only. `set_config(..., true)` is transaction-scoped session state — documented as supported. |
| Neon roles | `neon_superuser` (what console/API/CLI-created roles get) has **BYPASSRLS**, CREATEROLE, `pg_read/write_all_data`. Roles created **via SQL** get only default `public` privileges and do not bypass RLS. There is no real superuser. | `db-roles.ts` already creates the role via SQL and asserts `rolbypassrls=false` — the right shape. The kit's owner role is a `neon_superuser` member (BYPASSRLS) *and* table owner, so "owner bypasses policies" still holds without `FORCE`. `ALTER DEFAULT PRIVILEGES FOR ROLE <owner>` works as owner. `db-roles.ts` must run against the **direct** Neon host (not `-pooler`), same as GM's `toDirectNeonHost` (`gm/scripts/migrate.ts:57-59`). |
| Connecting as non-owner via Hyperdrive | A Hyperdrive config carries **one** connection string (one role). | Enforce mode needs **two Hyperdrive bindings**: `HYPERDRIVE` (owner: auth, admin, migrations-adjacent reads) and `HYPERDRIVE_APP` (app role: tenant-scoped path). Both are cheap to create, but every request touching both pays two connection setups. |
| Latency | Sequential query cost through Hyperdrive: ~1–3 ms with Smart Placement near the DB, 20–30 ms from a distant region. | `BEGIN` + `set_config` + `COMMIT` add up to three round trips per request on top of the queries. With `[placement] mode = "smart"` (GM `wrangler.toml:27`) that is ~5–10 ms; without, 60–90 ms. postgres.js `sql.begin()` can't pipeline `BEGIN` with the first statement, but a simple-protocol multi-statement `BEGIN; select set_config(...)` with a regex-validated UUID could collapse two of them — spike item. |

**Verdict: ship predicates-only, with the RLS scaffolding inert and a defined spike.** See §9(b).

### 3.7 GM's posture

Zero RLS. Every query carries `eq(x.tenantId, tenantId)` by convention (`.claude/rules/server/
database.md` "Query Patterns"), the tenant comes from auth middleware, and there is no role
separation — the Hyperdrive config's single Neon role is a `neon_superuser`. This is the
production-proven CF baseline the kit starts from.

---

## 4. Migrations

| Aspect | Mirevue | GM | Kit |
|---|---|---|---|
| Generate | `pnpm db:generate` → `drizzle-kit generate` (`package.json`) | same | same |
| Apply script | `scripts/migrate.ts`: `pg.Client`, `drizzle-orm/node-postgres/migrator`, `waitForDatabase` retry ×30 | `scripts/migrate.ts`: autodetects Neon → `neon-http/migrator` on the **direct** host (`toDirectNeonHost` strips `-pooler`, `:33-59`), else postgres.js `max: 1` + `waitForDatabase` | **GM base** (Neon autodetect + pooler bypass are exactly the CF lessons), dropping the `neon-http` branch in favour of postgres.js against the direct host if the Neon package is removed |
| Ordering wrapper | `db:migrate` = `db-roles --phase=role && migrate && db-roles --phase=grants`; same in `docker-entrypoint.sh:7-19` | plain `db:migrate` | Mirevue's three-step, with role phases no-op'ing cleanly when RLS is off |
| CI | `ci.yml` runs tests (which migrate the throwaway Postgres); deploy = `docker compose pull/up`, entrypoint migrates at boot | `deploy-server.yml:119-121, 217-219`: `pnpm run db:migrate:ci` with `DATABASE_URL` from the GitHub Environment secret **before** `wrangler deploy`, staging on tag push, prod on release publish | **GM's** migrate-then-deploy job; add `db-roles` around it |
| Folder | `./migrations` + `meta/_journal.json`, 60 migrations, drizzle names | same, 210 migrations, several hand-named/hand-written (`0030_enable-pg-search.sql`, `0070_add_discovery_flow_facts.sql`, `0089_recreate_materialized_views.sql`) | `./migrations`, reset to `0000_init` |
| Custom SQL | `0011`: `CREATE EXTENSION IF NOT EXISTS vector`; `0025`-ish CHECK constraint "hand-edited migration" (`schema/domains.ts:180`) | `0030`: `DO $$ ... CREATE EXTENSION IF NOT EXISTS pg_search; CREATE INDEX ... USING bm25` guarded so local Postgres skips it | Kit ships **no** extension by default; document the "custom SQL migration" recipe (edit generated file, keep journal) |
| RLS SQL | Generated by drizzle-kit from `pgPolicy` (`0039`, `0040`, `0044`, `0046`, `0049`) — nothing hand-written | n/a | same as Mirevue (drizzle-kit `pgPolicy`) |
| Materialized views | none | physical fact tables created via SQL migration, refreshed by cron (`schema/materialized-views/index.ts:1-7`) | out of scope for kit |

Test migrations: both call the drizzle migrator directly from `tests/helpers/db.ts`
(`runTestMigrations`), swallowing "already exists" errors (mirevue `:73-96`, gm `:85-125`).

---

## 5. Seed / fixtures

- Mirevue `scripts/seed.ts`: idempotent (upsert by slug/email) demo tenant `acme` with
  owner/admin/member, a local global-admin owning their own org (`seedLocalAdmin`, `:74-127`),
  notifications, pending invitation, an API key printed once (`:tail`), then the global
  `rewired_chunks` fixture. Runs from `docker-entrypoint.sh` when `SEED_ON_START=true`.
  Reuses production helpers (`createTenantForUser` from `src/api/utils/db/tenant-helpers.ts`).
- Mirevue `src/db/fixtures/load-rewired.ts`: gzip NDJSON → bulk insert, idempotent by embedding
  model — product-specific, strip.
- GM: no `scripts/seed.ts`; instead an in-app `services/seed-data/` package
  (`seedRealisticWorkTrackingData`, `deleteAllWorkTrackingData`, factories/generators,
  `SEED_PRESETS`) used by tests and by a "create demo data" product feature. Product-specific.
- **Kit: Mirevue's `scripts/seed.ts`** trimmed to tenant + 3 users + local admin + API key.
  For Workers it stays a Node script run against `DATABASE_URL` (direct Neon or local), never
  from the Worker.

---

## 6. Test DB harness

| | Mirevue | GM |
|---|---|---|
| Compose | `docker-compose.test.yml`: `pgvector/pgvector:pg17`, port **5433**, `-c max_connections=300`, db `exec_test`, user `test` | `docker-compose.test.yml`: `paradedb/paradedb:latest`, port **5437**, db `guidemode_test`, user `test` |
| Strategy | **truncate once per run** (`TRUNCATE tenants, users RESTART IDENTITY CASCADE`, `tests/helpers/db.ts:102-105`), then every test creates *unique* data (`uniqueId()` suffixes, `tests/helpers/auth.ts:17-19`). No per-test rollback. Optional per-file truncate under an advisory lock (`:107-121`) | identical strategy (`tests/helpers/db.ts:135-145`), plus re-seeding system survey definitions the CASCADE wipes |
| globalSetup | `tests/setup.ts`: `applyDbRoles(role)` → migrate → `applyDbRoles(grants)` → clean → seed global user/tenant/API key → `provide()` to tests; memoised on `globalThis` because two vitest projects call it (`:44-53`) | `tests/setup.ts`: migrate → clean → seed → `provide()` |
| Per-file teardown | `tests/api-setup.ts`: `closeDatabase()` + dynamic-import shutdown of pg-boss and NOTIFY client after every file — connection-count hygiene | `tests/pacing-off.ts` (unrelated singleton reset) |
| vitest | 4 projects (`api` shared-registry `--no-isolate`, `api-isolated` for `vi.mock` files marked `// @vitest-isolate`, `documents`, `ui`); `pool: 'forks'`, `maxForks = minForks = clamp(cpus-2, 3, 6)` with the reasons documented (`vitest.config.ts:14-60`) | single project, `forks`, `maxForks: 3`; alias `cloudflare:workers` → `tests/mocks/cloudflare-workers.ts` |
| Safety | `safetyCheck()`: `NODE_ENV=test`, `DATABASE_URL` and `APP_DATABASE_URL` must contain `localhost` (`tests/helpers/db.ts:23-49`) | same but also allows a named Neon test branch (`ep-cold-butterfly`) — remove |
| Factories | `tests/helpers/auth.ts` (`createTestUser/Tenant/ApiKey/Session`, `linkUserToTenant`), `request.ts` (`apiRequest`, `getJson`) | `tests/helpers/auth.ts` (same names), `factories.ts` (`mockUser/mockTenant/...` data-only), many domain factories |
| CI | `ci.yml`: Postgres service container, `ALTER SYSTEM SET max_connections=300` + restart, `pnpm test` | **no CI test job** — `deploy-server.yml` only migrates + deploys |

**Kit: Mirevue's harness end-to-end** (setup → api-setup → helpers/db → helpers/auth → request),
simplified to two vitest projects (`api`, `ui`) unless `vi.mock` usage forces the isolated split.
Keep GM's `cloudflare:workers` alias/mocks since the kit's Hono app runs under Workers types; the
api tests still run in plain Node against local Postgres (both repos do this — neither runs
vitest under `workerd`/`@cloudflare/vitest-pool-workers`). Decision to record: keep Node-vitest
for DB tests (fast, proven), and add `wrangler dev` smoke for bindings.

---

## 7. Utilities

- Mirevue `src/api/utils/db/`: `tenant-helpers.ts` (`createTenantForUser` — slug collision loop +
  tenant/owner in one transaction, `:34-84`), `access-helpers.ts` (sign-up request flow),
  `people-helpers.ts`, `phase-helpers.ts` (product). **Kit: `tenant-helpers.ts` only.**
- GM `src/api/utils/db/`: `query-helpers.ts` — `buildPagination(limitStr, offsetStr, maxLimit=100,
  defaultLimit=50)` (`:187-199`), `buildDateRange`, `buildDateFilterCondition`, `buildSortOrder`,
  `buildSearchCondition`, `parseDate`; `repository-helpers.ts`, `tenant-helpers.ts` (product).
  **Kit: `query-helpers.ts` (pagination + sort + date range).** Mirevue has no pagination helper.
- `withTenant`-style helpers: Mirevue's are `withAuthAndDb` / `withTenantScope` / `scopedOn`
  (§1); GM has none beyond middleware. Kit keeps Mirevue's names with the transaction-scoped
  body (§9b).
- No soft-delete helper in either repo.

---

## 8. Docker compose / extensions

| | Mirevue | GM |
|---|---|---|
| Dev | `docker-compose.dev.yml`: `pgvector/pgvector:pg17` on **5432**, db `exec_dev`, user `exec_user`; plus MinIO | `docker-compose.dev.yml`: `paradedb/paradedb:latest` on **5436**, db `guidemode_dev` |
| Test | pg17 on **5433**, `max_connections=300` | paradedb on **5437** |
| Evals | separate compose *project* on **5434** (`docker-compose.evals.yml`) | — |
| Prod | `docker-compose.prod.yml` Postgres + app on one host | Neon (no compose) |
| Extensions | `vector` (pgvector, migration `0011`) | `pg_search` (ParadeDB BM25; Neon supports it) |

**Kit**: plain `postgres:17` (no extension) on `5432` dev / `5433` test, `max_connections=300`
comment carried over; document how to swap the image to `pgvector/pgvector:pg17` if a product
needs embeddings. Neon has `vector` available, `pg_search` too — record as opt-in.

---

## 9. Recommendations

### (a) Proposed file list — `src/db/` + scripts

```
src/db/
  client.ts            # createDatabase(url, opts) -> { db, close }; Database = PostgresJsDatabase<typeof schema>
                       # resolveDatabaseUrl(env): PREVIEW_DATABASE_URL ?? env.HYPERDRIVE.connectionString ?? DATABASE_URL
  tenant-scope.ts      # withTenantScope(db, tenantId, fn): mode off -> fn(db); mode enforce -> db.transaction + set_config(...,true)
                       # ScopedRunner, scopedOn, TenantScopeConflictError, TenantIsolationViolationError mapping hook
  schema/
    index.ts
    CLAUDE.md          # Mirevue's, trimmed: table registry + "adding a table" RLS checklist
    rls.ts             # APP_ROLE, tenantIsolation(), membershipIsolation(), RLS_EXCLUDED_TABLES
    tenants.ts users.ts tenant-users.ts keys.ts oauth-providers.ts tenant-settings.ts
    team-invitations.ts notifications.ts rate-limit-hits.ts (only if not KV-backed)
    _helpers.ts        # timestamps() spread, tenantRef() column factory
scripts/
  migrate.ts           # GM base: DATABASE_URL, Neon direct-host rewrite, postgres.js max:1, waitForDatabase
  db-roles.ts          # Mirevue verbatim minus product table names; APP_ROLE_NAME from rls.ts; --phase=role|grants|all
  seed.ts              # Mirevue trimmed
docker-compose.dev.yml docker-compose.test.yml
drizzle.config.ts
migrations/0000_init.sql + meta/
tests/setup.ts tests/api-setup.ts tests/helpers/{db,auth,request}.ts
tests/api/rls-coverage.test.ts   # catalog-driven, runs even in predicates-only mode (policies exist, role exists NOLOGIN)
tests/api/rls.test.ts            # skipped unless TENANT_SCOPE_MODE=enforce
docs/RLS.md                      # rollout doc rewritten for Hyperdrive (two bindings, caching-disabled, spike results)
.claude/rules/database.md
```

### (b) RLS over Hyperdrive — recommendation

**Ship predicates-only, with RLS as a documented, scaffolded upgrade path; run a spike before
anyone flips `enforce`.**

Why not "ship it": Mirevue's mechanism is a session GUC on a pinned `pg` connection, and its own
docs rule out transaction-mode poolers; Hyperdrive is one (§3.6). Why not "drop it": the
scaffolding (policies generated by drizzle-kit, `db-roles.ts`, the catalog coverage test, the
`off|pin|enforce` switch, boot posture log) is inert-by-default, costs nothing at runtime, and is
the only thing that makes a later enforcement rollout a config change rather than a project.

What ships in the kit:
1. `tenantIsolation()` on every tenant table, `RLS_EXCLUDED_TABLES`, `rls-coverage.test.ts` — so
   policies exist in every environment from day one and drift is caught in CI.
2. `db-roles.ts` creating the app role `NOLOGIN` via SQL (Neon-safe: no `neon_superuser`).
3. `withTenantScope` rewritten: `off` → `fn(db)`; `enforce` →
   `db.transaction(async tx => { await tx.execute(sql\`select set_config('app.tenant_id', ${tenantId}, true)\`); return fn(tx) })`
   on the `HYPERDRIVE_APP` client. Drop `pin` (its purpose was soaking Node connection pinning,
   which no longer exists) or redefine it as "transaction-wrap on the owner binding".
4. Default `TENANT_SCOPE_MODE=off`. `.claude/rules/database.md` states the threat model exactly as
   Mirevue does (forgotten predicate, not injection) and that predicates never go away.

The spike (half a day, against a Neon branch + a real Hyperdrive config, from `wrangler dev --remote`
or a deployed preview Worker):
1. **Correctness**: two Hyperdrive configs (owner + SQL-created app role, direct host). Run 200
   concurrent requests alternating tenants A/B through the transactional `set_config(..., true)`
   path; assert zero cross-tenant rows and that a predicate-less `select count(*)` inside the
   transaction returns only the tenant's rows. Also assert a query *outside* any transaction on the
   app binding returns zero rows (fail-closed proof).
2. **Cache leak**: with caching **enabled**, tenant A runs `select * from widgets` (no predicate)
   inside its transaction, then tenant B runs the identical statement. If B ever sees A's rows,
   caching must be disabled on the app binding (`wrangler hyperdrive create --caching-disabled`).
   Repeat with caching disabled to confirm the fix.
3. **Latency**: p50/p95 of `BEGIN + set_config + one select + COMMIT` vs a bare select, with and
   without Smart Placement; try a simple-protocol `BEGIN; select set_config(...)` pipeline with a
   regex-validated UUID to shave a round trip.
4. **Neon role plumbing**: run `db-roles.ts --phase=role` / `migrate` / `--phase=grants` against
   the branch as the project owner; confirm `ALTER DEFAULT PRIVILEGES FOR ROLE <owner>` and the
   `REVOKE` succeed, and `pg_roles` shows `rolbypassrls=false` for the app role. Confirm the
   owner (a `neon_superuser` member, not a superuser) still bypasses policies without `FORCE`.
5. **Pool behaviour**: hold the transaction open for 2 s in 50 concurrent requests and watch
   Hyperdrive's connection count / error rate — validates the docs' warning about long transactions.

Go/no-go: if 1 passes, 2 is fixable by `--caching-disabled`, and 3 costs under ~10 ms p95 with
placement, promote `enforce` to a supported mode in `docs/RLS.md`. Otherwise it stays documented
as "not supported over Hyperdrive; use a direct Neon connection (no Hyperdrive) for the app role
and accept the connection-setup cost".

### (c) Environment variables (names only)

Worker bindings (`wrangler.toml`): `HYPERDRIVE` (owner role), optionally `HYPERDRIVE_APP` (RLS
app role; only when enforce is supported). Both with `localConnectionString` for `wrangler dev`.

Vars / secrets:
- `DATABASE_URL` — owner connection string; used by `scripts/migrate.ts`, `scripts/db-roles.ts`,
  `scripts/seed.ts`, drizzle-kit, tests, and as the Worker fallback when no Hyperdrive binding
  (GM `.dev.vars`, mirevue `.env.example`).
- `APP_DATABASE_URL` — app role credential for `db-roles.ts` (username must equal `APP_ROLE`).
  Not read by the Worker (the Worker gets it via `HYPERDRIVE_APP`).
- `TENANT_SCOPE_MODE` — `off|enforce` (Mirevue `off|pin|enforce`).
- `PREVIEW_DATABASE_URL` — optional per-PR Neon branch override (GM).
- `NODE_ENV` — `test` gate for `safetyCheck()`.
- `SEED_ON_START` — Mirevue entrypoint only; no Worker equivalent.
- CI secrets per GitHub Environment (GM `deploy-server.yml:19-25`): `DATABASE_URL`,
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

### (d) Open questions / risks

1. **Hyperdrive caching × RLS** is the single biggest unknown; docs are silent on transactional
   reads. Treat `--caching-disabled` on the app binding as mandatory until the spike says otherwise.
2. **Per-request client cost.** Even fixed with `waitUntil(close())`, a Worker pays a Hyperdrive
   connection setup per request. Acceptable (that is Hyperdrive's design), but do not carry
   Mirevue's pool-size budgeting comments into the kit — they are meaningless here.
3. **Two-binding complexity** in enforce mode: auth middleware (API key hash probe, magic-link,
   invite accept) must stay on the owner binding, as in Mirevue (`rls.ts:100-104`); the kit needs
   Mirevue's `unscoped-allowlist` style guard to keep that list small.
4. **`db-roles.ts` against Neon**: must target the direct (non-`-pooler`) host; `ALTER ROLE ... SET
   statement_timeout` etc. should work for a role you own but verify in the spike.
5. **Node-vitest vs workerd**: both repos test DB code in Node. The kit's `createDatabase` will be
   exercised under Node (postgres.js) in tests and under workerd (postgres.js over Hyperdrive) in
   prod; keep the module free of Node-only APIs (`AsyncLocalStorage` is available under
   `nodejs_compat`, `pg` is not usable — do not reintroduce it).
6. **Drizzle/Neon package**: if `@neondatabase/serverless` is dropped, `PREVIEW_DATABASE_URL`
   (a `neon.tech` URL) goes through postgres.js over TCP directly from the Worker — fine on
   Workers with `nodejs_compat`, but it bypasses Hyperdrive; document it as preview-only.
7. **Timestamp normalisation**: standardising on `timestamptz` means the kit's migration 0000 is
   not a copy of either repo's; write it fresh via `drizzle-kit generate`.
8. **`users` membership policy** assumes "every person a tenant can see is a `tenant_users` row";
   the kit must keep that invariant (invite inserts membership before anything references the
   user) or the policy hides legitimately visible people.

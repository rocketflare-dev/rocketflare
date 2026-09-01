---
globs:
  - src/db/**
  - migrations/**
  - drizzle.config.ts
  - scripts/migrate.ts
  - scripts/db-roles.ts
  - scripts/seed.ts
---

# Database Patterns

Drizzle ORM over PostgreSQL (Neon in deployed envs, Docker locally). **One driver: `postgres.js`**
(`postgres`). Never add `pg` or `@neondatabase/serverless` (D2). All domain data is tenant-scoped.

## Tenant isolation (the invariant)

- Every domain table has `tenantId` via `tenantRef()` (`src/db/schema/_helpers.ts`) — `uuid`, FK to
  `tenants.id`, `onDelete: 'cascade'`, and it comes FIRST in every composite index
- Every query filters by `tenantId` from the auth context (`withAuthAndDb`), never from a client-
  supplied id. This predicate is what keeps the `(tenant_id, …)` indexes selective; it never goes away
- Cross-tenant SQL lives in exactly two places: `src/api/routes/admin.ts` (behind
  `globalAdminMiddleware`) and the pre-tenant auth path (`middleware/auth.ts`, `routes/auth/*`,
  invite accept). `tests/api/unscoped-allowlist.test.ts` pins that list; adding to it is a design
  decision, not a refactor
- `users` is global (a person belongs to many tenants); visibility is through `tenant_users`
- `TENANCY_MODE=single` changes nothing here: the schema is identical in both modes (D25)

## Row-level security — shipped inert (D1, docs/RLS.md)

Every table with a `tenantId` MUST include `tenantIsolation('<table>')` in its `extraConfig`; a table
without one goes in `RLS_EXCLUDED_TABLES` (`src/db/schema/rls.ts`) with the reason.
`tests/api/rls-coverage.test.ts` fails CI either way until you do. The policies are `FOR ALL TO
gmgo_app` with `USING` and `WITH CHECK` on `tenant_id = nullif(current_setting('app.tenant_id',
true), '')::uuid`. `scripts/db-roles.ts` creates `gmgo_app` `NOLOGIN` via SQL (never a
`neon_superuser`), so policies resolve while nothing can connect as the role.

`TENANT_SCOPE_MODE`: `off` (default — `withTenantScope(db, tenantId, fn)` is `fn(db)`) · `enforce`
(`db.transaction` + `set_config('app.tenant_id', $1, true)` on the `HYPERDRIVE_APP` client; needs the
spike in docs/RLS.md to pass first). Threat model stated honestly: RLS catches a **forgotten
predicate**, not SQL injection — the app role can `set_config` itself.

## Schema conventions

- One file per table in `src/db/schema/`, re-exported from `index.ts` (drizzle-kit reads `index.ts`)
- `id: uuid('id').primaryKey().defaultRandom()`; `...timestamps()` gives `createdAt`/`updatedAt` as
  `timestamptz` — never bare `timestamp`
- `pgEnum` for closed sets; append values last (a migration cannot USE an enum value it adds)
- `jsonb` for flexible metadata, typed with `$type<>()` from a `src/shared` zod schema
- `relations()` for type-safe joins; no polymorphic FKs
- Encrypted-at-rest columns (`oauth_providers.access_token`, `ai_configs.credentials`) are `text`
  written only through `token-crypto.ts`
- Vector columns: `vector(1024)` via the `EMBEDDING_DIM` constant; changing the dimension is a new
  table, not an `ALTER` (D18)

## Connection

- `src/db/client.ts`: `createDatabase(url) → { db, close }`; `Database = PostgresJsDatabase<typeof schema>`
- `resolveDatabaseUrl(env) = PREVIEW_DATABASE_URL ?? env.HYPERDRIVE.connectionString ?? DATABASE_URL`
- One client per request/invocation, built in `databaseMiddleware` (or at the top of a queue
  consumer / workflow step / cron task), closed in `waitUntil` or `finally`. Hyperdrive is the pool;
  `max: 5` per client. Don't carry pool-budget arithmetic into this repo — it is meaningless here
- `db.transaction(tx => …)` for multi-table writes (invite accept, tenant create). Transactions are
  why postgres.js was kept; keep them short — Hyperdrive cannot reuse a connection mid-transaction
- No `LISTEN/NOTIFY`, advisory locks or `PREPARE` on the request path — Hyperdrive does not support
  them. Realtime goes through the DO hub; locks go through `RATE_LIMIT_KV` `operationLock`
- `db.execute(sql\`…\`)` returns rows directly (postgres.js), not `{ rows }`

## Migrations

1. Edit `src/db/schema/*` → 2. `pnpm db:generate` → 3. **read the SQL** → 4. `pnpm db:migrate`.

`db:migrate` = `db-roles --phase=role` → `migrate.ts` → `db-roles --phase=grants`. Role first
because a policy's `TO gmgo_app` needs the role to exist; grants after because `REVOKE` can only name
tables that exist. Both halves are idempotent. `db:migrate:ci` is the same without dotenv (env from
the GitHub Environment). `scripts/migrate.ts` rewrites a Neon `-pooler` host to the direct host so
DDL never hits a pooled backend.

Never hand-edit an applied migration or `migrations/meta/`. Custom SQL (an extension, a fact table)
is a generated file edited before it is applied, journal intact.

Tests migrate a throwaway database on 5433 from `tests/setup.ts` — never Neon.

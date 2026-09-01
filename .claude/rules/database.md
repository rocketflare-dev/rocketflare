---
globs:
  - apps/web/src/db/**
  - apps/web/migrations/**
  - apps/web/drizzle.config.ts
  - apps/web/scripts/migrate.ts
  - apps/web/scripts/db-roles.ts
  - apps/web/scripts/seed.ts
---

# Database Patterns

Drizzle ORM over PostgreSQL (Neon in deployed envs, Docker locally). **One driver: `postgres.js`**
(`postgres`). Never add `pg` or `@neondatabase/serverless` (D2). All domain data is tenant-scoped.

## Tenant isolation (the invariant)

- Every domain table has `tenantId` via `tenantRef()` (`apps/web/src/db/schema/_helpers.ts`) — `uuid`, FK to
  `tenants.id`, `onDelete: 'cascade'`, and it comes FIRST in every composite index
- Every query filters by `tenantId` from the auth context (`withAuthAndDb`), never from a client-
  supplied id. This predicate is what keeps the `(tenant_id, …)` indexes selective; it never goes away
- Cross-tenant SQL lives in exactly two places: `apps/web/src/api/routes/admin.ts` (behind
  `globalAdminMiddleware`) and the pre-tenant auth path (`middleware/auth.ts`, `routes/auth/*`,
  invite accept). `apps/web/tests/api/unscoped-allowlist.test.ts` pins that list; adding to it is a design
  decision, not a refactor
- `users` is global (a person belongs to many tenants); visibility is through `tenant_users`
- `TENANCY_MODE=single` changes nothing here: the schema is identical in both modes (D25)

## Row-level security — shipped inert (D1, docs/RLS.md)

Every table with a `tenantId` MUST include `tenantIsolation('<table>')` in its `extraConfig`; a table
without one goes in `RLS_EXCLUDED_TABLES` (`apps/web/src/db/schema/rls.ts`) with the reason.
`apps/web/tests/api/rls-coverage.test.ts` fails CI either way until you do. The policies are `FOR ALL TO
rocketflare_app` with `USING` and `WITH CHECK` on `tenant_id = nullif(current_setting('app.tenant_id',
true), '')::uuid`. `apps/web/scripts/db-roles.ts` creates `rocketflare_app` `NOLOGIN` via SQL (never a
`neon_superuser`), so policies resolve while nothing can connect as the role.

`TENANT_SCOPE_MODE`: `off` (default — `withTenantScope(db, tenantId, fn)` is `fn(db)`) · `enforce`
(`db.transaction` + `set_config('app.tenant_id', $1, true)` on the `HYPERDRIVE_APP` client; needs the
spike in docs/RLS.md to pass first). Threat model stated honestly: RLS catches a **forgotten
predicate**, not SQL injection — the app role can `set_config` itself.

## Schema conventions

- One file per table in `apps/web/src/db/schema/`, re-exported from `index.ts` (drizzle-kit reads `index.ts`)
- `id: uuid('id').primaryKey().defaultRandom()`; `...timestamps()` gives `createdAt`/`updatedAt` as
  `timestamptz` — never bare `timestamp`
- `pgEnum` for closed sets; append values last (a migration cannot USE an enum value it adds)
- `jsonb` for flexible metadata, typed with `$type<>()` from a `@rocketflare/shared` zod schema. The one
  exception is `analytics_pages.config`, typed `$type<DashboardConfig>()` from `drizzle-cube/client`
  (type-only import) — shared may import only zod, so its `dashboardConfigSchema` is loose and the
  drizzle-cube type lives on this side (D19)
- `relations()` for type-safe joins; no polymorphic FKs
- Encrypted-at-rest columns (`oauth_providers.access_token`, `ai_configs.credentials`) are `text`
  written only through `token-crypto.ts`
- pgvector (D18): `chunks.embedding` is `vector('embedding', { dimensions: EMBEDDING_DIM })` with
  `EMBEDDING_DIM` imported from `@rocketflare/shared/ai/config` (1024 — the native width of the default
  embeddings model `@cf/baai/bge-m3`; the `openai*` adapters request `dimensions: 1024` so every
  provider fits the column). **The constant must match the model the default resolver picks**; a
  different width is a NEW table (or a fresh migration on an empty table), never an `ALTER`, and every
  existing chunk must be re-embedded (`documents.content` is kept for exactly that). ANN index:
  `index('chunks_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops'))` — cosine,
  matching the `<=>` operator `services/ai/retrieval.ts` orders by; the tenant predicate still comes
  first in every query and in every btree index. The `vector` extension is created by
  `apps/web/scripts/migrate.ts` (`CREATE EXTENSION IF NOT EXISTS vector`) before the migrations run,
  not by a migration file. Lexical search is `to_tsvector('english', text)` at query time; a generated
  `tsvector` column + GIN index is the scaling path (a migration, no code change in the query shape)
- Query vectors are parameters: `vectorLiteral(v)` (`[0.1,0.2,…]`) interpolated through the drizzle
  `sql` tag and cast `::vector` — never string-concatenate a query; `embedding` values are inserted as
  `number[]` through drizzle
- **Fact tables (D19)** live in `apps/web/src/db/schema/facts/` (barrel `facts/index.ts`, re-exported from
  `schema/index.ts`): plain tables rebuilt per tenant by `api/services/fact-tables` — NOT materialised
  views (`REFRESH MATERIALIZED VIEW` cannot run through Hyperdrive or be scoped to one tenant). Shape:
  `tenantRef()` first, the grain columns, the measures, then
  `factRefreshedAt: timestamp('fact_refreshed_at', { withTimezone: true }).notNull().defaultNow()` —
  every fact table carries that column, spelled exactly so; the freshness check reads
  `MAX(fact_refreshed_at)` — and `tenantIsolation('<table>')`. **No surrogate `id`, no `timestamps()`**
  (the grain IS the key), and no FK to a table whose rows may vanish (`users`): a refresh must never
  fail because an actor was deleted. The grain is a `unique('<table>_grain').on(...)` constraint; when a
  grain column is nullable add `.nullsNotDistinct()` (`UNIQUE NULLS NOT DISTINCT`, Postgres 15+ — Neon
  and the `pg17` compose image qualify), or every NULL actor becomes its own row. First index column is
  `tenant_id`, as everywhere. A fact table is also an entry in `api/services/fact-tables/registry.ts`
  (with a `queries/<name>.ts` SELECT in the schema's column ORDER) and usually a cube —
  `.claude/rules/api.md`. Rows are derived data: rebuilt with `pnpm web db:refresh-facts`, checked with
  `pnpm web db:check-facts`, never hand-migrated
- Per-call rows: `ai_usage` (append-only, `(tenant_id, at DESC)`), `agent_run_events` (`(run_id, seq)`
  unique, numbering continues across attempts). Concurrency is a claim row, never a lock:
  `agent_runs` `UPDATE … WHERE status IN ('queued','running') RETURNING` plus the partial unique index
  `agent_runs_active_exclusive_idx` — the pattern for any "one active job per key" need

## Connection

- `apps/web/src/db/client.ts`: `createDatabase(url) → { db, close }`; `Database = PostgresJsDatabase<typeof schema>`
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

1. Edit `apps/web/src/db/schema/*` → 2. `pnpm db:generate` → 3. **read the SQL** → 4. `pnpm db:migrate`.

`db:migrate` = `db-roles --phase=role` → `migrate.ts` → `db-roles --phase=grants`. Role first
because a policy's `TO rocketflare_app` needs the role to exist; grants after because `REVOKE` can only name
tables that exist. Both halves are idempotent. `db:migrate:ci` is the same without dotenv (env from
the GitHub Environment). `apps/web/scripts/migrate.ts` rewrites a Neon `-pooler` host to the direct host so
DDL never hits a pooled backend.

Never hand-edit an applied migration or `apps/web/migrations/meta/`. Custom SQL (an extension, a fact table)
is a generated file edited before it is applied, journal intact.

Tests migrate a throwaway database on 5433 from `apps/web/tests/setup.ts` — never Neon.

---
paths:
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
  invite accept). `apps/web/tests/config/unscoped-allowlist.test.ts` pins the exceptions — it fails when
  any function queries a `tenant_id` table without naming a tenant — so adding one is a design
  decision (an entry there, with a reason, and a line in the PR), not a refactor
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
  one exception is a PLUGIN's column typed from the plugin's own dependency: the analytics plugin's
  `analytics_pages.config` is `$type<DashboardConfig>()` from `drizzle-cube/client` (type-only
  import), because shared may import only zod, so its `dashboardConfigSchema` is loose and the
  precise type lives on the web side (D19, D31)
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
- **Fact tables (D19)** are the ANALYTICS PLUGIN's now, and so is every rule about them
  (`apps/web/src/plugins/analytics/services/fact-tables/CLAUDE.md` once it is installed). The shape
  is worth knowing anyway, because it is what any pre-aggregated table should look like:
  `tenantRef()` first, the grain columns, the measures, then
  `factRefreshedAt: timestamp('fact_refreshed_at', { withTimezone: true }).notNull().defaultNow()`
  and `tenantIsolation('<table>')`. **No surrogate `id`, no `timestamps()`** (the grain IS the key),
  and no FK to a table whose rows may vanish (`users`): a refresh must never fail because an actor
  was deleted. The grain is a `unique('<table>_grain').on(...)` constraint, `.nullsNotDistinct()`
  when a grain column is nullable (`UNIQUE NULLS NOT DISTINCT`, Postgres 15+). First index column is
  `tenant_id`, as everywhere. Rows are derived data — rebuilt, never hand-migrated.
- **Visibility (D29)**: a resource people may restrict carries a `visibility` text column
  (`RESOURCE_VISIBILITY_VALUES` in `_helpers.ts`, `tenant | groups`, default `tenant`) PLUS its own
  junction table to `groups` (`document_groups`, and a plugin's own — the analytics plugin's
  `analytics_page_groups`: `tenantRef()` first, PK on
  the pair, both FKs cascade, index `(tenant_id, group_id)`). **The column is the decision and the
  rows are only the grants** — `groups` with zero rows means owner-and-admins-only, which is what
  deleting the last group must leave. Never infer "restricted" from "has rows": that turns the same
  delete into a silent publish. `group_members` shows the other half of the pattern — a composite FK
  `(tenant_id, user_id) → tenant_users` with cascade, so losing a membership loses the group
  memberships in the DATABASE rather than in service code
- **Feature flags (D30)** are two tables with different shapes on purpose. `feature_flags` is
  PLATFORM state — `key` is the primary key (no surrogate `id`: the key is the identity in every
  consumer, so a uuid beside it is a second identity nobody uses), a `check` keeps
  `rollout_percent` in 0..100, and it has no `tenant_id`, so it is listed in `RLS_EXCLUDED_TABLES`
  (excluded, NOT revoked — the app role reads it every request). `tenant_feature_overrides` is
  ordinary tenant data: `tenantRef()` first, PK on the pair, `tenantIsolation()`. Two things not to
  "fix": it carries **no composite FK to `tenant_users`** (unlike `group_members` — the person
  setting an override is a global admin who is almost never a member of that tenant, so the FK would
  reject every write), and its `flag_key` index is **not led by `tenant_id`**, because the one query
  it serves is cross-tenant by design behind `globalAdminMiddleware`
- Per-call rows: `ai_usage` (append-only, `(tenant_id, at DESC)`), `agent_run_events` (`(run_id, seq)`
  unique, numbering continues across attempts). Concurrency is a claim row, never a lock:
  `agent_runs` `UPDATE … WHERE status IN ('queued','running') RETURNING` plus the partial unique index
  `agent_runs_active_exclusive_idx` — the pattern for any "one active job per key" need
- **The predicate is the guarantee, so it is written once and rendered.** `agent_runs` is the worked
  example. Its exclusive index covers `ACTIVE_RUN_STATUSES` (`queued`, `running`, `awaiting_input` —
  a run parked on a human still holds the slot), and the SQL literal list in `extraConfig` is BUILT
  from that exported array rather than typed out, because an index whose SQL and whose TypeScript
  disagree about what "active" means is a bug no test can see. The claim above reads a deliberately
  narrower `CLAIMABLE_RUN_STATUSES` (`queued`, `running`): a parked run must hold the slot and must
  NOT be claimable, or answering it and a stray step retry would both run it. `finishStep` keeps a
  third, inline list for its "still active at the end → fail it" backstop — widening THAT one turns
  every legitimately parked run into a `failed` row. Three lists, three jobs; do not unify them
- **`agent_run_interrupts`** is the HITL question (issue #17): `tenantRef()` first, `UNIQUE (run_id,
  key)` — the idempotency that makes a re-entered agent find the ANSWER instead of asking again —
  a typed `spec` jsonb, `(tenant_id, status, created_at DESC)` for the tenant-wide inbox, and a
  status that only ever moves out of `pending` by **compare-and-set**, which is what makes two
  people answering at once one 200 and one 409 rather than a lost decision.
  **`agent_run_artifacts`** is what a run produced: `UNIQUE (run_id, key)` too, but there it is the
  UPSERT key, so a redrafted artifact replaces itself. A steering note is deliberately NOT a table —
  it is immutable, positional and per-run, so it is an `agent_run_events` row, and its once-only
  delivery cursor is the existing `agent_run_effects` ledger. Decide which of those three shapes a
  new concept is before you reach for a migration

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

## Plugins (D31) — a plugin's tables

An installed plugin owns tables exactly like the kit's, in `src/plugins/<id>/db/schema/*`:

- **Every table starts with a prefix derived from the plugin's id** — its first hyphen-separated
  segment (`example-feature` → `example_*`, `analytics` → `analytics_*`). A longer prefix is
  welcome, not required. **The prefix is a convention a human picks, not a string the tooling
  derives**: nothing anywhere turns an id into a table name or a table name into an id
  (`plugin remove` reads `schema.tables` verbatim, `archiveSql` quotes them, `rls-coverage` reads
  the catalog), so there is no key to check a shape against. What IS checked is the collision —
  **`pnpm plugin check` fails when two installed plugins declare the same table name**, because a
  table name is the one identifier nothing namespaces for you and nothing else in the kit can see
  it: TS2308 catches a duplicated EXPORT name, and two plugins spelling `pgTable('orders', …)`
  under different symbols compile cleanly, after which drizzle-kit emits DDL for one name twice and
  one `DROP TABLE` takes the other plugin's data
- **One `export * from './<id>/db/schema'` in `apps/web/src/plugins/schema.ts`**, which is
  re-exported by one `export *` line in `db/schema/index.ts` — the one surface `drizzle.config.ts`,
  `db/client.ts` (`typeof schema`) and `rls-coverage.test.ts` read. So a plugin table is migrated,
  typed and RLS-checked like any other, and a duplicated export name is a TS2308 error rather than
  a silent shadow
- **`tenantIsolation('<table>')` is as mandatory here as anywhere**; a plugin table with no
  `tenant_id` goes in `ServerPlugin.rlsExcludedTables` with its reason, which `rls-coverage.test.ts`
  unions into `RLS_EXCLUDED_TABLES`. `tenantRef()` first, `(tenant_id, …)` indexes
- **A plugin ships NO migration.** The HOST generates it after the barrel line exists:
  `pnpm db:generate --name plugin-<id>-<version>`, read the SQL, `pnpm db:migrate` — so the DDL is
  numbered in the host's own journal and a plugin can never renumber somebody else's. A plugin's
  `migrations/` directory, if it has one, holds plain-SQL DATA fragments (backfills), never DDL
- **Never rename a plugin's column or table across releases** — expand/contract only. `drizzle-kit`'s
  rename prompt has no non-interactive answer, so a rename stops an unattended install dead
- **`relations()` for the plugin's OWN tables only.** Measured on drizzle-orm 0.45.2: a second
  `relations()` for a core table merges at runtime but not at the type level
  (`ExtractTableRelationsFromSchema` unions the two configs and `BuildRelationResult` keys over
  their intersection), so it silently strips `with:` from that table's query results app-wide. The
  `one()` side on the plugin's own table expresses the FK fully; only the `many()` back-reference
  cannot be contributed. The long form of the measurement is in `apps/web/src/plugins/schema.ts`
- Removing a plugin drops its tables: delete the files and the barrel line, then `pnpm db:generate`
  emits the `DROP TABLE`. Orphaned tables are not a stable state

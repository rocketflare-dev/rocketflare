# Database Schema

Drizzle table definitions, one file per table, re-exported from `index.ts` (which `drizzle.config.ts`,
`src/db/client.ts` and the RLS coverage test all read). Phase 0 ships helpers only.

## Conventions

- PK: `uuid('id').primaryKey().defaultRandom()`. No ULIDs.
- Tenant FK: `tenantId: tenantRef(tenants)` from `_helpers.ts` → `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`. First column of every index on a tenant table is `tenant_id`.
- Timestamps: `...timestamps()` from `_helpers.ts` — `created_at`/`updated_at` as **`timestamptz`**. Never a naive `timestamp`.
- extraConfig is the **array** form: `table => [index(...), tenantIsolation('x')]` (required for `pgPolicy`).
- Enums via `pgEnum`, exported; `relations()` next to the table; `export type X = typeof x.$inferSelect` / `NewX = $inferInsert`.
- D25: the schema is identical in `TENANCY_MODE=multi` and `single` — every table keeps `tenant_id`.

## Row-level security — read before adding a table (D1)

RLS scaffolding ships inert (`TENANT_SCOPE_MODE=off`; the `gmgo_app` role is NOLOGIN). Policies still
exist in every environment so enabling enforcement later is a config change, not a migration.
`tests/api/rls-coverage.test.ts` (Phase 1) reads the live catalog, so every table must do ONE of:

1. **Has `tenant_id`** → add `tenantIsolation('<table_name>')` to its extraConfig array.
   `tenants` itself uses `tenantIsolation('tenants', sql\`id\`)`; `users` uses `membershipIsolation()`.
2. **No `tenant_id`** → add it to `RLS_EXCLUDED_TABLES` in `rls.ts` WITH a reason. Pre-tenant
   infrastructure tables (`user_sessions`, `oauth_providers`, `access_requests`) additionally go in
   `RLS_REVOKED_TABLES` — `scripts/db-roles.ts` REVOKEs them from the app role outright.

The predicate `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid` is ONE shared
object; never inline a copy (drizzle-kit diffs SQL text). No `FORCE ROW LEVEL SECURITY`: the owner
connection (HYPERDRIVE) bypasses policies, which is what keeps auth paths and rollback working.
**The `eq(x.tenantId, ...)` predicates stay** — RLS is defence in depth underneath them.

## Adding a table — checklist

1. `src/db/schema/<name>.ts` with `tenantRef`, `timestamps()`, indexes, and `tenantIsolation('<name>')`.
2. Export from `index.ts`; add the row to the table registry here.
3. `pnpm db:generate` → review the SQL in `migrations/` (policies included) → `pnpm db:migrate`
   (role → migrate → grants). Tests run migrations automatically.
4. `src/shared/<name>.ts` zod contract if the API exposes it.

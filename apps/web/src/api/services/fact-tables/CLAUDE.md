# Fact tables — D19

Pre-aggregated, tenant-scoped tables that dashboards read instead of scanning event tables. One
example ships: `tenant_activity_daily_facts` (grain `tenant_id, day, user_id`) from `activity_events`,
read by the `TenantActivityDaily` cube.

- `registry.ts` — `FACT_TABLES`: `{ name, table, refreshIntervalMinutes, source: { table,
  timestampColumn }, selectForTenant(tenantId) → SQL }`. Everything else iterates this list.
- `refresh.ts` — `refreshFactTable(db, name, { tenantId? })`: per tenant, one transaction,
  `DELETE … WHERE tenant_id = $1` then `INSERT INTO t (<columns from getTableColumns>) <select>`;
  errors isolated per tenant. `refreshAllFactTables(db)` = every table. Full rebuild, not
  incremental; `fact_refreshed_at` is a stamp.
- `freshness.ts` — `checkFactTableFreshness(db)`: `lagSeconds` = newest source row minus last
  build (0 if the build is newer); `stale` = lag > 2× interval.
- Runs from: cron `"15 * * * *"` (`api/scheduled.ts`, both tomls), `pnpm --filter @rocketflare/web
  db:refresh-facts [table] [--tenant=<uuid>]`, `db:check-facts`; status at
  `GET /api/analytics/facts/status` (admin+).
- Constraints: DELETE+INSERT works through Hyperdrive; `REFRESH MATERIALIZED VIEW` / `ANALYZE` do
  not (they need a direct connection — do them in a script). The cron shares the Worker CPU
  budget: past a few hundred tenants, fan tenants out through `JOBS_QUEUE` instead of looping.

## Adding a fact table

1. `db/schema/facts/<name>.ts` (tenantRef, `fact_refreshed_at`, `tenantIsolation`, a grain
   uniqueness constraint — use `NULLS NOT DISTINCT` if a grain column is nullable) + export from
   `facts/index.ts`; `pnpm db:generate`.
2. `queries/<name>.ts`: a parameterised `sql` SELECT whose column ORDER matches the schema file.
3. One entry in `FACT_TABLES`; a cube in `api/cubes/`; seed rows in the isolation test.

## Two refreshes of one tenant must not overlap

`refreshFactTableForTenant` is `DELETE … WHERE tenant_id = $1` then `INSERT … SELECT` in one
transaction, and that is **not** safe against a concurrent rebuild of the SAME tenant: under READ
COMMITTED the later transaction's DELETE runs on a snapshot taken before the earlier INSERT
committed, so it leaves those rows in place and its own INSERT trips the grain unique index. The
tenant is then reported in `errors[]` and keeps the first rebuild's rows — wrong-looking, but not
corrupt, because the rows are derived data and both writers compute the same thing.

In practice the overlap is the `15 * * * *` cron meeting a manual `pnpm web db:refresh-facts`, or
two Workers firing the cron. It is currently **unguarded**: don't run a manual refresh while the
cron is due. Advisory locks are not an option (Hyperdrive, `.claude/rules/database.md`); the fixes
worth considering are `INSERT … ON CONFLICT (<grain>) DO UPDATE` (needs the grain constraint in the
registry) or moving the per-tenant rebuild onto `JOBS_QUEUE`, which is the documented scaling path
anyway and would serialise it.

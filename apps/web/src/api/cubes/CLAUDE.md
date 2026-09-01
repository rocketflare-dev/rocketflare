# Cubes (drizzle-cube semantic layer) — D19

One file per cube, `defineCube('Name', …)` from `drizzle-cube/server`, registered in `index.ts`
(`allCubes`). Served per request by `routes/cube-api.ts` (`createCubeApp` from
`drizzle-cube/adapters/hono`) at `/cubejs-api/v1/{load,meta,sql,batch,dry-run}` and `/mcp`, both
mounted behind `authMiddleware` + `guardPermission(c, 'read', 'Analytics')`.

## The invariant — every cube MUST scope its base query to the active tenant

`sql: ctx => ({ from: table, where: eq(table.tenantId, tenantIdOf(ctx)) })`

`tenantIdOf(ctx)` (`security.ts`) reads `ctx.securityContext.tenantId`, which `extractSecurityContext`
took from `c.get('auth')`. A table without `tenant_id` (`users`) is scoped THROUGH membership:
`inArray(users.id, select user_id from tenant_users where tenant_id = …)`. There is no second line
of defence at the cube layer — drizzle-cube joins whatever a query asks for, so an unscoped cube
leaks every tenant's rows to every member. **`tests/api/cubes/cube-isolation.test.ts` enforces
this**: it seeds two tenants, runs every cube in `allCubes` through `POST /cubejs-api/v1/load` as
each tenant and asserts only that tenant's rows come back. A new cube must be added to its seed.

## Conventions

- Dimensions/measures are objects keyed by name with `{ name, title, type, sql }`; exactly one
  `primaryKey: true` dimension per cube. Filtered counts: `filters: [() => eq(col, 'x')]`.
- **Member names are frozen** — `analytics_pages.config` references `Cube.measure` strings; a
  rename silently breaks stored dashboards. Add, don't rename; `reset` to template is the repair.
- Joins: declare them on the `belongsTo` side only (`TenantUsers → Users`, `ActivityEvents →
  Users`); drizzle-cube walks join paths in both directions, so the reverse (`Users → TenantUsers`)
  works without a `hasMany` declaration — and a declared `hasMany` between two cubes makes every
  ungrouped (`recordsTable`) query mixing them a 400. `on: [{ source, target }]`; `targetCube: () =>
  otherCube` thunks break import cycles. Fact tables (`facts/`) are plain cubes with the same `where`.
- Event streams add `meta.eventStream: { bindingKey, timeDimension, eventDimension }` (funnel /
  flow / retention modes) — see `activity-events.ts`.
- Security context is `{ tenantId, userId, role }` only. No cube reads `role`; access is
  membership + `read Analytics`, row filtering is by tenant. Role-based row restriction is a
  per-app extension, not a kit default.
- The compiler is rebuilt per request (4 cubes — cheap; the Hyperdrive-backed `db` only exists
  inside a request). The scaling path is `SemanticLayerCompiler` + cube sets, and
  `cache: MemoryCacheProvider` is per-isolate on Workers — a KV provider would be an extension.

## Ship set

| Cube | Table | Scoping | Shows |
|---|---|---|---|
| `Users` | `users` | membership subquery | global table pattern |
| `TenantUsers` | `tenant_users` | direct `tenant_id` | filtered role counts, join to `Users` |
| `ActivityEvents` | `activity_events` | direct | event stream (`meta.eventStream`) |
| `TenantActivityDaily` | `tenant_activity_daily_facts` | direct | fact-table cube (`sum`, `countDistinct`) |

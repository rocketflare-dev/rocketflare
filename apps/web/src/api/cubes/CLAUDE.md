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
- Security context is `{ tenantId, userId, role }` plus the group fields below. No cube reads
  `role`; access is membership + `read Analytics`, row filtering is by tenant. Role-based row
  restriction is a per-app extension, not a kit default.
- **`groupFilter(ctx, typeName, column)` (D29)** — narrow rows to the reader's groups of one TYPE,
  for an app whose own fact table carries a group dimension. **No kit cube uses it**, because no kit
  table has one; it is here so the pattern is decided rather than invented per app:

  ```ts
  sql: ctx => ({
    from: orders,
    where: and(eq(orders.tenantId, tenantIdOf(ctx)), groupFilter(ctx, 'Department', orders.departmentGroupId)),
  })
  ```

  Three behaviours, and the third is the point: admin-level → `undefined` (no narrowing); groups of
  that type → `column in (…their ids)`; **no group of that type → `false`**, so a person outside the
  dimension sees nothing rather than everything. It matches on IDS — the context carries names
  (`groups`, keyed by type name) for labels only, because matching on a name means renaming a group
  silently moves rows. Its unit test is `tests/api/cubes/security.test.ts`; `cube-isolation.test.ts`
  is unchanged, since the kit's cubes are scoped by tenant alone.
- The compiler is rebuilt per request (4 cubes — cheap; the Hyperdrive-backed `db` only exists
  inside a request). The scaling path is `SemanticLayerCompiler` + cube sets, and
  `cache: MemoryCacheProvider` is per-isolate on Workers — a KV provider would be an extension.
- Bundle caveat: `drizzle-cube/adapters/hono` statically imports its MCP transport even with
  `mcp.enabled: false`, and that dominates the Worker bundle. Not caused by the cubes; fix is
  upstream or a thin adapter over `drizzle-cube/server` (`.claude/rules/cloudflare.md`, which also
  says why no byte count is written down). `mcp.allowedOrigins` is unset — browser MCP clients need it.

## Ship set

| Cube | Table | Scoping | Shows |
|---|---|---|---|
| `Users` | `users` | membership subquery | global table pattern |
| `TenantUsers` | `tenant_users` | direct `tenant_id` | filtered role counts, join to `Users` |
| `ActivityEvents` | `activity_events` | direct | event stream (`meta.eventStream`) |
| `TenantActivityDaily` | `tenant_activity_daily_facts` | direct | fact-table cube (`sum`, `countDistinct`) |

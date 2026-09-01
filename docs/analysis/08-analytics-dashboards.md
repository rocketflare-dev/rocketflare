# 08 — Semantic layer, reporting & dashboards (drizzle-cube)

How GuideMode (GM) wires drizzle-cube 0.8.3 into a Hono-on-Workers app, keeps every cube query
tenant-scoped, pre-computes fact tables on a cron, seeds per-tenant dashboards from TS templates,
and what of that belongs in a generic multi-tenant kit. Sources are under
`~/work/guidemode/apps/server/` unless stated; `path:line` refers to that root.
mirevue has no analytics layer at all (grep for drizzle-cube/dashboard/analytics finds only its
evals harness), so GM is the sole reference here.

Legend: **KEEP** = generic, ship in kit v1 · **GENERICIZE** = keep the pattern, replace the
domain content · **DEFER** = documented extension, not in v1 · **STRIP** = GM-only.

---

## 1. drizzle-cube integration (Hono, security context, permissions)

### Mounting — per-request cube app (KEEP, simplify)

`src/api/index.ts:341-515`. A dedicated `Hono` sub-app runs `databaseMiddleware` and
`authMiddleware`, then a single catch-all middleware builds a fresh cube app **per request** and
forwards the raw request to it:

```ts
// src/api/index.ts:470-509 (trimmed)
const cubeApp = createCubeApp({
  cubes: allCubes,
  drizzle: db as any,          // Hyperdrive-backed drizzle from c.get('db')
  schema,
  extractSecurityContext,      // closure over c.get('auth')
  engineType: 'postgres',
  mcp: { enabled: true },
  ...(agentApiKey ? { agent: { provider, apiKey, model, maxTurns: 25, observability, buildSystemContext } } : {}),
  cors: { origin: [...localhost, APP_URL], credentials: true },
})
return await cubeApp.fetch(c.req.raw)
```

Mounted twice: `app.route('/cubejs-api', cubeApiApp)` and `app.route('/mcp', cubeApiApp)`
(`src/api/index.ts:511,515`). The adapter's default `basePath` is `/cubejs-api/v1`
(`node_modules/drizzle-cube/dist/adapters/hono/index.d.ts:71`), giving `/cubejs-api/v1/load`,
`/meta`, `/batch`, `/dry-run`, plus `/mcp` (MCP tools `discover`/`validate`/`load`) and, when
`agent` is configured, `POST /agent/chat` (SSE) for the Notebook feature.

Why per-request: the drizzle instance comes from the Hyperdrive binding on `c.env`, which only
exists inside a request in Workers, so the compiler cannot be built at module scope. This is the
correct Workers shape but it re-registers ~33 cubes on every analytics call. drizzle-cube's own
guidance for sharing a compiler across tenants is `SemanticLayerCompiler({ contextToCubeSetId })`
+ `registerCubeSet()` (`node_modules/drizzle-cube/dist/server/index.d.ts:36-46`) — see Risks.

### Tenant security context — the multi-tenant bit (KEEP)

Two copies exist. The exported one is `src/api/cubes/security.ts:8-20`:

```ts
export async function extractSecurityContext(c: Context): Promise<SecurityContext> {
  const auth = c.get('auth')
  if (!auth || !auth.tenantId) throw new Error('Authentication required for analytics access')
  return { tenantId: auth.tenantId, userId: auth.user?.id || auth.userId, permissions: auth.permissions }
}
```

The one actually used at runtime is the inline closure at `src/api/index.ts:349-363` (adds
`userName`). The kit should keep exactly one, the exported module, and pass it to `createCubeApp`.

Scoping is then enforced **inside every cube's `sql()`**, which receives `ctx.securityContext`:

- Direct column: `where: eq(teams.tenantId, ctx.securityContext.tenantId)` (`src/api/cubes/teams.ts:44-47`,
  also AND-ed with `isEnabled = true`); event streams the same (`pr-events.ts:26-29`).
- Via junction subquery for tables without a `tenant_id` (global `users`):
  `inArray(users.id, sql\`(SELECT user_id FROM tenant_users WHERE tenant_id = ${tenantId})\`)`
  (`src/api/cubes/users.ts:19-25`).
- Fact tables carry `tenant_id` as a plain column and filter on it (`analytics.md` pattern).

Findings that matter for the kit:
- **No cube reads `securityContext.permissions` or `.userId`** (grep of `src/api/cubes/` is empty).
  Cube access in GM is *authentication + tenant scoping only*. Row-level restriction by role is not
  done at the cube layer.
- There is no per-cube CASL gate. `Analytics` is a CASL subject in `DATA_RESOURCES`
  (`src/permissions/abilities.ts:17`) and every role including `member` gets `manage` on it
  (`abilities.ts:87`), so it is effectively "any authenticated tenant member". `AdvancedAnalytics`
  (`abilities.ts:23-27,147-170`) is a subscription-tier gate used by `SubscriptionGate` in the UI
  (`DashboardViewPage.tsx:10`), not by the cube API.
- drizzle-cube also offers `rlsSetup` (Postgres RLS per query, `hono/index.d.ts:94`) as an
  alternative/defence-in-depth. GM does not use it.

### Dashboard CRUD permissions (KEEP)

`src/api/routes/analytics-pages.ts` — reads require only auth + tenant (`:393-416`); every
mutating route calls `guardPermission(c, 'manage', 'Dashboard')` (`:540,590,629,699,737,807,863,974`).
`Dashboard` is in `MANAGEMENT_RESOURCES` → owner/admin `manage`, member `read`
(`abilities.ts:21,59,79,93`). Notebooks use the same subject (`routes/notebooks.ts:26`).

### `.drizzle-cube.json` (KEEP the pattern, gitignore it)

`{ serverUrl, apiToken, mode: "rest" }` — config for the drizzle-cube CLI / Claude Code plugin
(`README.md:319-327`) so a local agent can query the *deployed* `/cubejs-api` with a GM API key.
It contains a live bearer token; it is gitignored (`~/work/guidemode/.gitignore:134`). The kit
should ship `.drizzle-cube.json.example` and the ignore rule. The CLI's other job is
`npx drizzle-cube charts init` (custom chart scaffolding, `dist/cli/index.cjs:491-496`).

### Codegen

None. `src/ui/generated/` contains only `learn-index.json` (docs index), unrelated to cubes.

### UI client wiring (KEEP)

`CubeProvider` from `drizzle-cube/client/providers` with `apiOptions={{ apiUrl: '/cubejs-api/v1' }}`
— same-origin, cookie auth, no token header (`components/shared/DashboardLoader.tsx:106-115`,
`pages/Analytics/QueryBuilder.tsx:11-14`). Styles: `@import 'drizzle-cube/client/styles.css'` and
Tailwind `@source` over `node_modules/drizzle-cube/dist/client/**` (`src/ui/index.css:3,24`), plus a
block mapping DaisyUI theme vars onto drizzle-cube CSS vars (`index.css:411+`). Vite splits
`recharts`, `dc-charts`, `dc-core` into manual chunks and dedupes react/recharts
(`vite.config.ts:51-61,129`).

CF-compat: nothing Node-specific in the request path. The cube app is pure Hono; the drizzle
instance is `drizzle-orm/postgres-js` over Hyperdrive. Agent/MCP features run in-Worker (SSE).

---

## 2. Cube definitions

### Layout and conventions (KEEP)

- One file per cube in `src/api/cubes/*.ts` (33 files, 11.2k lines), `index.ts` exports
  `allCubes` sorted by title (`cubes/index.ts:44-79`).
- `defineCube('Name', { title, description, sql: ctx => ({ from, where }), joins, dimensions,
  measures, meta? })` from `drizzle-cube/server`. Dimensions/measures are objects keyed by name
  with `{ name, title, type, sql, primaryKey?, filters? }`; measures use `type:
  'count'|'avg'|...` with optional `filters: [() => eq(col, 'x')]` for filtered counts
  (`tenant-users.ts:70-108`).
- Joins: `belongsTo`/`hasMany`/`belongsToMany` with `on: [{ source, target }]` and `through`
  for many-to-many (`users.ts:27-49`). Circular references are handled with a `let cube: Cube`
  forward declaration + `targetCube: () => otherCube` thunks (`users.ts:8-14`).
- Event-stream cubes add `meta.eventStream: { bindingKey, timeDimension, eventDimension }` to
  unlock funnel/flow/retention modes (`pr-events.ts:31-37`; 5 cubes use it).
- No pre-aggregations or segments are used; pre-aggregation is done outside drizzle-cube via
  fact tables (section 3).
- `relationships.ts` walks `allCubes[].joins` to build a bidirectional adjacency list for the
  Giulia AI prompt (`cubes/relationships.ts:15-52`) — STRIP with Giulia, or keep as a 70-line
  utility if the kit ships the MCP/agent path.
- Contract: **measure/dimension names are frozen** because `analytics_pages.config` JSONB
  references them by string; `tests/api/cubes/assessments-cube.test.ts:10-20` pins them.

### Guidance doc

`~/work/guidemode/.claude/rules/server/analytics.md` — useful pattern doc but **stale**: says
"materialized views" and imports `defineCube` from `'drizzle-cube'` (real: physical tables since
migration 0155; import is `'drizzle-cube/server'`). `src/dashboards/DASHBOARD_PATTERNS.md` is
current and excellent — port it. `.claude/rules/server/analytics-engine.md` documents the CF
Analytics Engine schema (section 7).

### Which cubes to genericize vs strip

| Cube(s) | Over | Verdict |
|---|---|---|
| `Users` (112 lines), `TenantUsers` (110) | `users`, `tenant_users` | **GENERICIZE → kit examples.** Together they show both scoping patterns (junction subquery vs direct `tenant_id`), a `belongsTo`/`hasMany`/`belongsToMany` join set, time dimensions, and filtered role counts. Drop `githubId`, `firstSessionUploadedAt`. |
| `Teams`, `TeamMembers`, `TeamRepositories` | teams + junctions | GENERICIZE only if the kit's base schema has teams (per doc 02). `TeamRepositories` is domain. |
| `PREvents`, `IssueEvents`, `DeploymentEvents` | event tables | Pattern worth one generic **`ActivityEvents`/audit-log event-stream cube** (funnel/retention over `event_type`); content STRIP. |
| `Sessions`, `Metrics`, `Assessments`, `AIProductivity`, `AIVA*`, `Survey*`, `Issues`, `PullRequests`, `Deployments`, `Repositories`, `*Flow`, `*FlowHistory`, `ChangeValue`, `CompositeIndex` | GM domain | **STRIP.** |

---

## 3. Materialized fact tables

### Reality vs naming

They were Postgres materialized views; migration `migrations/0155_convert_fact_tables_to_physical.sql`
converted them to **physical tables** so refresh can be per-tenant and can run through Hyperdrive
(`REFRESH MATERIALIZED VIEW` needs a direct connection). The directory is still
`src/db/schema/materialized-views/` (12 files, 1.4k lines; `index.ts:1-7` documents this).

### Schema pattern (GENERICIZE)

`src/db/schema/materialized-views/deployment-flow-facts.ts:23-140`: ordinary `pgTable`, one row per
entity, natural PK (`deployment_id`), `tenant_id uuid not null` + index, denormalised dimensions,
pre-computed durations in seconds, boolean flags, and a **`fact_refreshed_at`** watermark column
(`:111`). Team membership is an array column `team_ids uuid[]` with a GIN index created in SQL
migration to avoid row explosion (`:30,:122`). Tables are created by raw SQL migration
(`CREATE TABLE ... AS SELECT`), the Drizzle definition exists for typing and cube SQL.

Layer 2, daily snapshots: `deployment-flow-daily-snapshot.ts:23-60` — grain
`(snapshot_date, tenant_id, team_id NULL=org)`, counts + `avg_*` + `*_count` pairs for weighted
re-aggregation, unique index on the grain with `COALESCE(team_id,'__ALL__')`.

Layer 3: `composite-index-snapshots.ts` — STRIP.

### Refresh mechanics (GENERICIZE)

Runtime service `src/api/services/fact-table-refresh/index.ts`:
- `queries/<table>.ts` exports two string builders, `xxxSelectAll()` and `xxxSelectForTenant(id)`
  (`refresh-fact-tables.ts:27-47`); `TENANT_SELECT_FN`/`ALL_SELECT_FN` maps (`index.ts:57-71`).
- `refreshTable()` does `DELETE FROM t [WHERE tenant_id = ...]` then `INSERT INTO t <select>` in one
  transaction (`index.ts:113-146`). **Full rebuild, not incremental** — the "watermark" is a
  stamped timestamp, not a high-water mark. Sequential to avoid contention.
- `refreshAllFactTables(db, { skipAnalyze })` optionally `ANALYZE`s the source tables first
  (`index.ts:77-110`); `refreshFactTablesForTenant(db, tenantId, tables?)` for on-demand after a
  sync/import (`index.ts:167-208`). Tenant id is regex-validated because it is interpolated into
  `sql.raw` (`index.ts:43,185`).
- Cron: `wrangler.toml` `[triggers] crons = ["15 * * * *", ...]`; `src/scheduled.ts:56-95`
  dispatches by derived UTC minute/hour (not by `event.cron`) — `minute === 15` → fact refresh
  (Hyperdrive db, `skipAnalyze: true`); `hour === 5 && minute === 0` → `createDailySnapshots`;
  `hour === 2` → `runMaintenance` on a **direct** `DATABASE_URL` connection (ANALYZE needs it). Every
  task is wrapped in its own try/catch so one failure never blocks the rest.
- Scripts (Node, `tsx`, `postgres` driver, `DATABASE_URL`): `scripts/refresh-fact-tables.ts`
  duplicates the service's DELETE+INSERT rather than importing it (`:82-98`) — the kit should import
  the service. `scripts/check-fact-table-freshness.ts:41-107` compares `MAX(updated_at)` on a source
  table vs the fact table and flags stale when lag > 2× the expected interval; its table list is
  hardcoded and already **omits `change_value_facts`** and mixes 15/60-minute intervals
  (`:118-140`). `scripts/create-daily-snapshots.ts` supports `--date`, `--tenant`, `--backfill=N`.
- Snapshot service `daily-snapshots/index.ts:33-55` is table-driven (`SNAPSHOT_CONFIGS` with
  `conflictTarget`), idempotent per date.

Tests: `tests/api/services/fact-table-refresh.test.ts` mocks `db.transaction` and asserts 5
tables refreshed; `tests/helpers/materialized-view-helpers.ts` reuses the real `selectAll` /
`selectForTenant` builders against the test DB under an advisory lock (`tests/helpers/db.ts:213`).

### Minimal generic version for the kit

One fact table + one refresh job + one freshness check, all driven by a single registry:

```ts
// src/analytics/facts/registry.ts (proposed)
export const FACT_TABLES = {
  tenant_activity_daily_facts: {
    selectAll, selectForTenant,           // SQL string builders
    sourceTable: 'activity_events', sourceTs: 'created_at',
    expectedIntervalMinutes: 60,
  },
} as const
```
`refreshAllFactTables`, `refreshFactTablesForTenant`, the freshness check, the CLI scripts and the
cron handler all iterate this one object, so adding a table is one entry. Keep `fact_refreshed_at`,
`tenant_id` index, natural PK, DELETE+INSERT per tenant. Drop the ANALYZE step and daily snapshots
from v1 (document as extension).

CF-compat: DELETE+INSERT works through Hyperdrive; `ANALYZE`/`REFRESH MATERIALIZED VIEW` do not
(need `DATABASE_URL` direct). Cron handler must stay under the Worker CPU limit — GM raised
`[limits] cpu_ms = 300000` for an unrelated Workflow (`wrangler.toml:57`); a full-rebuild fact
refresh across all tenants will hit the default 30 s CPU as data grows, hence per-tenant refresh
and eventually a Queue/Workflow fan-out.

---

## 4. Dashboards

### Template format (KEEP)

TypeScript modules exporting a `DashboardConfig` (type from `drizzle-cube/client`), grouped by
category in `src/dashboards/<type>-templates/*.ts` (22 templates, 9k lines), each category
`index.ts` exporting `Record<templateId, TemplateDefinition>` with
`{ name, description, config, order, type }` (`general-templates/index.ts:8-14`). Root registry
`src/dashboards/index.ts:19-56` merges them (`DASHBOARD_TEMPLATES`, `getAllTemplates()`).

A `DashboardConfig` (`general-templates/team-dashboard.ts:9-120`) has:
- `layoutMode: 'rows'` + explicit `rows: [{ id, h, columns: [{ portletId|groupId, w }] }]`
  (columns sum to 12), optional `groups` (KPI strips rendered as one card), `filters`
  (dashboard-level, incl. `isUniversalTime` + `member: '__universal_time__'`), and `portlets`
  each with `query: JSON.stringify(cubeQuery)`, `chartType`, `chartConfig {xAxis,yAxis,series}`,
  `displayConfig`, `dashboardFilterMapping: [filterId...]`, and legacy `x/y/w/h`.
- `DASHBOARD_PATTERNS.md` documents all of this incl. gotchas (rows mandatory or widths are
  discarded; `recordsTable` needs `ungrouped: true`; gauges need `h >= 3`).

### Templates → per-tenant dashboards (KEEP)

Table `analytics_pages` (`src/db/schema/analytics-pages.ts:26-50`): `tenant_id`, `name`,
`description`, `template_id text|null` (null = user-created), `type` pgEnum, `config jsonb
$type<DashboardConfig>`, `order`, `is_active` (soft delete), `created_by`. No separate widget
table — portlets live inside the JSONB. Sibling `notebooks` table for drizzle-cube Notebooks
(`schema/notebooks.ts`).

Lifecycle:
1. **Seed on tenant creation**: `createAllCoreDashboards(db, tenantId)` in
   `src/api/utils/db/tenant-helpers.ts:88-95` (non-fatal on error) → inserts one row per template
   (`services/dashboard-templates.ts:33-59`). Templates are `await import()`ed lazily to keep them
   off the hot path (`:73`).
2. **Lazy create on first view**: `GET /api/analytics-pages/by-template/:templateId` creates the
   row if missing (`routes/analytics-pages.ts:455-527`) — used by embedded `DashboardLoader`.
3. **Reset**: `POST /:id/reset-to-template` (`:727-793`), `POST /recreate-templates` (`:854+`,
   creates missing + resets existing core dashboards), and `scripts/reset-all-dashboards.ts`
   which walks every tenant via the admin API (`:1-16`) — because template changes only reach new
   tenants otherwise.
4. Edits auto-save the whole config via `PUT /:id` (`DashboardViewPage.tsx:44-60`).

Kit note: the pgEnum `dashboard_type` forced GM to reuse `'general'` for a new category
(`general-templates/index.ts:29-31`); use `text` in the kit.

### UI (KEEP, trimmed)

- Pages: `pages/Analytics/DashboardListPage.tsx` (list, filters core/mine, create, duplicate,
  recreate), `DashboardViewPage.tsx` (renders `<AnalyticsDashboard config editable onConfigChange
  onSave>` inside `CubeProvider`), `QueryBuilder.tsx` (`<AnalysisBuilder>` playground),
  `NotebooksListPage/NotebookViewPage` (AI notebooks), `Dashboard.tsx` (legacy localStorage-backed
  default dashboard — STRIP). Routes are lazy-loaded (`App.tsx:46-68`).
- Hooks: `hooks/useAnalyticsPages.ts` (react-query CRUD over `/api/analytics-pages`),
  `hooks/useCubeMeta.ts` (fetches `/cubejs-api/v1/meta`, measure picker for targets),
  `hooks/useDashboardDateFilter.ts` (overrides `isUniversalTime` filters from a page-level date
  range; drizzle-cube merges by filter id).
- Components: `components/shared/DashboardLoader.tsx` (embed a template dashboard anywhere with
  `filterOverrides`, e.g. Team page), `components/DashboardFormModal.tsx`. `config/dashboard-*.tsx`
  are hand-built `AnalyticsPortlet` grids (older approach) — STRIP.
- **Editor / widget query builder / drill-down are all drizzle-cube's**: `AnalyticsDashboard`
  provides the react-grid-layout editor, portlet editor with query builder, and chart rendering;
  `AnalysisBuilder` is the standalone explorer. GM writes no chart components for dashboards. A few
  places call `/cubejs-api/v1/batch` directly with `fetch` (`components/home/TeamPerformanceMetrics.tsx:441`).

### Chart libraries

GM depends on `recharts` (drizzle-cube's primary renderer; also used directly in ~5 GM files),
`@nivo/heatmap` (drizzle-cube heat-map/data-table chunks), `d3` (drizzle-cube activity-grid,
bubble, tree-map chunks). drizzle-cube's chart chunks statically import these
(`dist/client/chunks/chart-*.js`); `@nivo/heatmap` is an optional peer, but **`recharts` and `d3`
are non-optional peers** (`node_modules/drizzle-cube/package.json:260-280`). GM's only direct
non-recharts chart is `components/charts/CapabilityRadarChart.tsx` (AIVA, STRIP).

**Recommendation: recharts** as the kit's single app-level chart library. Keep `d3` installed
only as drizzle-cube's peer (never import it in kit code); leave `@nivo/heatmap` out unless the
heat-map chart type is wanted. Keep the vite `manualChunks` + `dedupe: ['react','react-dom','recharts']`.

Tests: `tests/dashboards/all-templates.test.ts` asserts structural invariants for every template
(rows mode, widths sum to 12, unique ids, every column/cell resolves to a portlet, no dangling
`dashboardFilterMapping`, gauge height) — port verbatim. `tests/api/services/dashboard-templates.test.ts`
mocks `db.insert`.

---

## 5. Reporting / export

There is no scheduled/emailed reporting and no PDF pipeline. Four unrelated things share the deps:

| Piece | What | Verdict |
|---|---|---|
| `src/shared/reporting/report-artifact.ts` (249 lines) | Pure JSON "report envelope" (`stat/table/bar/histogram/scatter/box/note` sections) rendered by `scripts/report-template/render.ts` to static HTML for the CEU calibration study (`reports/change-scoring`). Node-only tooling. | STRIP |
| `src/api/services/xlsx-helpers.ts` + `surveys/response-export-service.ts`, `aiva/export-service.ts` | Server-side XLSX via `exceljs` (dynamic `import()` "for Workers compatibility", `:4`). | DEFER — generic "export a cube query result to XLSX" is a nice extension; exceljs alone is 534 modules in the Worker bundle. |
| `src/ui/lib/export-pptx.ts`, `pptx-shared.ts` (`pptxgenjs`) | AIVA assessment slide decks, client-side, lazy-loaded. | STRIP |
| `src/ui/lib/screenshot.ts` (`modern-screenshot`) | DOM→PNG for copy-to-clipboard/PPTX; also an optional drizzle-cube peer used for chart image export. | DEFER (small, client-only, optional) |

**Recommendation: reporting/export is not in kit v1.** Document CSV/XLSX export of a portlet query
as an extension recipe; if XLSX is wanted, keep it client-side (browser `exceljs`/SheetJS chunk)
rather than in the Worker.

---

## 6. `src/shared/*` classification

| Module | Nature | Verdict |
|---|---|---|
| `shared/stats/*` (bootstrap, correlation, regression, permutation, clustered, describe, power, commonality, linear-algebra; 1.4k lines) | Dependency-free statistics, pure, browser-safe, tested (`tests/shared`). | Generic utility — but nothing in the kit needs it. DEFER (mention as an optional package). |
| `shared/benchmarks/*` (metric-registry, dora-bands, oss-corpus) + `db/schema/metric-benchmarks.ts` + `services/benchmark-refresh` (monthly cron `0 6 1 * *`) | Cross-tenant percentile distributions with a 5-tenant privacy floor (`metric-registry.ts:27`). The *pattern* (cross-tenant aggregate table, min-N floor, monthly refresh) is generic; the metrics are DORA. | STRIP; note pattern in docs. |
| `shared/composite-index/*` + `services/composite-index` | Fused productivity index. | STRIP |
| `shared/scoring/*` | Likert/NPS/composite score formulas with a TS evaluator + drizzle SQL emitter pinned together by tests (`composites.ts:1-9`). Neat dual-interpreter pattern, domain content. | STRIP |
| `shared/target-calculations.ts`, `target-query-builder.ts` | Team metric targets. | STRIP |

Worth carrying over as a *rule*: `src/shared` is imported by the UI, so it must never import drizzle
or schema (`metric-registry.ts:9-14`).

---

## 7. Cloudflare Analytics Engine

Binding `ANALYTICS_ENGINE`, dataset `guidemode_analytics` (`wrangler.toml:224-227`). Purpose is
**product usage telemetry**, orthogonal to drizzle-cube (which is customer-facing analytics over
Postgres): `src/api/middleware/analytics.ts` writes `writeDataPoint({ blobs:[category,name,metaKey,
metaVal], doubles:[1], indexes:[tenantId] })`, never throws, skips when the binding is absent
(`:80-90`); login events in `auth/sessions.ts:48`. Read side: `services/analytics-query.ts` posts SQL
to `api.cloudflare.com/.../analytics_engine/sql` using `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`
(`:34-58`), surfaced by `routes/usage-analytics.ts` and `hooks/useUsageAnalytics.ts` (admin usage
page + `useTrackPageView`). Rule doc: `.claude/rules/server/analytics-engine.md`. 90-day retention.

**Recommendation: KEEP** the binding, the fire-and-forget middleware and `trackEvent` helper (tiny,
CF-native, free tier). Make the SQL-API read side optional (needs an account API token). Rename
dataset per kit.

---

## 8. Tests

- Unit, mocked DB: `tests/api/cubes/security.test.ts` (extractSecurityContext),
  `tests/api/services/fact-table-refresh.test.ts`, `dashboard-templates.test.ts`.
- Structural: `tests/api/cubes/assessments-cube.test.ts` (frozen member names via `allCubes`),
  `tests/api/cubes/relationships.test.ts`, `tests/dashboards/all-templates.test.ts`.
- Integration (real Postgres via `.env.test` `DATABASE_URL`, vitest `pool: 'forks'`, `maxForks: 3`,
  global setup `tests/setup.ts`): `tests/api/cubes/team-repositories.test.ts`, `survey-cubes.test.ts`;
  `tests/integration/cubes.test.ts` is `describe.skip` ("raw SQL helpers return null") — cube SQL
  compilation is **not** end-to-end tested. Helpers: `tests/helpers/cube-query-helpers.ts`
  (`createTestSecurityContext`, direct SQL on fact tables), `materialized-view-helpers.ts`.
- Gap the kit should close: one integration test that runs a query through
  `SemanticLayerCompiler`/`createCubeApp` with two tenants and asserts isolation (the helper
  `verifyTenantIsolation` exists but is unused).

---

## 9. CF-compat and bundle size

- Worker bundle today: `dist/index.js` 15.0 MB raw / **2.65 MB gzip** (limit 3 MB free, 10 MB paid).
  Single-file — wrangler does not split dynamic imports, so `exceljs` (534 modules) is in the
  Worker despite `await import()`. Top contributors by module count from the source map:
  `@paddle/paddle-node-sdk` 782, `exceljs` 534, `drizzle-orm` 106, `arctic` 70, `@anthropic-ai/sdk`
  51, `drizzle-cube` 44, `date-fns` 38, `hono` 34. drizzle-cube server+adapter is modest
  (`dist/server` 2.9 MB unminified on disk incl. agent/MCP; hono adapter 7.5 kB). Removing
  Paddle/exceljs/integrations puts the kit comfortably under 1 MB gzip.
- drizzle-cube non-optional peers (`package.json:260-280`) include `@anthropic-ai/sdk`,
  `@google/generative-ai`, `openai`, `elkjs`, `@xyflow/react`, `exceljs`, `d3`, `recharts`. Package
  managers only warn, but the kit's `package.json` should install `recharts`, `d3`,
  `react-grid-layout`, `react-is` and treat the AI SDKs as opt-in with `agent` env-conditional (GM
  pattern `index.ts:475-490`).
- UI: `dc-core` 880 kB, `recharts` 684 kB, `exceljs` 912 kB, `pptxgen` 368 kB, `analysis-builder`
  276 kB (`dist/ui/assets`). All lazy; fine for a SPA.
- `nodejs_compat` flag is required (`wrangler.toml:4`). Cron `scheduled` handler shares the Worker
  CPU budget; use per-tenant refresh + Queue fan-out before tenant count grows.
- Env var **names** touched by this subsystem (from `.dev.vars`/`wrangler.toml`; values omitted):
  `DATABASE_URL` (direct conn for scripts/maintenance), `APP_URL` (cube CORS), `ANTHROPIC_API_KEY`
  / `CLAUDE_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `AI_PROVIDER` / `AI_MODELS` (agent),
  `OAUTH_ENCRYPTION_KEY` (tenant AI config), `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`
  (Analytics Engine SQL API), `LANGFUSE_*` (agent tracing). Bindings: `HYPERDRIVE`, `ANALYTICS_ENGINE`.

---

## Recommendations

### (a) Proposed kit file list — `src/analytics/` module

```
src/api/cubes/
  index.ts                 allCubes registry
  security.ts              extractSecurityContext (single copy)
  users.ts                 Users cube (junction-subquery scoping)
  tenant-users.ts          TenantUsers cube (direct tenant_id scoping, role measures)
  activity-events.ts       ActivityEvents event-stream cube over the audit/activity table (meta.eventStream)
  tenant-activity-daily.ts Cube over the example fact table
src/api/routes/
  analytics-pages.ts       CRUD + by-template lazy create + reset-to-template + recreate-templates
  cube-api.ts              the per-request createCubeApp sub-app (mount at /cubejs-api and /mcp)
src/api/services/
  dashboard-templates.ts   createAllCoreDashboards / listAllTemplates / getDashboardTemplate
  fact-tables/
    registry.ts            FACT_TABLES config (selectAll/selectForTenant/source/interval)
    refresh.ts             refreshAllFactTables / refreshFactTablesForTenant (DELETE+INSERT)
    freshness.ts           checkFactTableFreshness (registry-driven)
    queries/tenant-activity-daily.ts
src/db/schema/
  analytics-pages.ts       (type as text, not pgEnum)
  facts/tenant-activity-daily-facts.ts  (+ SQL migration creating it)
src/scheduled.ts           minute===15 → fact refresh; hourly-gated daily tasks pattern
src/dashboards/
  index.ts                 registry + getAllTemplates
  DASHBOARD_PATTERNS.md    ported verbatim
  general-templates/{index.ts,tenant-overview.ts}
src/ui/
  pages/Analytics/{index.tsx,DashboardListPage.tsx,DashboardViewPage.tsx,QueryBuilder.tsx,types.ts}
  components/analytics/{DashboardLoader.tsx,DashboardFormModal.tsx}
  hooks/{useAnalyticsPages.ts,useDashboardDateFilter.ts,useCubeMeta.ts}
  index.css                drizzle-cube styles import + @source + theme var mapping
scripts/{refresh-fact-tables.ts,check-fact-table-freshness.ts}   thin wrappers over the services
tests/{api/cubes/security.test.ts,api/cubes/cube-isolation.test.ts,dashboards/all-templates.test.ts,
       api/services/fact-table-refresh.test.ts}
.drizzle-cube.json.example  (+ .gitignore entry)
```

### (b) The one example of each

- **Cube**: `Users` + `TenantUsers` (a pair, because the join between them is the point). Over the
  kit's `users`/`tenant_users` tables; measures `count`, `ownerCount/adminCount/memberCount`,
  dimensions `role`, `joinedAt`, `createdAt`.
- **Fact table**: `tenant_activity_daily_facts` — grain `(tenant_id, day, user_id)` with
  `event_count`, `distinct_event_types`, `first_event_at`, `last_event_at`, `fact_refreshed_at`,
  built from the kit's activity/audit-log table via DELETE+INSERT per tenant, refreshed hourly at
  :15, freshness = lag vs `MAX(created_at)` on the source. (Open question: depends on whether the
  base kit ships an audit/activity table — see doc 02/03.)
- **Dashboard template**: `tenant-overview` — group row of compact KPIs (members, owners/admins,
  active users last 30d), line "sign-ups over time" (`TenantUsers.joinedAt` by week), area "daily
  activity" from the fact cube, `proportionBar` members by role, `recordsTable` recent members;
  one `isUniversalTime` date filter; `layoutMode: 'rows'` with explicit rows and a group.

### (c) Chart library

**recharts** — drizzle-cube's renderer and a non-optional peer; GM's own direct charts are
recharts; keep `d3` only as an un-imported peer, drop `@nivo/heatmap`.

### (d) Defer

Reporting/export (xlsx/pptx/screenshot), Giulia AI dashboard generation (`routes/giulia.ts`,
`services/giulia-*`), drizzle-cube Notebooks + `agent` config (keep the env-conditional hook, no
UI), daily snapshots layer, cross-tenant benchmarks, composite index, scoring, stats, team
targets. Keep MCP enabled (free with the adapter) and the Analytics Engine middleware.

### (e) Open questions / risks

1. **Per-request compiler cost**: ~33 cubes re-registered per call today. Fine for a kit; document
   `SemanticLayerCompiler` + cube sets as the scaling path, and note that drizzle-cube's
   `cache: CacheConfig` (`MemoryCacheProvider` only in 0.8.3) is per-isolate on Workers — a KV
   provider would be a kit extension.
2. **Tenant isolation is convention, not enforcement**: every cube author must remember the
   `where` on `tenantId`. Add the two-tenant isolation integration test, and consider `rlsSetup`
   with Postgres RLS as defence in depth (GM has neither).
3. **Frozen member names**: dashboard JSONB references `Cube.measure` strings; renaming breaks
   stored dashboards silently. Ship the structural test and a "reset-to-template" path from day one.
4. **Cron CPU budget** for full-rebuild refresh across tenants; DELETE+INSERT also briefly empties
   the table for readers unless done per tenant.
5. **Peer-dependency footprint** of drizzle-cube (AI SDKs, elkjs, xyflow, exceljs) — decide whether
   the kit installs them or documents the warnings.
6. **Version pin**: GM pins `drizzle-cube` to exactly `0.8.3` and chases its layout semantics
   (rows/groups, `w` discarded without rows); the kit should pin too and carry the template test.
7. Stale GM docs (`analytics.md`) — do not copy; port `DASHBOARD_PATTERNS.md` instead.
8. `.drizzle-cube.json` holds a live token in GM's working tree (gitignored); the kit must ship only
   an example file.

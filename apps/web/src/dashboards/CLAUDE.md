# Dashboard templates — D19

TypeScript `DashboardConfig`s (type from `drizzle-cube/client`) that become per-tenant rows in
`analytics_pages`. Registry: `index.ts` (`DASHBOARD_TEMPLATES`, `getTemplate`, `listTemplates`);
categories are folders (`general-templates/`), each exporting `Record<key, DashboardTemplate>`.

- Read `DASHBOARD_PATTERNS.md` before writing one — the layout gotchas there are silent at runtime.
- `layoutMode: 'rows'` + explicit `rows` (widths sum to 12); `groups` for KPI strips; one
  `isUniversalTime` filter; `recordsTable` needs `ungrouped: true`; portlet x/y/w/h must mirror the
  rows. `tests/dashboards/all-templates.test.ts` (config project, no DB) asserts all of it AND that
  every `Cube.member` in a portlet query exists in `src/api/cubes/`; the cube isolation test
  additionally executes every portlet query against Postgres.
- Member names are frozen: a template references `Cube.measure` strings that are also stored in
  tenants' `analytics_pages.config`. Add measures, never rename them.
- Templates are pure data: no drizzle, no schema imports (the UI may import this folder).
- Changing a template only reaches NEW tenants; existing pages are repaired with
  `POST /api/analytics/pages/:id/reset` or `POST /api/analytics/templates/recreate`.

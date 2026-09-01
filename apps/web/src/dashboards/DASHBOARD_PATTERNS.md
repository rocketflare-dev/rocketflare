<!--
  Ported verbatim from the source app's src/dashboards/DASHBOARD_PATTERNS.md (D19). The member
  names in the examples (`DeliveryFlow.*`, `DeploymentFlow.*`, `DiscoveryFlow.*`, "DORA") are
  that app's cubes — the kit ships `Users`, `TenantUsers`, `ActivityEvents`, `TenantActivityDaily`
  (src/api/cubes/); the patterns apply unchanged. The test referenced below exists at
  apps/web/tests/dashboards/all-templates.test.ts.
-->

# Dashboard Configuration Patterns

Patterns for configuring drizzle-cube dashboards with filters, time dimensions, and chart options.

## Dashboard-Level Date Filters

Add date filters at the dashboard level to control date ranges across multiple portlets.

```typescript
filters: [
  {
    id: 'my-date-filter',
    label: 'Issue Closed',  // Descriptive label
    filter: {
      member: 'MyCube.dateField',
      operator: 'inDateRange',
      values: [],  // Empty for inDateRange
      dateRange: 'last 3 months',  // Default value
    },
  },
]
```

**Key points:**
- Use `operator: 'inDateRange'` for date filters
- `values` must be `[]` (empty array)
- `dateRange` holds the default (e.g., `'last 3 months'`, `'last 90 days'`)
- Create separate filters for each cube (filters are cube-specific)

## Multiple Cubes = Multiple Date Filters

When a dashboard uses multiple cubes, create a date filter for each:

```typescript
filters: [
  {
    id: 'delivery-date-filter',
    label: 'Issue Closed',
    filter: {
      member: 'DeliveryFlow.issueClosedAt',
      operator: 'inDateRange',
      values: [],
      dateRange: 'last 3 months',
    },
  },
  {
    id: 'deployment-date-filter',
    label: 'Deployed',
    filter: {
      member: 'DeploymentFlow.deploymentCreatedAt',
      operator: 'inDateRange',
      values: [],
      dateRange: 'last 3 months',
    },
  },
]
```

## Mapping Portlets to Filters

Each portlet specifies which filters apply via `dashboardFilterMapping`:

```typescript
{
  id: 'my-portlet',
  // ... query, chartType, etc.
  dashboardFilterMapping: ['team-filter', 'project-filter', 'my-date-filter'],
}
```

**Match the filter to the cube used in the portlet's query.**

## KPI Portlets with Time Dimensions

Add `timeDimensions` with `granularity` to enable sparkline trends in KPI cards:

```typescript
{
  id: 'my-kpi',
  title: 'My Metric',
  query: JSON.stringify({
    measures: ['MyCube.myMeasure'],
    timeDimensions: [
      {
        dimension: 'MyCube.dateField',
        granularity: 'week',  // or 'day', 'month'
        // No dateRange here - controlled by dashboard filter
      },
    ],
  }),
  chartType: 'kpiNumber',
  chartConfig: {
    yAxis: ['MyCube.myMeasure'],
  },
  dashboardFilterMapping: ['team-filter', 'project-filter', 'my-date-filter'],
}
```

**Key points:**
- Don't put `dateRange` in portlet queries - let dashboard filters control it
- `granularity: 'week'` is good for KPI sparklines over months
- The date filter applies to the `timeDimensions.dimension` field

## Stacked Percentage Area Charts

For showing proportions over time (e.g., work type distribution):

```typescript
{
  id: 'distribution-chart',
  title: 'Work Distribution',
  query: JSON.stringify({
    measures: ['MyCube.count'],
    dimensions: ['MyCube.category'],  // What to stack by
    timeDimensions: [
      {
        dimension: 'MyCube.dateField',
        granularity: 'day',  // or 'week' for smoother lines
      },
    ],
    order: { 'MyCube.dateField': 'asc' },
  }),
  chartType: 'area',
  chartConfig: {
    xAxis: ['MyCube.dateField'],
    yAxis: ['MyCube.count'],
    series: ['MyCube.category'],
  },
  displayConfig: {
    showLegend: true,
    stackType: 'percent',  // Shows as 100% stacked
    connectNulls: true,    // Connects gaps in data
  },
  dashboardFilterMapping: ['team-filter', 'project-filter', 'my-date-filter'],
}
```

## Multi-Measure Stacked Area

For comparing two measures as proportions (e.g., planned vs unplanned):

```typescript
{
  id: 'comparison-chart',
  title: 'Planned vs Unplanned',
  query: JSON.stringify({
    measures: ['MyCube.plannedCount', 'MyCube.unplannedCount'],
    timeDimensions: [
      {
        dimension: 'MyCube.dateField',
        granularity: 'week',
      },
    ],
    order: { 'MyCube.dateField': 'asc' },
  }),
  chartType: 'area',
  chartConfig: {
    xAxis: ['MyCube.dateField'],
    yAxis: ['MyCube.plannedCount', 'MyCube.unplannedCount'],
  },
  displayConfig: {
    showLegend: true,
    stackType: 'percent',
    connectNulls: true,
  },
  dashboardFilterMapping: ['team-filter', 'project-filter', 'my-date-filter'],
}
```

## Line Charts with Trends

```typescript
{
  id: 'trend-chart',
  title: 'Metric Trend',
  query: JSON.stringify({
    measures: ['MyCube.median', 'MyCube.p90'],
    timeDimensions: [
      {
        dimension: 'MyCube.dateField',
        granularity: 'week',
      },
    ],
    order: { 'MyCube.dateField': 'asc' },
  }),
  chartType: 'line',
  chartConfig: {
    xAxis: ['MyCube.dateField'],
    yAxis: ['MyCube.median', 'MyCube.p90'],
  },
  displayConfig: {
    showLegend: true,
    showGrid: true,
    connectNulls: true,
  },
  dashboardFilterMapping: ['team-filter', 'project-filter', 'my-date-filter'],
}
```

## Checklist for Dashboard Updates

1. **Identify cubes used** - List all cubes referenced in portlet queries
2. **Create date filters** - One per cube with appropriate date dimension
3. **Set sensible defaults** - `'last 3 months'` works well for most dashboards
4. **Update portlet mappings** - Add date filter to each portlet's `dashboardFilterMapping`
5. **Add time dimensions to KPIs** - Include `granularity: 'week'` for sparklines
6. **Remove hardcoded dateRanges** - Let dashboard filters control dates
7. **Use descriptive filter labels** - e.g., "Issue Closed", "Deployed", "Created"

---

## Layout: explicit `rows` are mandatory

Every template sets `layoutMode: 'rows'` **and** declares an explicit `rows` array.

Without `rows`, drizzle-cube calls `convertPortletsToRows`, which maps each portlet to
`w: 0` and then equalises — so **every authored `w` is discarded and all columns render
equal-width**. Templates carried decorative `w: 8` / `w: 4` values for a long time that
never reached the screen. An inferred row also cannot host a group.

```typescript
rows: [
  { id: 'row-x-0', h: 1, columns: [{ portletId: 'section-header', w: 12 }] },
  { id: 'row-x-1', h: 2, columns: [{ groupId: 'group-x-0', w: 12 }] },
  { id: 'row-x-2', h: 4, columns: [
    { portletId: 'trend', w: 8 },
    { portletId: 'breakdown', w: 4 },
  ]},
]
```

- Each row's `columns` must total **12**.
- `rows` is authoritative. Portlet `x/y/w/h` still exist (grid mode, the mobile stack and
  thumbnails read them, and drizzle-cube rewrites them whenever a user edits the layout),
  so they must agree with the rows. `tests/dashboards/all-templates.test.ts` asserts this.

## Combined portlets (groups)

A run of KPIs becomes one card with one header instead of four boxes:

```typescript
groups: [
  { id: 'group-x-0', title: 'DORA Metrics', direction: 'row',
    cells: [{ portletIds: ['a'] }, { portletIds: ['b'] }] },
]
```

- **Rows layout mode only.** Children stay flat in `portlets` and are referenced by id, so
  filters, refresh and thumbnails are unaffected.
- Cells divide the axis **evenly** — there is no per-cell width.
- Omit `title` where a markdown section header already sits directly above, or the heading
  appears twice. The delivery dashboards use markdown headers; the rest use group titles.
- A KPI keeps its label inside a group: the label comes from the cube measure, not the
  portlet header.

## KPI density

- `layout: 'compact'` on `kpiNumber` in strips of 4+, with the row at `h: 2`. Compact KPIs
  are exempt from the 200px minimum chart height, which is what makes `h: 2` legal.
- **`kpiDelta` is a judgment call.** `compact` *suppresses the histogram*, and the weekly
  `granularity` on those queries exists to feed that sparkline. Strips of 4+ go compact with
  `showBaseline: true` (the `previous -> current` pair replaces the trend); strips of 3 or
  fewer stay `auto` at `h: 3` and keep their histograms.

## Summary headers on line and area

`showSummary: true` renders current value and change-since-window-start above the plot,
computed client-side from the result set already fetched — no extra query.

- It **hides the bottom legend**, so drop `showLegend` when enabling it.
- The change is suppressed on a categorical x-axis, so only use it with a time dimension.
- **A chart with 4+ series needs the full 12 columns.** The band wraps onto a second line
  and, in a half-width column, leaves the plot almost no height. Charts whose series come
  from a *dimension* (work type, PR size) count too — assume 5-6 series.

## Gauges

Use `gauge` for scores on a **bounded** scale (`/4`, `/5`, `/7`, 0-100); keep counts and
durations as compact KPIs. `thresholds` are `{ value, color }` where `value` is a **0-1
fraction** of `minValue`→`maxValue` and `color` is a hex string — one of the few places
drizzle-cube reads an explicit colour rather than a palette index.

**Gauges are not exempt from the 200px minimum height**, so they must never sit in the
`h: 2` strips compact KPIs use. Give them a row of `h >= 3`; the test enforces it.

## Part-to-whole: `proportionBar`, not `pie`

One 100%-wide stacked bar with a labelled percentage legend. Shares compare far better
along a single axis and it costs a fraction of the vertical space. Also exempt from the
200px floor.

## Records tables

`recordsTable` is **record-grain**: its query must set `ungrouped: true`, so it replaces
row-per-entity listings only. An aggregate group-by table stays `chartType: 'table'`.

This is a real constraint on the cube, not just the dashboard: an `avg` measure has nothing
to average in an ungrouped query, so the underlying column must also be exposed as a
*dimension* (see `DiscoveryFlow.insightShelfLifeDays`). Badge colours are palette indices;
`rowLink` tokens may reference `hiddenColumns`, which are fetched but never rendered.

## Gradient area fills

Unstacked areas get a vertical gradient fade; **stacked areas keep a flat fill** because a
fade muddies the band boundaries. This is drizzle-cube behaviour, not a config option — if
two area charts look different, check their `stackType`.

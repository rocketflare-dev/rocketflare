/**
 * `tenant-overview` dashboard template (D19) — the one dashboard every tenant gets. It exercises
 * every ship-set cube (`TenantUsers`, `Users`, `TenantActivityDaily`) and the layout rules in
 * ../DASHBOARD_PATTERNS.md: `layoutMode: 'rows'` with explicit rows (widths sum to 12), a compact
 * KPI group, one `isUniversalTime` filter mapped to the time-series portlets, a `proportionBar`
 * for part-to-whole, and a `recordsTable` (record grain → `ungrouped: true`). Portlet x/y/w/h
 * mirror the rows — `tests/dashboards/all-templates.test.ts` asserts they agree. Member names
 * here are the frozen contract with `src/api/cubes/`.
 */
import type { DashboardConfig } from 'drizzle-cube/client'

const TIME_FILTER = 'time-filter'

export const TENANT_OVERVIEW_TEMPLATE: DashboardConfig = {
  layoutMode: 'rows',
  filters: [
    {
      id: TIME_FILTER,
      label: 'Date Range',
      isUniversalTime: true,
      filter: { member: '__universal_time__', operator: 'inDateRange', values: ['last 90 days'] },
    },
  ],
  groups: [
    {
      id: 'group-overview-kpis',
      title: 'Organisation',
      direction: 'row',
      cells: [
        { portletIds: ['members-total'] },
        { portletIds: ['members-owners'] },
        { portletIds: ['members-admins'] },
        { portletIds: ['active-users-30d'] },
      ],
    },
  ],
  rows: [
    { id: 'row-overview-0', h: 2, columns: [{ groupId: 'group-overview-kpis', w: 12 }] },
    {
      id: 'row-overview-1',
      h: 5,
      columns: [
        { portletId: 'signups-over-time', w: 6 },
        { portletId: 'members-by-role', w: 6 },
      ],
    },
    { id: 'row-overview-2', h: 5, columns: [{ portletId: 'daily-activity', w: 12 }] },
    { id: 'row-overview-3', h: 5, columns: [{ portletId: 'recent-members', w: 12 }] },
  ],
  portlets: [
    // Row 0 — compact KPI strip (4 cells × w3, h2)
    {
      id: 'members-total',
      title: 'Members',
      query: JSON.stringify({ measures: ['TenantUsers.count'] }),
      chartType: 'kpiNumber',
      chartConfig: { yAxis: ['TenantUsers.count'] },
      displayConfig: { layout: 'compact', valueColorIndex: 0 },
      dashboardFilterMapping: [],
      x: 0,
      y: 0,
      w: 3,
      h: 2,
    },
    {
      id: 'members-owners',
      title: 'Owners',
      query: JSON.stringify({ measures: ['TenantUsers.ownerCount'] }),
      chartType: 'kpiNumber',
      chartConfig: { yAxis: ['TenantUsers.ownerCount'] },
      displayConfig: { layout: 'compact', valueColorIndex: 1 },
      dashboardFilterMapping: [],
      x: 3,
      y: 0,
      w: 3,
      h: 2,
    },
    {
      id: 'members-admins',
      title: 'Admins',
      query: JSON.stringify({ measures: ['TenantUsers.adminCount'] }),
      chartType: 'kpiNumber',
      chartConfig: { yAxis: ['TenantUsers.adminCount'] },
      displayConfig: { layout: 'compact', valueColorIndex: 2 },
      dashboardFilterMapping: [],
      x: 6,
      y: 0,
      w: 3,
      h: 2,
    },
    {
      // Deliberately NOT mapped to the dashboard date filter: "last 30 days" is the KPI's meaning.
      id: 'active-users-30d',
      title: 'Active Users (30d)',
      query: JSON.stringify({
        measures: ['TenantActivityDaily.activeUsers'],
        timeDimensions: [{ dimension: 'TenantActivityDaily.day', dateRange: 'last 30 days' }],
      }),
      chartType: 'kpiNumber',
      chartConfig: { yAxis: ['TenantActivityDaily.activeUsers'] },
      displayConfig: { layout: 'compact', valueColorIndex: 3 },
      dashboardFilterMapping: [],
      x: 9,
      y: 0,
      w: 3,
      h: 2,
    },

    // Row 1 — sign-ups trend + role share
    {
      id: 'signups-over-time',
      title: 'Sign-ups Over Time',
      query: JSON.stringify({
        measures: ['TenantUsers.count'],
        timeDimensions: [{ dimension: 'TenantUsers.joinedAt', granularity: 'week' }],
        order: { 'TenantUsers.joinedAt': 'asc' },
      }),
      chartType: 'line',
      chartConfig: { xAxis: ['TenantUsers.joinedAt'], yAxis: ['TenantUsers.count'] },
      displayConfig: { showSummary: true, showGrid: true, connectNulls: true },
      dashboardFilterMapping: [TIME_FILTER],
      x: 0,
      y: 2,
      w: 6,
      h: 5,
    },
    {
      id: 'members-by-role',
      title: 'Members by Role',
      query: JSON.stringify({
        measures: ['TenantUsers.count'],
        dimensions: ['TenantUsers.role'],
        order: { 'TenantUsers.count': 'desc' },
      }),
      chartType: 'proportionBar',
      chartConfig: { xAxis: ['TenantUsers.role'], yAxis: ['TenantUsers.count'] },
      displayConfig: { showLegend: true, showPercentages: true },
      dashboardFilterMapping: [],
      x: 6,
      y: 2,
      w: 6,
      h: 5,
    },

    // Row 2 — daily activity from the fact table
    {
      id: 'daily-activity',
      title: 'Daily Activity',
      query: JSON.stringify({
        measures: ['TenantActivityDaily.eventCount'],
        timeDimensions: [{ dimension: 'TenantActivityDaily.day', granularity: 'day' }],
        order: { 'TenantActivityDaily.day': 'asc' },
      }),
      chartType: 'area',
      chartConfig: {
        xAxis: ['TenantActivityDaily.day'],
        yAxis: ['TenantActivityDaily.eventCount'],
      },
      displayConfig: { showSummary: true, showGrid: true, connectNulls: true },
      dashboardFilterMapping: [TIME_FILTER],
      x: 0,
      y: 7,
      w: 12,
      h: 5,
    },

    // Row 3 — record-grain table (ungrouped). Cross-cube ungrouped queries are only legal when
    // every join between the cubes involved is belongsTo/hasOne — which is why `Users` declares no
    // hasMany joins (see src/api/cubes/users.ts).
    {
      id: 'recent-members',
      title: 'Recent Members',
      query: JSON.stringify({
        dimensions: ['TenantUsers.role', 'TenantUsers.joinedAt', 'Users.name', 'Users.email'],
        order: { 'TenantUsers.joinedAt': 'desc' },
        limit: 25,
        ungrouped: true,
      }),
      chartType: 'recordsTable',
      chartConfig: {
        columns: ['Users.name', 'Users.email', 'TenantUsers.role', 'TenantUsers.joinedAt'],
      },
      displayConfig: {
        pageSize: 10,
        columnFormats: {
          'TenantUsers.role': { kind: 'badge' },
          'TenantUsers.joinedAt': { kind: 'date', dateGranularity: 'day' },
        },
      },
      dashboardFilterMapping: [TIME_FILTER],
      x: 0,
      y: 12,
      w: 12,
      h: 5,
    },
  ],
}

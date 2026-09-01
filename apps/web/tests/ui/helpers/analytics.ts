/**
 * Fixtures for the analytics UI tests (D19): wire-shaped `analytics_pages` rows (ISO strings, as
 * the server sends them) — a template page and a user-created page.
 */
import { IDS } from './renderWithProviders'

export const PAGE_IDS = {
  template: '77777777-7777-4777-8777-777777777777',
  custom: '88888888-8888-4888-8888-888888888888',
}

const now = '2025-06-01T00:00:00Z'

export const TEMPLATE_CONFIG = {
  layoutMode: 'rows',
  filters: [
    {
      id: 'time-filter',
      label: 'Date Range',
      isUniversalTime: true,
      filter: { member: '__universal_time__', operator: 'inDateRange', values: ['last 90 days'] },
    },
    {
      id: 'role-filter',
      label: 'Role',
      filter: { member: 'TenantUsers.role', operator: 'equals', values: ['member'] },
    },
  ],
  rows: [{ id: 'row-0', h: 5, columns: [{ portletId: 'p1', w: 12 }] }],
  portlets: [
    {
      id: 'p1',
      title: 'Members',
      query: JSON.stringify({ measures: ['TenantUsers.count'] }),
      chartType: 'kpiNumber',
      chartConfig: { yAxis: ['TenantUsers.count'] },
      displayConfig: {},
      dashboardFilterMapping: ['time-filter'],
      x: 0,
      y: 0,
      w: 12,
      h: 5,
    },
  ],
}

export function analyticsPage(overrides: Record<string, unknown> = {}) {
  return {
    id: PAGE_IDS.template,
    tenantId: IDS.tenant,
    slug: 'tenant-overview',
    name: 'Organisation Overview',
    description: 'Members, roles and activity',
    templateKey: 'tenant-overview',
    config: TEMPLATE_CONFIG,
    isDefault: true,
    order: 0,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

export function customPage(overrides: Record<string, unknown> = {}) {
  return analyticsPage({
    id: PAGE_IDS.custom,
    slug: 'sales',
    name: 'Sales',
    description: null,
    templateKey: null,
    config: { layoutMode: 'rows', rows: [], portlets: [] },
    isDefault: false,
    order: 100,
    createdBy: IDS.user,
    ...overrides,
  })
}

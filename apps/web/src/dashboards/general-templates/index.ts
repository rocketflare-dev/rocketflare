/**
 * General dashboard templates (D19): tenant-wide views over the kit's own tables. An app adds a
 * category by creating a sibling folder and spreading it into `DASHBOARD_TEMPLATES` in `../index.ts`.
 */
import type { DashboardTemplate } from '../types'
import { TENANT_OVERVIEW_TEMPLATE } from './tenant-overview'

export const GENERAL_TEMPLATES: Record<string, DashboardTemplate> = {
  'tenant-overview': {
    key: 'tenant-overview',
    name: 'Organisation Overview',
    description: 'Members, roles, sign-ups and daily activity for the organisation',
    order: 10,
    isDefault: true,
    config: TENANT_OVERVIEW_TEMPLATE,
  },
}

export { TENANT_OVERVIEW_TEMPLATE }

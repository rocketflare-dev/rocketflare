/**
 * Dashboard template registry (D19). `DASHBOARD_TEMPLATES` is the ONLY definition of "the
 * dashboards every tenant gets": `ensureDefaultDashboards` (tenant creation + lazy on first list),
 * `resetToTemplate`, `recreateTemplates`, `GET /api/analytics/templates` and
 * `tests/dashboards/all-templates.test.ts` all read it. Pure data — importable by tests without a
 * database. Layout rules: ./DASHBOARD_PATTERNS.md.
 */
import { GENERAL_TEMPLATES } from './general-templates'
import type { DashboardTemplate } from './types'

export const DASHBOARD_TEMPLATES: Record<string, DashboardTemplate> = {
  ...GENERAL_TEMPLATES,
}

export function getTemplate(key: string): DashboardTemplate | null {
  return DASHBOARD_TEMPLATES[key] ?? null
}

/** Every template, in nav order. */
export function listTemplates(): DashboardTemplate[] {
  return Object.values(DASHBOARD_TEMPLATES).sort((a, b) => a.order - b.order)
}

export type { DashboardTemplate }

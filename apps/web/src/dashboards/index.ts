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

/**
 * Every template the caller may see, in nav order. `features` is `AuthContext.features`; a template
 * declaring a `feature` nobody holds is omitted everywhere templates are read — listed, seeded,
 * reset and recreated — because those are the four ways a page reaches a tenant (D30).
 */
export function listTemplates(features: readonly string[] = []): DashboardTemplate[] {
  return Object.values(DASHBOARD_TEMPLATES)
    .filter(t => t.feature === undefined || features.includes(t.feature))
    .sort((a, b) => a.order - b.order)
}

export type { DashboardTemplate }

/**
 * A dashboard template (D19): a named `DashboardConfig` copied into `analytics_pages` for every
 * tenant by `services/dashboard-templates.ts`. `key` is also the page slug.
 */
import type { DashboardConfig } from 'drizzle-cube/client'

export interface DashboardTemplate {
  key: string
  name: string
  description: string
  /** Position in the Analytics nav; unique across templates (the template test enforces). */
  order: number
  /** The page the Analytics section opens first; at most one template should set it. */
  isDefault?: boolean
  /**
   * Belongs to a feature that may ship dark (D30). A template whose feature the request does not
   * hold is never listed and never copied into a tenant, so an unreleased surface cannot appear in
   * Analytics. This is the sharpest of the feature doors: `ensureDefaultDashboards` runs lazily on
   * EVERY `GET /api/analytics/pages`, so without it the page would seed itself into every tenant on
   * the first load after deploy — a gate that creates rows, not one that merely reveals them.
   */
  feature?: string
  config: DashboardConfig
}

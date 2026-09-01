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
  config: DashboardConfig
}

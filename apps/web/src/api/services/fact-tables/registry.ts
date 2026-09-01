/**
 * Fact-table registry (D19) — the ONE list that `refresh.ts`, `freshness.ts`, the `:15` cron task
 * (`api/scheduled.ts`) and the two scripts iterate. Adding a fact table = a schema file under
 * `db/schema/facts/`, a `queries/<name>.ts` SELECT builder, and one entry here. Every table
 * carries `tenant_id` (rebuilt per tenant) and `fact_refreshed_at` (the freshness watermark).
 */
import type { SQL } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { activityEvents, tenantActivityDailyFacts } from '../../../db/schema'
import { tenantActivityDailySelect } from './queries/tenant-activity-daily'

export interface FactTableDefinition {
  /** Physical table name — also the key used by the scripts and `GET /api/analytics/facts/status`. */
  name: string
  /** Drizzle mirror; its column order is the INSERT's column list. */
  table: PgTable
  /** How often the cron rebuilds it; freshness flags `stale` past 2× this. */
  refreshIntervalMinutes: number
  /** Where the rows come from — `MAX(timestampColumn)` is the "newest source row" for freshness. */
  source: { name: string; table: PgTable; timestampColumn: PgColumn }
  /** The parameterised SELECT producing this tenant's rows, in `table` column order. */
  selectForTenant(tenantId: string): SQL
}

export const FACT_TABLES: readonly FactTableDefinition[] = [
  {
    name: 'tenant_activity_daily_facts',
    table: tenantActivityDailyFacts,
    refreshIntervalMinutes: 60,
    source: {
      name: 'activity_events',
      table: activityEvents,
      timestampColumn: activityEvents.createdAt,
    },
    selectForTenant: tenantActivityDailySelect,
  },
]

export type FactTableName = (typeof FACT_TABLES)[number]['name']

export function getFactTable(name: string): FactTableDefinition {
  const def = FACT_TABLES.find(t => t.name === name)
  if (!def) {
    throw new Error(
      `Unknown fact table "${name}" (known: ${FACT_TABLES.map(t => t.name).join(', ')})`
    )
  }
  return def
}

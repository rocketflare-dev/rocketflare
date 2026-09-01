/**
 * Fact-table freshness (D19): for each registry entry compare the newest source row
 * (`MAX(source.timestampColumn)`) with the newest rebuild (`MAX(fact_refreshed_at)`). `lagSeconds`
 * is how long the newest source row has waited for a refresh — 0 when the fact table is newer than
 * the source; `stale` when that exceeds 2× the table's refresh interval (one missed cron is fine,
 * two is not). A table never built while the source has rows is measured against `now`.
 * Read by `GET /api/analytics/facts/status` (admin+) and `scripts/check-fact-table-freshness.ts`.
 */
import type { FactTableStatus } from '@rocketflare/shared/analytics'
import { sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { FACT_TABLES, type FactTableDefinition } from './registry'

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

async function maxOf(db: Database, query: ReturnType<typeof sql>): Promise<Date | null> {
  const rows = (await db.execute(query)) as unknown as Array<{ max_ts: unknown }>
  return toDate(rows[0]?.max_ts)
}

export function computeFreshness(
  def: Pick<FactTableDefinition, 'name' | 'refreshIntervalMinutes'>,
  refreshedAt: Date | null,
  sourceMaxAt: Date | null,
  now: Date = new Date()
): FactTableStatus {
  let lagSeconds = 0
  if (sourceMaxAt) {
    // Never built: every source row is waiting, measured from the newest one to now.
    // Built: the newest source row has waited since the last build (0 if the build is newer).
    const reference = refreshedAt
      ? sourceMaxAt.getTime() - refreshedAt.getTime()
      : now.getTime() - sourceMaxAt.getTime()
    lagSeconds = Math.max(0, Math.floor(reference / 1000))
  }
  return {
    table: def.name,
    refreshedAt,
    lagSeconds,
    stale: lagSeconds > def.refreshIntervalMinutes * 60 * 2,
  }
}

export async function checkFactTableFreshness(
  db: Database,
  now: Date = new Date()
): Promise<FactTableStatus[]> {
  const out: FactTableStatus[] = []
  for (const def of FACT_TABLES) {
    const [refreshedAt, sourceMaxAt] = await Promise.all([
      maxOf(db, sql`select max(fact_refreshed_at) as max_ts from ${def.table}`),
      maxOf(db, sql`select max(${def.source.timestampColumn}) as max_ts from ${def.source.table}`),
    ])
    out.push(computeFreshness(def, refreshedAt, sourceMaxAt, now))
  }
  return out
}

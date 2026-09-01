/**
 * Fact-table freshness from a shell (D19) — wraps `services/fact-tables/freshness.ts` (the same
 * check `GET /api/analytics/facts/status` serves). Node-only; `DATABASE_URL` from `.dev.vars` via
 * `pnpm --filter @gmgo/web db:check-facts`. Exit 1 when any table is stale (lag > 2× its interval).
 */

import { checkFactTableFreshness } from '../src/api/services/fact-tables'
import { closeAllDatabases, getScriptDatabase } from '../src/db/client'

function describe(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required (db:check-facts loads .dev.vars)')
  const statuses = await checkFactTableFreshness(getScriptDatabase(url))
  console.log(`Fact table freshness at ${new Date().toISOString()}`)
  for (const s of statuses) {
    const refreshed = s.refreshedAt ? s.refreshedAt.toISOString() : 'never'
    console.log(
      `  ${s.table.padEnd(32)} refreshed=${refreshed.padEnd(24)} lag=${describe(s.lagSeconds).padEnd(6)} ${s.stale ? 'STALE' : 'fresh'}`
    )
  }
  await closeAllDatabases()
  process.exit(statuses.some(s => s.stale) ? 1 : 0)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

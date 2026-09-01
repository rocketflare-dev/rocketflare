/**
 * Rebuild fact tables from a shell (D19) — a thin wrapper over `services/fact-tables/refresh.ts`,
 * the same code the `:15` cron runs. Node-only; `DATABASE_URL` from `.dev.vars` via
 * `pnpm --filter @gmgo/web db:refresh-facts [table] [--tenant=<uuid>]`.
 * Exit 1 when any tenant/table failed.
 */

import {
  FACT_TABLES,
  type FactRefreshResult,
  refreshAllFactTables,
  refreshFactTable,
} from '../src/api/services/fact-tables'
import { closeAllDatabases, getScriptDatabase } from '../src/db/client'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required (db:refresh-facts loads .dev.vars)')
  const args = process.argv.slice(2)
  const tenantId = args.find(a => a.startsWith('--tenant='))?.slice('--tenant='.length)
  if (tenantId && !UUID_RE.test(tenantId)) throw new Error(`Invalid tenant UUID: ${tenantId}`)
  const table = args.find(a => !a.startsWith('--'))
  if (table && !FACT_TABLES.some(t => t.name === table)) {
    throw new Error(
      `Unknown fact table "${table}". Known: ${FACT_TABLES.map(t => t.name).join(', ')}`
    )
  }

  const db = getScriptDatabase(url)
  console.log(
    `Refreshing ${table ?? 'all fact tables'} for ${tenantId ? `tenant ${tenantId}` : 'all tenants'}…`
  )
  const results: FactRefreshResult[] = table
    ? [await refreshFactTable(db, table, { tenantId })]
    : (await refreshAllFactTables(db, { tenantId })).results
  for (const r of results) {
    console.log(`  ${r.table.padEnd(32)} tenants=${r.tenants} rows=${r.rows} ${r.durationMs}ms`)
    for (const e of r.errors) console.log(`    FAILED tenant ${e.tenantId}: ${e.error}`)
  }
  await closeAllDatabases()
  process.exit(results.some(r => r.errors.length > 0) ? 1 : 0)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

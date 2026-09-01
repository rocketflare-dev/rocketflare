/**
 * Fact-table refresh (D19): per tenant, in one transaction, `DELETE … WHERE tenant_id = $1` then
 * `INSERT INTO t (cols) <selectForTenant>`. A full rebuild, not incremental — `fact_refreshed_at`
 * is a stamp, not a high-water mark. Per tenant because (a) Hyperdrive cannot run
 * `REFRESH MATERIALIZED VIEW`, (b) other tenants' rows stay readable during the rebuild, and (c) a
 * bad tenant fails alone. Tenants are processed sequentially to bound connection use; the cron
 * budget grows with tenant count — the scaling path is fanning tenants out through `JOBS_QUEUE`.
 * Service signature `(db, …)`; the logger is optional so scripts and tests can omit it.
 */
import { getTableColumns, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { tenants } from '../../../db/schema'
import type { Logger } from '../../utils/core/logger'
import { FACT_TABLES, type FactTableDefinition, getFactTable } from './registry'

export interface TenantRefreshError {
  tenantId: string
  error: string
}

export interface FactRefreshResult {
  table: string
  /** Tenants attempted. */
  tenants: number
  /** Rows inserted across all successful tenants. */
  rows: number
  durationMs: number
  errors: TenantRefreshError[]
}

export interface FactRefreshSummary {
  results: FactRefreshResult[]
  durationMs: number
  /** Sum of `errors.length` — non-zero means at least one tenant/table failed. */
  failed: number
}

export interface RefreshOptions {
  /** Only this tenant; default = every row of `tenants`. */
  tenantId?: string
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>
}

/** The INSERT target list, derived from the mirror so it cannot drift from the schema. */
export function factTableColumnNames(def: FactTableDefinition): string[] {
  return Object.values(getTableColumns(def.table)).map(column => column.name)
}

/** DELETE + INSERT for one tenant, atomically. Returns the number of rows inserted. */
export async function refreshFactTableForTenant(
  db: Database,
  def: FactTableDefinition,
  tenantId: string
): Promise<number> {
  const columns = sql.join(
    factTableColumnNames(def).map(name => sql.identifier(name)),
    sql`, `
  )
  return db.transaction(async tx => {
    await tx.execute(sql`delete from ${def.table} where tenant_id = ${tenantId}`)
    const inserted = await tx.execute(
      sql`insert into ${def.table} (${columns}) ${def.selectForTenant(tenantId)}`
    )
    // postgres.js returns a RowList whose `count` is the statement's affected-row count.
    return (inserted as unknown as { count?: number }).count ?? 0
  })
}

async function listTenantIds(db: Database): Promise<string[]> {
  return (await db.select({ id: tenants.id }).from(tenants).orderBy(tenants.createdAt)).map(
    r => r.id
  )
}

/** Rebuild one fact table for one tenant or for every tenant (errors isolated per tenant). */
export async function refreshFactTable(
  db: Database,
  name: string,
  options: RefreshOptions = {}
): Promise<FactRefreshResult> {
  const def = getFactTable(name)
  const started = Date.now()
  const tenantIds = options.tenantId ? [options.tenantId] : await listTenantIds(db)
  const result: FactRefreshResult = {
    table: def.name,
    tenants: tenantIds.length,
    rows: 0,
    durationMs: 0,
    errors: [],
  }
  for (const tenantId of tenantIds) {
    try {
      result.rows += await refreshFactTableForTenant(db, def, tenantId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.errors.push({ tenantId, error: message })
      options.logger?.error({ table: def.name, tenantId, err: error }, 'fact refresh failed')
    }
  }
  result.durationMs = Date.now() - started
  options.logger?.info(
    { table: def.name, tenants: result.tenants, rows: result.rows, durationMs: result.durationMs },
    'fact table refreshed'
  )
  return result
}

/** Every registered fact table, sequentially. What the `:15` cron and `db:refresh-facts` run. */
export async function refreshAllFactTables(
  db: Database,
  options: RefreshOptions = {}
): Promise<FactRefreshSummary> {
  const started = Date.now()
  const results: FactRefreshResult[] = []
  for (const def of FACT_TABLES) results.push(await refreshFactTable(db, def.name, options))
  return {
    results,
    durationMs: Date.now() - started,
    failed: results.reduce((n, r) => n + r.errors.length, 0),
  }
}

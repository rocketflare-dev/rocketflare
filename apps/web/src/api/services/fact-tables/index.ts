/** Fact tables (D19): registry-driven per-tenant DELETE+INSERT refresh and freshness. See CLAUDE.md. */
export { checkFactTableFreshness, computeFreshness } from './freshness'
export {
  type FactRefreshResult,
  type FactRefreshSummary,
  factTableColumnNames,
  refreshAllFactTables,
  refreshFactTable,
  refreshFactTableForTenant,
} from './refresh'
export { FACT_TABLES, type FactTableDefinition, getFactTable } from './registry'

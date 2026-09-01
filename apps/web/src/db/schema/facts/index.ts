/**
 * Fact tables (D19): pre-aggregated, tenant-scoped tables rebuilt by
 * `services/fact-tables/refresh.ts`. One example ships; add a table here AND in
 * `services/fact-tables/registry.ts` (the refresh/freshness/cron all iterate the registry).
 */
export * from './tenant-activity-daily-facts'

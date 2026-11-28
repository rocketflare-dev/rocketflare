/**
 * The app's own domains, tables — ONE `export *` per domain that has tables, written by hand.
 * Re-exported by one line in `db/schema/index.ts`, so a domain's tables are migrated
 * (`pnpm db:generate`), RLS-checked and typed exactly like core's and a plugin's. App-owned, like
 * `app.ts`.
 */
export * from './example-hr/db/schema'
export * from './example-sales/db/schema'

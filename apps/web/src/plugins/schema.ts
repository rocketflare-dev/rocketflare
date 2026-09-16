/**
 * The plugin schema barrel (D31) — ONE `export *` per installed plugin, written by
 * `pnpm plugin add|remove`, never by hand:
 *
 *     export * from './approvals/db/schema'
 *
 * It is re-exported as the LAST line of `src/db/schema/index.ts`, which is the one surface
 * `drizzle.config.ts`, `db/client.ts` (`typeof schema`) and `rls-coverage.test.ts` read. So a
 * plugin table is migrated, RLS-checked and typed exactly like a kit table, and a name collision
 * between two plugins is a TypeScript error rather than a silent shadow.
 *
 * Nothing here is ever copied into a migration: the host runs `pnpm db:generate` after the barrel
 * line is written, so the DDL is numbered in the host's own journal.
 */
export {}

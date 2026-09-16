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
 *
 * **A plugin declares `relations()` for its OWN tables only — never a second `relations()` for a
 * core table.** Measured on drizzle-orm 0.45.2 (A2): at RUNTIME a second call merges additively
 * (`extractTablesRelationalConfig` assigns each entry into one per-table map, so only a repeated
 * relation NAME overwrites), but at the TYPE level it does not.
 * `ExtractTableRelationsFromSchema` is `ExtractObjectValues<…>` — `T[keyof T]`, a UNION of the two
 * configs — and `BuildRelationResult` then keys over `keyof (A | B)`, the INTERSECTION of their
 * keys, which for two disjoint configs is empty. So adding `relations(tenants, …)` strips `with:`
 * from `db.query.tenants` **everywhere in the app**, silently: the `with` key is still accepted,
 * the result type simply loses the relation. The FK direction a plugin needs is fully expressed by
 * the `one()` side on its own table (that is where `fields`/`references` live); it is only the
 * `many()` back-reference that cannot be contributed. Re-measure before relaxing this.
 */
export {}

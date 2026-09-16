/**
 * What `apps/web/src/plugins/schema.ts` re-exports for this plugin — and, through it, what
 * `db/schema/index.ts` hands to drizzle-kit, to `typeof schema` and to `rls-coverage.test.ts`.
 * Nothing here is ever copied into a migration: the host runs `pnpm db:generate` after the barrel
 * line exists, so the DDL is numbered in the host's own journal.
 */
export * from './example-notes'

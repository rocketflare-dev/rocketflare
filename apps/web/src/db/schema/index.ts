/**
 * Schema barrel — every table file is re-exported from here so `drizzle.config.ts`,
 * `src/db/client.ts` (`typeof schema`) and the RLS coverage test see one surface.
 * Read ./CLAUDE.md before adding a table (RLS checklist).
 */

/**
 * Installed plugin tables (D31). Position in this file decides nothing: a name exported by two
 * `export *` declarations is AMBIGUOUS, and TypeScript reports it (TS2308) instead of silently
 * letting one win — which is the loud failure that wants to happen before `pnpm db:generate`
 * writes DDL for a table that shadows a kit one. Biome sorts these lines, so this one sits where
 * the sorter puts it.
 */
export * from '../../plugins/schema'
export * from './_helpers'
export * from './access-requests'
export * from './activity-events'
export * from './agent-models'
export * from './agent-run-artifacts'
export * from './agent-run-effects'
export * from './agent-run-events'
export * from './agent-run-interrupts'
export * from './agent-runs'
export * from './ai-configs'
export * from './ai-usage'
export * from './analytics-page-groups'
export * from './analytics-pages'
export * from './api-keys'
export * from './chunks'
export * from './conversations'
export * from './document-groups'
export * from './documents'
export * from './facts'
export * from './feature-flags'
export * from './files'
export * from './groups'
export * from './magic-link-tokens'
export * from './messages'
export * from './notifications'
export * from './oauth-providers'
export * from './prompt-overrides'
export * from './relations'
export * from './rls'
export * from './team-invitations'
export * from './tenant-settings'
export * from './tenant-user-settings'
export * from './tenant-users'
export * from './tenants'
export * from './user-sessions'
export * from './users'

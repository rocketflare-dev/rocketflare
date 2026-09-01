/**
 * Schema barrel — every table file is re-exported from here so `drizzle.config.ts`,
 * `src/db/client.ts` (`typeof schema`) and the RLS coverage test see one surface.
 * Read ./CLAUDE.md before adding a table (RLS checklist).
 */
export * from './_helpers'
export * from './access-requests'
export * from './activity-events'
export * from './ai-configs'
export * from './ai-usage'
export * from './api-keys'
export * from './conversations'
export * from './files'
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

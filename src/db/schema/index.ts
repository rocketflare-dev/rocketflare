/**
 * Schema barrel — every table file is re-exported from here so `drizzle.config.ts`,
 * `src/db/client.ts` (`typeof schema`) and the RLS coverage test see one surface.
 *
 * Phase 0 ships no tables. Phase 1 adds users, tenants, tenant_users, team_invitations,
 * access_requests, oauth_providers, user_sessions, keys, tenant_settings, notifications,
 * activity_events (see docs/analysis/00-SYNTHESIS.md §2). Read ./CLAUDE.md before adding one.
 */
export * from './_helpers'
export * from './rls'

/**
 * The authorization server's own tables. Both are pre-tenant infrastructure written only by the
 * OAuth paths through the owner connection, so both are in `RLS_REVOKED_TABLES` — the app role
 * cannot read them at all, and neither has a `tenant_id`.
 *
 * - `oauth_clients` — a CACHE of each client's metadata document (its `client_id` IS the
 *   document's https URL). Refetched once it is a day old; it is never the source of truth, so a
 *   row can be deleted at any time and the next authorization fetches it again.
 * - `oauth_requests` — one authorization request from `GET /oauth/authorize` to its end: pending
 *   (ten minutes for the person to sign in and consent), then — once approved — the
 *   authorization code (its SHA-256 only, sixty seconds, single-use), bound to everything the
 *   token exchange must match. The organisation lives on the grant the consent made
 *   (`grant_id`), never here.
 */

import type { McpScope } from '@rocketflare/shared/mcp'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { mcpGrants } from './mcp'
import { users } from './users'

export const oauthClients = pgTable('oauth_clients', {
  /** The metadata document's URL — what the client sends as `client_id`. */
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name').notNull(),
  redirectUris: text('redirect_uris').array().notNull(),
  logoUri: text('logo_uri'),
  clientUri: text('client_uri'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const oauthRequests = pgTable(
  'oauth_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    scopes: text('scopes').array().$type<McpScope[]>().notNull(),
    /** `<APP_URL>/mcp` or `<APP_URL>/mcp/t/<slug>` — RFC 8707; the token is bound to it. */
    resource: text('resource').notNull(),
    /** PKCE S256 challenge (base64url of SHA-256 of the verifier). */
    codeChallenge: text('code_challenge').notNull(),
    /** The client's own value, returned untouched. */
    state: text('state'),
    /** The pending request's deadline — ten minutes to sign in and decide. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set by the approving consent. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    grantId: uuid('grant_id').references(() => mcpGrants.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').unique(),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
    /** Denied, or its code exchanged — either way it can never be used again. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index('oauth_requests_expires_idx').on(table.expiresAt)]
)

export type OAuthClientRow = typeof oauthClients.$inferSelect
export type OAuthRequestRow = typeof oauthRequests.$inferSelect

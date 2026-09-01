/**
 * `oauth_providers` — a user's linked identity at an external provider (D11, D12). Tokens are
 * stored AES-GCM encrypted (`*Enc` columns, written only through the token-crypto module), and
 * `(provider, provider_user_id)` is UNIQUE so one external account can never attach to two users.
 *
 * Magic-link tokens are NOT here (the Node reference app overloaded this table for them); they have
 * their own `magic_link_tokens` table. Pre-tenant infrastructure: in `RLS_REVOKED_TABLES`.
 */
import { relations } from 'drizzle-orm'
import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from './_helpers'
import { users } from './users'

export const oauthProviders = pgTable(
  'oauth_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Registry key: 'google' | 'microsoft' | … (see `oauthProviderNameSchema`). */
    provider: text('provider').notNull(),
    /** The provider's stable subject id (`sub`) — never the email, which can change. */
    providerUserId: text('provider_user_id').notNull(),
    /** Email as asserted by the provider at link time; informational. */
    email: text('email'),
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    /** Access-token expiry as reported by the provider. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    scopes: text('scopes').array(),
    ...timestamps(),
  },
  table => [
    unique('oauth_providers_provider_user_unique').on(table.provider, table.providerUserId),
    index('oauth_providers_user_idx').on(table.userId),
  ]
)

export const oauthProvidersRelations = relations(oauthProviders, ({ one }) => ({
  user: one(users, { fields: [oauthProviders.userId], references: [users.id] }),
}))

export type OauthProvider = typeof oauthProviders.$inferSelect
export type NewOauthProvider = typeof oauthProviders.$inferInsert

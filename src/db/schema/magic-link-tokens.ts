/**
 * `magic_link_tokens` — one-time email login tokens (D11, D12). Only the SHA-256 of the token is
 * stored; `consumedAt` makes a link single-use and `expiresAt` bounds it. Keyed by email, not
 * user: the user row may not exist yet (invite-only / open sign-up decide that at verify time).
 *
 * Pre-tenant infrastructure: in `RLS_REVOKED_TABLES`.
 */
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lower-cased at write time. */
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** Relative path to land on after verification (validated by `redirectToSchema`). */
    redirectTo: text('redirect_to'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    // Rate-limit "how many links did this address request lately" and expiry sweeps.
    index('magic_link_tokens_email_idx').on(table.email, table.createdAt),
    index('magic_link_tokens_expires_idx').on(table.expiresAt),
  ]
)

export type MagicLinkToken = typeof magicLinkTokens.$inferSelect
export type NewMagicLinkToken = typeof magicLinkTokens.$inferInsert

/**
 * `users` — one row per PERSON, global across tenants (D1, D9, D25). Membership of a tenant is a
 * `tenant_users` row; there is no `tenant_id` here, so the table is RLS-scoped by
 * `membershipIsolation()` instead of `tenantIsolation()`.
 *
 * Ported from the Node reference app's `users.ts` minus `username`; `isBlocked` became
 * `blockedAt` (a timestamp says WHEN) and `emailVerifiedAt` was added because D11 requires a
 * verified email before `BOOTSTRAP_ADMIN_EMAILS` promotion.
 */
import { sql } from 'drizzle-orm'
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from './_helpers'
import { membershipIsolation } from './rls'

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stored lower-cased by the app; the unique index below is on `lower(email)` regardless. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    /** Platform flag (D10): `manage all` and access to `/api/admin/*`. Not a tenant role. */
    isGlobalAdmin: boolean('is_global_admin').notNull().default(false),
    /** Set when a login proved ownership of `email` (magic link, or a provider asserting verified). */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** Stamped on every login. NULL = invited but never signed in. */
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /** Non-null = blocked by a global admin; the auth middleware rejects the session. */
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    // Case-insensitive uniqueness without citext (not guaranteed on every Postgres host).
    uniqueIndex('users_email_lower_idx').on(sql`lower(${table.email})`),
    // Scoped by MEMBERSHIP of the active tenant — see rls.ts.
    membershipIsolation(),
  ]
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

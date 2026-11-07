/**
 * `users` — one row per PERSON, global across tenants. Membership of a tenant is a
 * `tenant_users` row; there is no `tenant_id` here, so the table is RLS-scoped by
 * `membershipIsolation()` instead of `tenantIsolation()`.
 *
 * `blockedAt` is a timestamp because it says WHEN; `emailVerifiedAt` exists because a
 * verified email is required before `BOOTSTRAP_ADMIN_EMAILS` promotion.
 */
import { sql } from 'drizzle-orm'
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from './_helpers'
import { membershipIsolation } from './rls'

export const GLOBAL_ADMIN_SOURCES = ['manual', 'idp'] as const
export type GlobalAdminSource = (typeof GLOBAL_ADMIN_SOURCES)[number]

/**
 * Who set `blockedAt`: `manual` (the admin console) or `plugin:<id>` — that plugin's identity
 * provider deprovisioned the person in `TENANCY_MODE=single`, where the one tenant is the whole
 * deployment (`provisionFor(ctx, id).deprovision`). Only the SAME plugin's `setMembership` lifts a
 * `plugin:<id>` block; nothing but an admin lifts a `manual` one.
 */
export type BlockedSource = 'manual' | `plugin:${string}`

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stored lower-cased by the app; the unique index below is on `lower(email)` regardless. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    /** Platform flag: `manage all` and access to `/api/admin/*`. Not a tenant role. */
    isGlobalAdmin: boolean('is_global_admin').notNull().default(false),
    /**
     * Who granted `isGlobalAdmin`: `idp` = the issuer's `OIDC_GLOBAL_ADMIN_CLAIM` (cleared again
     * when the claim goes), `manual` = the admin console; NULL = not a global admin, or granted
     * without a source (`BOOTSTRAP_ADMIN_EMAILS`, the seed) — treated as manual, never cleared by a
     * sign-in.
     */
    globalAdminSource: text('global_admin_source', { enum: GLOBAL_ADMIN_SOURCES }),
    /** Set when a login proved ownership of `email` (magic link, or a provider asserting verified). */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** Stamped on every login. NULL = invited but never signed in. */
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /** Non-null = blocked; every sign-in, session and API key of the person is refused. */
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    /**
     * Who blocked them (`BlockedSource`). NULL with `blockedAt` set (a block from before the
     * column, the seed) is treated as `manual`: never lifted by an identity provider.
     */
    blockedSource: text('blocked_source').$type<BlockedSource>(),
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

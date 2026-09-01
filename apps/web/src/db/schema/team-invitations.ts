/**
 * `team_invitations` — an email invited into a tenant with a role (D9, D10, D12). The invite URL
 * carries a random token; only its SHA-256 is stored. Lifecycle is three nullable timestamps
 * (accepted / revoked / expired-by-clock) rather than a status column that can drift from them.
 *
 * The partial unique index is the "one pending invitation per address per tenant" rule both
 * reference apps enforced with a read-then-insert race.
 */
import { relations, sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

/** Assignable roles — `support` is deliberately absent (minted only via /admin). */
export const INVITATION_ROLES = ['owner', 'admin', 'member'] as const
export type InvitationRole = (typeof INVITATION_ROLES)[number]

export const teamInvitations = pgTable(
  'team_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** Lower-cased at write time; the unique index lowers it again regardless. */
    email: text('email').notNull(),
    role: text('role', { enum: INVITATION_ROLES }).notNull().default('member'),
    tokenHash: text('token_hash').notNull().unique(),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('team_invitations_pending_email_idx')
      .on(table.tenantId, sql`lower(${table.email})`)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    // "Pending invitations for this address" across tenants (login prologue banner).
    index('team_invitations_email_idx').on(sql`lower(${table.email})`),
    tenantIsolation('team_invitations'),
  ]
)

export const teamInvitationsRelations = relations(teamInvitations, ({ one }) => ({
  tenant: one(tenants, { fields: [teamInvitations.tenantId], references: [tenants.id] }),
  invitedBy: one(users, { fields: [teamInvitations.invitedByUserId], references: [users.id] }),
}))

export type TeamInvitation = typeof teamInvitations.$inferSelect
export type NewTeamInvitation = typeof teamInvitations.$inferInsert

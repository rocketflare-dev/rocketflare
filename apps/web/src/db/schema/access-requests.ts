/**
 * `access_requests` — the gated sign-up queue (D9, `SIGNUP_MODE=approval`). A sign-up that
 * arrived without an invitation waits here for a global admin, who approves it into an existing
 * tenant or a new one, or rejects it. `userId` is nullable because a request may be lodged from
 * the login page before any user row exists; `requestedTenantId` is a hint, not a membership.
 *
 * Cross-tenant by nature (a queue reviewed from /admin): no `tenant_id`, in `RLS_REVOKED_TABLES`.
 */
import { relations } from 'drizzle-orm'
import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants'
import { users } from './users'

export const accessRequestStatusEnum = pgEnum('access_request_status', [
  'pending',
  'approved',
  'rejected',
])

export const accessRequests = pgTable(
  'access_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lower-cased at write time. */
    email: text('email').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    requestedTenantId: uuid('requested_tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    /** Optional "why I'm here" from the requester. */
    message: text('message'),
    status: accessRequestStatusEnum('status').notNull().default('pending'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    // Admin queue: pending first, oldest first.
    index('access_requests_status_idx').on(table.status, table.createdAt),
    // "Does this address already have a request?" (session lookup, dedupe on re-login).
    index('access_requests_email_idx').on(table.email),
  ]
)

export const accessRequestsRelations = relations(accessRequests, ({ one }) => ({
  user: one(users, { fields: [accessRequests.userId], references: [users.id] }),
  requestedTenant: one(tenants, {
    fields: [accessRequests.requestedTenantId],
    references: [tenants.id],
  }),
  decidedBy: one(users, { fields: [accessRequests.decidedByUserId], references: [users.id] }),
}))

export type AccessRequest = typeof accessRequests.$inferSelect
export type NewAccessRequest = typeof accessRequests.$inferInsert

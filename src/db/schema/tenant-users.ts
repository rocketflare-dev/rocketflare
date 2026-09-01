/**
 * `tenant_users` — membership: which users belong to which tenant, with what role (D10, D25).
 * Composite PK `(tenant_id, user_id)`; `tenant_id` first so the PK index doubles as the
 * "members of this tenant" index.
 *
 * Roles: `owner` / `admin` / `member` are assignable (`tenantRoleSchema`); `support` is minted only
 * by a global admin entering an org from `/admin` — admin-equivalent, a REAL visible membership
 * row rather than a hidden bypass, and excluded from member counts (`NON_MEMBER_ROLES`).
 * Stored as text with a TypeScript enum (not a pg enum) so adding a role is a code change.
 */
import { relations } from 'drizzle-orm'
import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member', 'support'] as const
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number]

export const tenantUsers = pgTable(
  'tenant_users',
  {
    tenantId: tenantRef(tenants),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: MEMBERSHIP_ROLES }).notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /** Who invited / added this member; NULL for the founding owner and auto-joins. */
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  table => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    // Session resolution: "all memberships of this user", oldest first.
    index('tenant_users_user_idx').on(table.userId, table.joinedAt),
    // Members list filtered by role (owners for ownership checks).
    index('tenant_users_tenant_role_idx').on(table.tenantId, table.role),
    tenantIsolation('tenant_users'),
  ]
)

export const tenantUsersRelations = relations(tenantUsers, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantUsers.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [tenantUsers.userId], references: [users.id] }),
}))

export type TenantUser = typeof tenantUsers.$inferSelect
export type NewTenantUser = typeof tenantUsers.$inferInsert

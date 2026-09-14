/**
 * Groups (D29) — `group_types`, `groups` and `group_members`.
 *
 * A tenant declares group TYPES ("Department", "Region", "Client"); each type holds groups; each
 * group holds tenant members. Two decisions worth stating, because both are places the app this
 * was ported from lost data:
 *
 * - `group_members` has a composite PK `(group_id, user_id)`, so adding someone twice is
 *   `onConflictDoNothing` rather than a check-then-insert race.
 * - It also carries a composite FK `(tenant_id, user_id) → tenant_users` with cascade, so removing
 *   a person from the organisation removes every group membership they had in it with **no service
 *   code** — the one place that invariant cannot be forgotten.
 *
 * There is no `parentId`: hierarchy without inheritance is a column nothing reads.
 */
import { relations } from 'drizzle-orm'
import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenantUsers } from './tenant-users'
import { tenants } from './tenants'
import { users } from './users'

export const groupTypes = pgTable(
  'group_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    name: text('name').notNull(),
    description: text('description'),
    ...timestamps(),
  },
  table => [
    unique('group_types_tenant_name_key').on(table.tenantId, table.name),
    tenantIsolation('group_types'),
  ]
)

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    groupTypeId: uuid('group_type_id')
      .notNull()
      .references(() => groupTypes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    ...timestamps(),
  },
  table => [
    unique('groups_tenant_type_name_key').on(table.tenantId, table.groupTypeId, table.name),
    index('groups_tenant_type_idx').on(table.tenantId, table.groupTypeId),
    tenantIsolation('groups'),
  ]
)

export const groupMembers = pgTable(
  'group_members',
  {
    tenantId: tenantRef(tenants),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    // Losing the membership loses the group memberships, in the database rather than in a service.
    foreignKey({
      columns: [table.tenantId, table.userId],
      foreignColumns: [tenantUsers.tenantId, tenantUsers.userId],
      name: 'group_members_membership_fk',
    }).onDelete('cascade'),
    // "Which groups is this person in?" — the auth-context query, and the People list.
    index('group_members_tenant_user_idx').on(table.tenantId, table.userId),
    tenantIsolation('group_members'),
  ]
)

export const groupTypesRelations = relations(groupTypes, ({ one }) => ({
  tenant: one(tenants, { fields: [groupTypes.tenantId], references: [tenants.id] }),
}))

export const groupsRelations = relations(groups, ({ one }) => ({
  tenant: one(tenants, { fields: [groups.tenantId], references: [tenants.id] }),
  groupType: one(groupTypes, { fields: [groups.groupTypeId], references: [groupTypes.id] }),
}))

export const groupMembersRelations = relations(groupMembers, ({ one }) => ({
  group: one(groups, { fields: [groupMembers.groupId], references: [groups.id] }),
  user: one(users, { fields: [groupMembers.userId], references: [users.id] }),
}))

export type GroupTypeRow = typeof groupTypes.$inferSelect
export type NewGroupTypeRow = typeof groupTypes.$inferInsert
export type GroupRow = typeof groups.$inferSelect
export type NewGroupRow = typeof groups.$inferInsert
export type GroupMemberRow = typeof groupMembers.$inferSelect

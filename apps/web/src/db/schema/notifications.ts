/**
 * `notifications` — in-app notifications addressed to ONE user within a tenant (D1, D10). Every
 * role may `manage` its own (`Notification` in the ability matrix); routes scope by
 * `(tenant_id, user_id)` from the auth context. Realtime is a nudge over the DO hub; this table is
 * the truth. `data` jsonb carries the type-specific payload (`notificationDataSchema`).
 */
import type { NotificationData } from '@rocketflare/shared/notifications'
import { relations } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** App-defined discriminator: 'member_joined', 'invitation_accepted', 'system', … */
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    data: jsonb('data').$type<NotificationData>().notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    // Inbox: newest first, and the unread badge count (readAt IS NULL) for one user.
    index('notifications_tenant_user_idx').on(table.tenantId, table.userId, table.createdAt.desc()),
    tenantIsolation('notifications'),
  ]
)

export const notificationsRelations = relations(notifications, ({ one }) => ({
  tenant: one(tenants, { fields: [notifications.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}))

export type Notification = typeof notifications.$inferSelect
export type NewNotification = typeof notifications.$inferInsert

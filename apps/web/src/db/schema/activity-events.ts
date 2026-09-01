/**
 * `activity_events` — the generic per-tenant audit log (D1, D10) and the example fact source for
 * the analytics cubes. Append-only: `type` is what happened, `subjectType`/`subjectId` what it
 * happened to, `userId` who did it (NULL for system / cron), `metadata` the details
 * (`activityMetadataSchema`). The `(tenant_id, created_at DESC)` index serves both the activity
 * feed and time-bucketed analytics.
 */
import type { ActivityMetadata } from '@rocketflare/shared/activity'
import { relations } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const activityEvents = pgTable(
  'activity_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Dotted event name, e.g. `member.invited`, `api_key.created`. */
    type: text('type').notNull(),
    /** Entity kind the event is about (`TenantMember`, `Invitation`, …); NULL for tenant-wide. */
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    metadata: jsonb('metadata').$type<ActivityMetadata>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('activity_events_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    // "Everything that happened to this entity".
    index('activity_events_subject_idx').on(table.tenantId, table.subjectType, table.subjectId),
    tenantIsolation('activity_events'),
  ]
)

export const activityEventsRelations = relations(activityEvents, ({ one }) => ({
  tenant: one(tenants, { fields: [activityEvents.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [activityEvents.userId], references: [users.id] }),
}))

export type ActivityEvent = typeof activityEvents.$inferSelect
export type NewActivityEvent = typeof activityEvents.$inferInsert

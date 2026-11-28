/**
 * `example-hr`'s one table. In the shared `example_` namespace every example uses: the boundary
 * check lets examples share a prefix and still refuses two of them one table NAME.
 *
 * Imported relatively, like every table file: drizzle-kit bundles it and resolves no tsconfig path.
 */
import { date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantIsolation, tenantRef, tenants, timestamps, users } from '../../db/schema/kit'

export const exampleLeaveRequests = pgTable(
  'example_leave_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    reason: text('reason').notNull().default(''),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    index('example_leave_requests_tenant_created_idx').on(table.tenantId, table.createdAt),
    // "Who is on approved leave on this day" — the public function's query.
    index('example_leave_requests_tenant_user_idx').on(table.tenantId, table.userId),
    tenantIsolation('example_leave_requests'),
  ]
)

export type LeaveRequestRow = typeof exampleLeaveRequests.$inferSelect

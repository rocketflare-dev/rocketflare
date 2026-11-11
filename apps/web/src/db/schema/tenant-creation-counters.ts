/**
 * `tenant_creation_counters` — how many organisations a person has created per UTC day through
 * `POST /api/tenants`. One row per (user, day), bumped atomically with an upsert in the creating
 * transaction. Deliberately no foreign key to `tenants`: deleting the organisation must not take
 * its creation back, or delete-then-create would start a fresh day's allowance each time. Pruned
 * nightly.
 */
import { sql } from 'drizzle-orm'
import { date, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

export const tenantCreationCounters = pgTable(
  'tenant_creation_counters',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day').notNull().default(sql`(now() at time zone 'utc')::date`),
    created: integer('created').notNull().default(0),
  },
  table => [primaryKey({ columns: [table.userId, table.day] })]
)

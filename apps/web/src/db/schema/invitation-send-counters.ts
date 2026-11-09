/**
 * `invitation_send_counters` — how many invitation emails a person and a tenant have queued per
 * UTC day. One row per (scope, day), bumped atomically with an upsert so simultaneous requests
 * cannot pass the limit. `scope` is `user:<id>` or `tenant:<id>`; a person's count deliberately
 * has no tenant in it, so creating another tenant does not reset it. Pruned nightly.
 */
import { sql } from 'drizzle-orm'
import { date, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

export const invitationSendCounters = pgTable(
  'invitation_send_counters',
  {
    scope: text('scope').notNull(),
    day: date('day').notNull().default(sql`(now() at time zone 'utc')::date`),
    sent: integer('sent').notNull().default(0),
  },
  table => [primaryKey({ columns: [table.scope, table.day] })]
)

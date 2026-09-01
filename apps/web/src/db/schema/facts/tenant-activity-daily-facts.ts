/**
 * `tenant_activity_daily_facts` — the kit's one example FACT table (D19): `activity_events`
 * pre-aggregated to grain `(tenant_id, day, user_id)`, rebuilt per tenant by DELETE+INSERT
 * (`services/fact-tables/refresh.ts`, hourly at :15) and queried by the `TenantActivityDaily`
 * cube. It is an ordinary table, not a materialised view: `REFRESH MATERIALIZED VIEW` cannot run
 * through Hyperdrive and cannot be scoped to one tenant.
 *
 * Grain uniqueness: `user_id` is NULL for system/cron events, and a plain PK/unique treats every
 * NULL as distinct, so the constraint is declared `NULLS NOT DISTINCT` (Postgres 15+; Neon and the
 * pg17 compose image both qualify). No surrogate `id` — the grain IS the key. No FK to `users`
 * (a refresh must never fail because a user row went away). `fact_refreshed_at` is the watermark
 * the freshness check reads.
 */
import { relations } from 'drizzle-orm'
import { date, index, integer, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from '../_helpers'
import { tenantIsolation } from '../rls'
import { tenants } from '../tenants'

export const tenantActivityDailyFacts = pgTable(
  'tenant_activity_daily_facts',
  {
    tenantId: tenantRef(tenants),
    /** Calendar day (UTC) of the events. */
    day: date('day', { mode: 'date' }).notNull(),
    /** Actor; NULL = system / cron events. */
    userId: uuid('user_id'),
    eventCount: integer('event_count').notNull(),
    distinctEventTypes: integer('distinct_event_types').notNull(),
    firstEventAt: timestamp('first_event_at', { withTimezone: true }).notNull(),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
    /** When this row was (re)built — the freshness watermark. */
    factRefreshedAt: timestamp('fact_refreshed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    unique('tenant_activity_daily_facts_grain')
      .on(table.tenantId, table.day, table.userId)
      .nullsNotDistinct(),
    index('tenant_activity_daily_facts_tenant_day_idx').on(table.tenantId, table.day),
    tenantIsolation('tenant_activity_daily_facts'),
  ]
)

export const tenantActivityDailyFactsRelations = relations(tenantActivityDailyFacts, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantActivityDailyFacts.tenantId], references: [tenants.id] }),
}))

export type TenantActivityDailyFact = typeof tenantActivityDailyFacts.$inferSelect

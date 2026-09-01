/**
 * `TenantActivityDaily` cube (D19) — over the FACT table `tenant_activity_daily_facts`, rebuilt
 * hourly by `services/fact-tables`. Same direct `tenant_id` scoping as any tenant table; the point
 * is that a dashboard over a year of events reads a few hundred pre-aggregated rows. Joins `Users`
 * (belongsTo). Member names are frozen: dashboard JSON references them.
 */
import type { BaseQueryDefinition, Cube, QueryContext } from 'drizzle-cube/server'
import { defineCube } from 'drizzle-cube/server'
import { eq } from 'drizzle-orm'
import { tenantActivityDailyFacts, users } from '../../db/schema'
import { tenantIdOf } from './security'
import { usersCube } from './users'

export const tenantActivityDailyCube: Cube = defineCube('TenantActivityDaily', {
  title: 'Daily Activity',
  description: 'Activity events per day and user, pre-aggregated hourly (fact table)',

  sql: (ctx: QueryContext): BaseQueryDefinition => ({
    from: tenantActivityDailyFacts,
    where: eq(tenantActivityDailyFacts.tenantId, tenantIdOf(ctx)),
  }),

  joins: {
    Users: {
      targetCube: () => usersCube,
      relationship: 'belongsTo',
      on: [{ source: tenantActivityDailyFacts.userId, target: users.id }],
    },
  },

  dimensions: {
    day: { name: 'day', title: 'Day', type: 'time', sql: tenantActivityDailyFacts.day },
    userId: {
      name: 'userId',
      title: 'User ID',
      type: 'string',
      sql: tenantActivityDailyFacts.userId,
    },
    factRefreshedAt: {
      name: 'factRefreshedAt',
      title: 'Fact Refreshed At',
      type: 'time',
      sql: tenantActivityDailyFacts.factRefreshedAt,
    },
  },

  measures: {
    eventCount: {
      name: 'eventCount',
      title: 'Events',
      type: 'sum',
      sql: tenantActivityDailyFacts.eventCount,
    },
    activeUsers: {
      name: 'activeUsers',
      title: 'Active Users',
      type: 'countDistinct',
      sql: tenantActivityDailyFacts.userId,
    },
    activeDays: {
      name: 'activeDays',
      title: 'Active Days',
      type: 'countDistinct',
      sql: tenantActivityDailyFacts.day,
    },
  },
})

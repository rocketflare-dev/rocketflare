/**
 * `ActivityEvents` cube (D19) — the event-stream pattern over the audit log. `meta.eventStream`
 * tells drizzle-cube which columns bind (actor), order (time) and name (event type) an event, which
 * unlocks funnel / flow / retention modes in the query builder. Direct `tenant_id` scoping; joins
 * `Users` (belongsTo, the actor). Member names are frozen: dashboard JSON references them.
 */
import type { BaseQueryDefinition, Cube, QueryContext } from 'drizzle-cube/server'
import { defineCube } from 'drizzle-cube/server'
import { eq } from 'drizzle-orm'
import { activityEvents, users } from '../../db/schema'
import { tenantIdOf } from './security'
import { usersCube } from './users'

export const activityEventsCube: Cube = defineCube('ActivityEvents', {
  title: 'Activity Events',
  description: 'Everything that happened in the organisation, one row per event',

  sql: (ctx: QueryContext): BaseQueryDefinition => ({
    from: activityEvents,
    where: eq(activityEvents.tenantId, tenantIdOf(ctx)),
  }),

  meta: {
    eventStream: {
      bindingKey: 'ActivityEvents.userId',
      timeDimension: 'ActivityEvents.createdAt',
      eventDimension: 'ActivityEvents.type',
    },
  },

  joins: {
    Users: {
      targetCube: () => usersCube,
      relationship: 'belongsTo',
      on: [{ source: activityEvents.userId, target: users.id }],
    },
  },

  dimensions: {
    id: { name: 'id', title: 'Event ID', type: 'string', sql: activityEvents.id, primaryKey: true },
    type: {
      name: 'type',
      title: 'Event Type',
      type: 'string',
      sql: activityEvents.type,
      description: 'Dotted event name, e.g. member.invited, api_key.created',
    },
    subjectType: {
      name: 'subjectType',
      title: 'Subject Type',
      type: 'string',
      sql: activityEvents.subjectType,
    },
    userId: { name: 'userId', title: 'Actor ID', type: 'string', sql: activityEvents.userId },
    createdAt: {
      name: 'createdAt',
      title: 'Occurred At',
      type: 'time',
      sql: activityEvents.createdAt,
    },
  },

  measures: {
    count: { name: 'count', title: 'Events', type: 'count', sql: activityEvents.id },
    activeUsers: {
      name: 'activeUsers',
      title: 'Active Users',
      type: 'countDistinct',
      sql: activityEvents.userId,
    },
  },
})

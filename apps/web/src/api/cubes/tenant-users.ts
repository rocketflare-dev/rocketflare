/**
 * `TenantUsers` cube (D19) — the direct `tenant_id` scoping pattern over the membership table.
 * Filtered role counts show `filters` on a measure. Joins: `Users` (belongsTo). Member names are
 * frozen: dashboard JSON references them.
 */
import type { BaseQueryDefinition, Cube, QueryContext } from 'drizzle-cube/server'
import { defineCube } from 'drizzle-cube/server'
import { eq, sql } from 'drizzle-orm'
import { tenantUsers, users } from '../../db/schema'
import { tenantIdOf } from './security'
import { usersCube } from './users'

/** The junction has no `id`; a synthetic key makes `count`/`countDistinct` well-defined. */
const membershipKey = sql`${tenantUsers.tenantId}::text || ':' || ${tenantUsers.userId}::text`

export const tenantUsersCube: Cube = defineCube('TenantUsers', {
  title: 'Members',
  description: 'Organisation memberships with their role and join date',

  sql: (ctx: QueryContext): BaseQueryDefinition => ({
    from: tenantUsers,
    where: eq(tenantUsers.tenantId, tenantIdOf(ctx)),
  }),

  joins: {
    Users: {
      targetCube: () => usersCube,
      relationship: 'belongsTo',
      on: [{ source: tenantUsers.userId, target: users.id }],
    },
  },

  dimensions: {
    userId: {
      name: 'userId',
      title: 'User ID',
      type: 'string',
      sql: tenantUsers.userId,
      primaryKey: true,
    },
    role: { name: 'role', title: 'Role', type: 'string', sql: tenantUsers.role },
    joinedAt: { name: 'joinedAt', title: 'Joined', type: 'time', sql: tenantUsers.joinedAt },
  },

  measures: {
    count: { name: 'count', title: 'Members', type: 'count', sql: membershipKey },
    ownerCount: {
      name: 'ownerCount',
      title: 'Owners',
      type: 'count',
      sql: membershipKey,
      filters: [() => eq(tenantUsers.role, 'owner')],
    },
    adminCount: {
      name: 'adminCount',
      title: 'Admins',
      type: 'count',
      sql: membershipKey,
      filters: [() => eq(tenantUsers.role, 'admin')],
    },
    memberCount: {
      name: 'memberCount',
      title: 'Regular Members',
      type: 'count',
      sql: membershipKey,
      filters: [() => eq(tenantUsers.role, 'member')],
    },
  },
})

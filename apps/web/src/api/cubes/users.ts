/**
 * `Users` cube (D19) — the "global table scoped through membership" pattern. `users` has no
 * `tenant_id`, so the base query narrows to the members of the active tenant with a `tenant_users`
 * subquery. No joins are declared HERE on purpose: `TenantUsers`, `ActivityEvents` and
 * `TenantActivityDaily` each declare `belongsTo Users`, and drizzle-cube resolves join paths in
 * both directions — while a `hasMany` declared on this side would make every ungrouped
 * (`recordsTable`) query that mixes the two cubes invalid. Member names are frozen: dashboard JSON
 * references them.
 */
import type { BaseQueryDefinition, Cube, QueryContext } from 'drizzle-cube/server'
import { defineCube } from 'drizzle-cube/server'
import { inArray, sql } from 'drizzle-orm'
import { tenantUsers, users } from '../../db/schema'
import { tenantIdOf } from './security'

export const usersCube: Cube = defineCube('Users', {
  title: 'Users',
  description: 'People who are members of the current organisation',

  sql: (ctx: QueryContext): BaseQueryDefinition => ({
    from: users,
    // Parameterised subquery (never string interpolation): the tenant id is a bound value.
    where: inArray(
      users.id,
      sql`(select ${tenantUsers.userId} from ${tenantUsers} where ${tenantUsers.tenantId} = ${tenantIdOf(ctx)})`
    ),
  }),

  dimensions: {
    id: { name: 'id', title: 'User ID', type: 'string', sql: users.id, primaryKey: true },
    name: { name: 'name', title: 'Name', type: 'string', sql: users.name },
    email: { name: 'email', title: 'Email', type: 'string', sql: users.email },
    createdAt: { name: 'createdAt', title: 'Created', type: 'time', sql: users.createdAt },
    lastLoginAt: {
      name: 'lastLoginAt',
      title: 'Last Login',
      type: 'time',
      sql: users.lastLoginAt,
    },
  },

  measures: {
    count: { name: 'count', title: 'Users', type: 'count', sql: users.id },
  },
})

/**
 * `extractSecurityContext` (D19): the one bridge from `AuthContext` to cube SQL. Pure — no DB.
 */
import type { QueryContext } from 'drizzle-cube/server'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  AnalyticsAuthError,
  extractSecurityContext,
  groupFilter,
  tenantIdOf,
} from '@/api/cubes/security'
import { tenantUsers } from '@/db/schema'

const ctx = (auth: unknown) => ({ get: (key: string) => (key === 'auth' ? auth : undefined) })

describe('extractSecurityContext', () => {
  it('maps the auth context to { tenantId, userId, role } with the groups by id and by type', () => {
    const auth = {
      tenantId: 't-1',
      user: { id: 'u-1' },
      tenantUser: { role: 'admin' },
      groups: [
        { id: 'g-1', name: 'Finance', typeName: 'Department' },
        { id: 'g-2', name: 'Ops', typeName: 'Department' },
        { id: 'g-3', name: 'EMEA', typeName: 'Region' },
      ],
    }
    expect(extractSecurityContext(ctx(auth) as never)).toEqual({
      tenantId: 't-1',
      userId: 'u-1',
      role: 'admin',
      groupIds: ['g-1', 'g-2', 'g-3'],
      groups: { Department: ['Finance', 'Ops'], Region: ['EMEA'] },
      groupIdsByType: { Department: ['g-1', 'g-2'], Region: ['g-3'] },
      isAdmin: true,
    })
  })

  it('carries no groups for a plain member with none', () => {
    const auth = {
      tenantId: 't-1',
      user: { id: 'u-1' },
      tenantUser: { role: 'member' },
      groups: [],
    }
    expect(extractSecurityContext(ctx(auth) as never)).toMatchObject({
      groupIds: [],
      groups: {},
      groupIdsByType: {},
      isAdmin: false,
    })
  })

  it('throws without auth', () => {
    expect(() => extractSecurityContext(ctx(undefined) as never)).toThrow(AnalyticsAuthError)
  })

  it('throws for a session with no tenant (pending approval / no membership)', () => {
    const auth = { tenantId: null, user: { id: 'u-1' }, tenantUser: null }
    expect(() => extractSecurityContext(ctx(auth) as never)).toThrow(
      'Authentication required for analytics access'
    )
  })
})

const queryCtx = (securityContext: Record<string, unknown>) =>
  ({ securityContext }) as unknown as QueryContext

describe('tenantIdOf', () => {
  it('returns the tenant from the security context', () => {
    expect(tenantIdOf(queryCtx({ tenantId: 't-9' }))).toBe('t-9')
  })

  it('refuses an empty or missing tenant instead of compiling `tenant_id = NULL`', () => {
    expect(() => tenantIdOf(queryCtx({}))).toThrow(AnalyticsAuthError)
    expect(() => tenantIdOf(queryCtx({ tenantId: '' }))).toThrow(AnalyticsAuthError)
  })
})

describe('groupFilter (D29)', () => {
  const column = tenantUsers.userId
  /** The rendered statement plus its bound parameters — what actually reaches Postgres. */
  const rendered = (filter: SQL | undefined) => {
    const query = new PgDialect().sqlToQuery(filter as SQL)
    return `${query.sql} -- ${JSON.stringify(query.params)}`
  }

  it('does not narrow an admin-level reader', () => {
    expect(groupFilter(queryCtx({ isAdmin: true }), 'Department', column)).toBeUndefined()
  })

  it("narrows to the reader's group IDS of that type, never their names", () => {
    const filter = groupFilter(
      queryCtx({ isAdmin: false, groupIdsByType: { Department: ['g-1', 'g-2'] } }),
      'Department',
      column
    )
    // The ids are BOUND PARAMETERS, never interpolated.
    expect(rendered(filter)).toContain('in ($1, $2)')
    expect(rendered(filter)).toContain('["g-1","g-2"]')
  })

  it('FAILS CLOSED for a reader with no group of that type', () => {
    const none = groupFilter(queryCtx({ isAdmin: false, groupIdsByType: {} }), 'Department', column)
    expect(none).toBeDefined()
    expect(rendered(none)).toContain('false')
    // A group of a DIFFERENT type does not open the door either.
    const other = groupFilter(
      queryCtx({ isAdmin: false, groupIdsByType: { Region: ['g-9'] } }),
      'Department',
      column
    )
    expect(rendered(other)).toContain('false')
  })
})

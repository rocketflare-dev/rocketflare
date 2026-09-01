/**
 * `extractSecurityContext` (D19): the one bridge from `AuthContext` to cube SQL. Pure — no DB.
 */
import type { QueryContext } from 'drizzle-cube/server'
import { describe, expect, it } from 'vitest'
import { AnalyticsAuthError, extractSecurityContext, tenantIdOf } from '@/api/cubes/security'

const ctx = (auth: unknown) => ({ get: (key: string) => (key === 'auth' ? auth : undefined) })

describe('extractSecurityContext', () => {
  it('maps the auth context to { tenantId, userId, role }', () => {
    const auth = { tenantId: 't-1', user: { id: 'u-1' }, tenantUser: { role: 'admin' } }
    expect(extractSecurityContext(ctx(auth) as never)).toEqual({
      tenantId: 't-1',
      userId: 'u-1',
      role: 'admin',
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

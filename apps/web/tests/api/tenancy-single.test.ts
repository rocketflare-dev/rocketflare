/**
 * TENANCY_MODE=single (D25): the multi-org surface answers 404 `tenancy_mode_single`; every admitted
 * user is auto-joined to the single tenant as member; the session reports the mode; the schema is
 * untouched (the same routes work for members/invitations/settings).
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getSingleTenant } from '@/api/utils/db/tenant-helpers'
import { tenantUsers, users } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const env = createTestEnv({ TENANCY_MODE: 'single' })

describe('single-tenant mode', () => {
  it('disabled routes → 404 tenancy_mode_single', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const admin = await createTestGlobalAdmin(db)
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id))
    const cases: Array<[string, RequestInit, unknown]> = [
      ['/api/tenants', { method: 'POST', headers: cookie }, { name: 'x' }],
      ['/api/tenant', { method: 'DELETE', headers: cookie }, { confirm: tenant.slug }],
      ['/auth/select-tenant', { method: 'POST', headers: cookie }, { tenantId: tenant.id }],
      ['/api/admin/tenants', { headers: adminCookie }, undefined],
    ]
    for (const [path, init, body] of cases) {
      const res = await request(path, init, { env, json: body })
      expect(res.status, path).toBe(404)
      expect(await json(res), path).toMatchObject({ statusCode: 404, code: 'tenancy_mode_single' })
    }
  })

  it('kept routes still work and /auth/session reports tenancyMode: single', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    expect((await request('/api/members', { headers: cookie }, { env })).status).toBe(200)
    expect((await request('/api/tenant/settings', { headers: cookie }, { env })).status).toBe(200)
    expect((await request('/api/tenants', { headers: cookie }, { env })).status).toBe(200)
    const session = await json<{ tenancyMode: string; tenant: { id: string } }>(
      await request('/auth/session', { headers: cookie }, { env })
    )
    expect(session.tenancyMode).toBe('single')
    expect(session.tenant.id).toBe(tenant.id)
  })

  it('auto-join: a new dev-login user lands in the single tenant as member', async () => {
    const single = await getSingleTenant(db)
    expect(single).not.toBeNull()
    const email = `single_join_${uniqueId().toLowerCase()}@example.test`
    const res = await request('/auth/dev-login', { method: 'POST' }, { json: { email }, env })
    expect(res.status).toBe(200)
    const body = await json<{ tenant: { id: string; role: string } }>(res)
    expect(body.tenant).toMatchObject({ id: single?.id, role: 'member' })
    const [u] = await db.select().from(users).where(eq(users.email, email))
    const [m] = await db
      .select()
      .from(tenantUsers)
      .where(and(eq(tenantUsers.userId, u?.id ?? ''), eq(tenantUsers.tenantId, single?.id ?? '')))
    expect(m?.role).toBe('member')
  })
})

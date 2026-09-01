/**
 * `/api/admin/*` (D9, D10, D25): tenant-free global admin; access-request decisions; tenant
 * list/detail/suspend; support enter/leave; users; the last global admin guard; block kills sessions.
 */
import type { SessionResponse } from '@gmgo/shared/auth'
import { and, eq, ne } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { setGlobalAdmin } from '@/api/services/admin'
import { ensureAccessRequest } from '@/api/services/auth'
import type { Database } from '@/db/client'
import { notifications, tenants, tenantUsers, userSessions, users } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  createTestUser,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

async function admin() {
  const user = await createTestGlobalAdmin(db)
  return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id)) }
}

describe('globalAdminMiddleware', () => {
  it('a global admin with NO tenant reaches /api/admin/*', async () => {
    const a = await admin()
    const res = await request('/api/admin/tenants?pageSize=5', { headers: a.cookie })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ pagination: expect.objectContaining({ pageSize: 5 }) })
  })

  it('401 without a cookie; 403 for a non-admin owner; Bearer keys are not accepted', async () => {
    expect((await request('/api/admin/users')).status).toBe(401)
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const res = await request('/api/admin/users', { headers: cookie })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    const { createTestApiKey } = await import('../helpers/auth')
    const { key } = await createTestApiKey(db, tenant.id, user.id)
    expect(
      (await request('/api/admin/users', { headers: { Authorization: `Bearer ${key}` } })).status
    ).toBe(401)
  })
})

describe('access requests', () => {
  it('lists pending first and approves `join` into an existing tenant with a role', async () => {
    const a = await admin()
    const requester = await createTestUser(db)
    const req = await ensureAccessRequest(db, {
      email: requester.email,
      userId: requester.id,
      message: 'hi',
    })
    const tenant = await createTestTenant(db)
    const list = await json<{ items: Array<{ id: string; status: string }> }>(
      await request('/api/admin/access-requests?status=pending&pageSize=200', { headers: a.cookie })
    )
    expect(list.items.map(i => i.id)).toContain(req.id)
    const res = await request(
      `/api/admin/access-requests/${req.id}/decide`,
      { method: 'POST', headers: a.cookie },
      {
        json: {
          decision: 'approve',
          approve: { mode: 'join', tenantId: tenant.id, role: 'admin' },
        },
      }
    )
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({
      status: 'approved',
      decidedByUserId: a.user.id,
      requestedTenantName: tenant.name,
    })
    const [m] = await db
      .select()
      .from(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, tenant.id), eq(tenantUsers.userId, requester.id)))
    expect(m?.role).toBe('admin')
    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenant.id), eq(notifications.userId, requester.id)))
    expect(notes.map(n => n.type)).toContain('access_request_decided')
    const again = await request(
      `/api/admin/access-requests/${req.id}/decide`,
      { method: 'POST', headers: a.cookie },
      { json: { decision: 'reject' } }
    )
    expect(again.status).toBe(409)
  })

  it('approves `new_org` (owner), creating the user when only an email was lodged; 404 in single mode', async () => {
    const a = await admin()
    const email = `lodged_${uniqueId().toLowerCase()}@example.test`
    const req = await ensureAccessRequest(db, { email, userId: null })
    const single = await request(
      `/api/admin/access-requests/${req.id}/decide`,
      { method: 'POST', headers: a.cookie },
      {
        json: { decision: 'approve', approve: { mode: 'new_org', name: 'Lodged Org' } },
        env: createTestEnv({ TENANCY_MODE: 'single' }),
      }
    )
    expect(single.status).toBe(404)
    expect(await json(single)).toMatchObject({ code: 'tenancy_mode_single' })
    const res = await request(
      `/api/admin/access-requests/${req.id}/decide`,
      { method: 'POST', headers: a.cookie },
      {
        json: { decision: 'approve', approve: { mode: 'new_org', name: 'Lodged Org' } },
      }
    )
    expect(res.status).toBe(200)
    const [user] = await db.select().from(users).where(eq(users.email, email))
    expect(user).toBeDefined()
    const memberships = await db
      .select()
      .from(tenantUsers)
      .where(eq(tenantUsers.userId, user?.id ?? ''))
    expect(memberships).toEqual([expect.objectContaining({ role: 'owner' })])
  })

  it('rejects with a reason', async () => {
    const a = await admin()
    const requester = await createTestUser(db)
    const req = await ensureAccessRequest(db, { email: requester.email, userId: requester.id })
    const res = await request(
      `/api/admin/access-requests/${req.id}/decide`,
      { method: 'POST', headers: a.cookie },
      { json: { decision: 'reject', reason: 'no' } }
    )
    expect(await json(res)).toMatchObject({ status: 'rejected' })
    const session = await json<SessionResponse>(
      await request('/auth/session', {
        headers: sessionCookieHeader(await createTestSession(db, requester.id)),
      })
    )
    expect(session.accessRequest).toEqual({ status: 'rejected' })
  })
})

describe('tenants', () => {
  it('list (with q) + detail with members; list is 404 in single mode but detail works', async () => {
    const a = await admin()
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const list = await json<{ items: Array<{ id: string; memberCount: number }> }>(
      await request(`/api/admin/tenants?q=${tenant.slug}`, { headers: a.cookie })
    )
    expect(list.items).toEqual([expect.objectContaining({ id: tenant.id, memberCount: 1 })])
    const detail = await json<{
      members: Array<{ userId: string; role: string }>
      supportAccess: boolean
    }>(await request(`/api/admin/tenants/${tenant.id}`, { headers: a.cookie }))
    expect(detail.members).toEqual([expect.objectContaining({ userId: user.id, role: 'owner' })])
    expect(detail.supportAccess).toBe(false)
    const env = createTestEnv({ TENANCY_MODE: 'single' })
    expect((await request('/api/admin/tenants', { headers: a.cookie }, { env })).status).toBe(404)
    expect(
      (await request(`/api/admin/tenants/${tenant.id}`, { headers: a.cookie }, { env })).status
    ).toBe(200)
  })

  it('suspend → members get 403 tenant_suspended; unsuspend restores', async () => {
    const a = await admin()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    expect(
      (
        await request(
          `/api/admin/tenants/${tenant.id}/suspend`,
          { method: 'POST', headers: a.cookie },
          { json: { suspended: true } }
        )
      ).status
    ).toBe(200)
    const denied = await request('/api/members', { headers: cookie })
    expect(denied.status).toBe(403)
    expect(await json(denied)).toMatchObject({ code: 'tenant_suspended' })
    expect((await request('/auth/session', { headers: cookie })).status).toBe(403)
    await request(
      `/api/admin/tenants/${tenant.id}/suspend`,
      { method: 'POST', headers: a.cookie },
      { json: { suspended: false } }
    )
    expect((await request('/api/members', { headers: cookie })).status).toBe(200)
  })

  it('support enter mints a support membership + selects it; leave removes it', async () => {
    const a = await admin()
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const enter = await request(`/api/admin/tenants/${tenant.id}/support/enter`, {
      method: 'POST',
      headers: a.cookie,
    })
    expect(enter.status).toBe(200)
    const body = await json<SessionResponse>(enter)
    expect(body.tenant).toMatchObject({ id: tenant.id, role: 'support' })
    const members = await json<{ items: Array<{ userId: string; role: string }> }>(
      await request('/api/members', { headers: a.cookie })
    )
    expect(members.items.find(m => m.userId === a.user.id)?.role).toBe('support')
    expect(
      (
        await json<{ supportAccess: boolean }>(
          await request(`/api/admin/tenants/${tenant.id}`, { headers: a.cookie })
        )
      ).supportAccess
    ).toBe(true)
    const leave = await request(`/api/admin/tenants/${tenant.id}/support/leave`, {
      method: 'POST',
      headers: a.cookie,
    })
    expect(leave.status).toBe(200)
    expect((await json<SessionResponse>(leave)).tenant).toBeNull()
    expect(
      await db
        .select()
        .from(tenantUsers)
        .where(and(eq(tenantUsers.tenantId, tenant.id), eq(tenantUsers.userId, a.user.id)))
    ).toHaveLength(0)
  })
})

describe('users', () => {
  it('list with filters + detail', async () => {
    const a = await admin()
    const { user, tenant } = await createTestTenantWithUser(db, 'admin')
    const list = await json<{ items: Array<{ id: string; tenantCount: number }> }>(
      await request(`/api/admin/users?q=${user.email}`, { headers: a.cookie })
    )
    expect(list.items).toEqual([expect.objectContaining({ id: user.id, tenantCount: 1 })])
    const byTenant = await json<{ items: Array<{ id: string }> }>(
      await request(`/api/admin/users?tenantId=${tenant.id}`, { headers: a.cookie })
    )
    expect(byTenant.items.map(u => u.id)).toEqual([user.id])
    const detail = await json<{ memberships: Array<{ tenantId: string; role: string }> }>(
      await request(`/api/admin/users/${user.id}`, { headers: a.cookie })
    )
    expect(detail.memberships).toEqual([
      expect.objectContaining({ tenantId: tenant.id, role: 'admin' }),
    ])
    expect((await request('/api/admin/users/not-a-uuid', { headers: a.cookie })).status).toBe(404)
  })

  it('global-admin toggle works, and the LAST global admin cannot be demoted', async () => {
    const a = await admin()
    const target = await createTestUser(db)
    const on = await request(
      `/api/admin/users/${target.id}/global-admin`,
      { method: 'POST', headers: a.cookie },
      { json: { isGlobalAdmin: true } }
    )
    expect(await json(on)).toEqual({ id: target.id, isGlobalAdmin: true })
    const off = await request(
      `/api/admin/users/${target.id}/global-admin`,
      { method: 'POST', headers: a.cookie },
      { json: { isGlobalAdmin: false } }
    )
    expect(await json(off)).toEqual({ id: target.id, isGlobalAdmin: false })
    // The shared test database has many admins; prove the guard inside a rolled-back transaction.
    await db
      .transaction(async tx => {
        await tx
          .update(users)
          .set({ isGlobalAdmin: false })
          .where(and(eq(users.isGlobalAdmin, true), ne(users.id, a.user.id)))
        await expect(
          setGlobalAdmin(tx as unknown as Database, {
            userId: a.user.id,
            isGlobalAdmin: false,
            actor: a.user,
          })
        ).rejects.toMatchObject({ statusCode: 409, code: 'last_global_admin' })
        tx.rollback()
      })
      .catch(err => {
        if (!(err instanceof Error && /rollback/i.test(err.message))) throw err
      })
    const [still] = await db.select().from(users).where(eq(users.id, a.user.id))
    expect(still?.isGlobalAdmin).toBe(true)
  })

  it('block deletes every session; unblock restores login; cannot block yourself', async () => {
    const a = await admin()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const t1 = await createTestSession(db, user.id, tenant.id)
    const t2 = await createTestSession(db, user.id, tenant.id)
    const res = await request(
      `/api/admin/users/${user.id}/block`,
      { method: 'POST', headers: a.cookie },
      { json: { blocked: true } }
    )
    expect(res.status).toBe(200)
    expect(
      await db.select().from(userSessions).where(eq(userSessions.userId, user.id))
    ).toHaveLength(0)
    expect((await request('/auth/session', { headers: sessionCookieHeader(t1) })).status).toBe(401)
    expect((await request('/auth/session', { headers: sessionCookieHeader(t2) })).status).toBe(401)
    await request(
      `/api/admin/users/${user.id}/block`,
      { method: 'POST', headers: a.cookie },
      { json: { blocked: false } }
    )
    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row?.blockedAt).toBeNull()
    const self = await request(
      `/api/admin/users/${a.user.id}/block`,
      { method: 'POST', headers: a.cookie },
      { json: { blocked: true } }
    )
    expect(self.status).toBe(403)
    expect(tenants).toBeDefined()
  })
})

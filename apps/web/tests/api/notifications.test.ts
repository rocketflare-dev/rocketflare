/**
 * `/api/notifications` (D8): list / unread-count / read, scoped to (tenant, user).
 */
import { describe, expect, it } from 'vitest'
import { notify } from '@/api/services/notifications'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()

describe('/api/notifications', () => {
  it('lists mine newest-first, counts unread, marks by ids and all', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    for (const i of [1, 2, 3]) {
      await notify(db, {
        tenantId: tenant.id,
        userId: user.id,
        type: 'system',
        title: `n${i}`,
        data: { i },
      })
    }
    const other = await createTestUser(db)
    await linkUserToTenant(db, other.id, tenant.id, 'member')
    await notify(db, { tenantId: tenant.id, userId: other.id, type: 'system', title: 'not mine' })

    const list = await json<{
      items: Array<{ id: string; title: string }>
      pagination: { total: number }
    }>(await request('/api/notifications', { headers: cookie }))
    expect(list.pagination.total).toBe(3)
    expect(list.items.map(i => i.title)).toEqual(['n3', 'n2', 'n1'])
    expect(
      (
        await json<{ count: number }>(
          await request('/api/notifications/unread-count', { headers: cookie })
        )
      ).count
    ).toBe(3)

    const one = await request(
      '/api/notifications/read',
      { method: 'POST', headers: cookie },
      { json: { ids: [list.items[0]?.id] } }
    )
    expect(await json(one)).toEqual({ updated: 1 })
    expect(
      (
        await json<{ count: number }>(
          await request('/api/notifications/unread-count', { headers: cookie })
        )
      ).count
    ).toBe(2)
    const unread = await json<{ items: unknown[] }>(
      await request('/api/notifications?unreadOnly=true', { headers: cookie })
    )
    expect(unread.items).toHaveLength(2)
    const all = await request(
      '/api/notifications/read',
      { method: 'POST', headers: cookie },
      { json: { all: true } }
    )
    expect(await json(all)).toEqual({ updated: 2 })
    expect(
      (
        await json<{ count: number }>(
          await request('/api/notifications/unread-count', { headers: cookie })
        )
      ).count
    ).toBe(0)
  })

  it('tenant isolation: the same user in another tenant sees a separate inbox', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const { tenant: other } = await createTestTenantWithUser(db, 'owner')
    await linkUserToTenant(db, user.id, other.id, 'member')
    await notify(db, { tenantId: tenant.id, userId: user.id, type: 'system', title: 'A' })
    const inOther = sessionCookieHeader(await createTestSession(db, user.id, other.id))
    expect(
      (
        await json<{ count: number }>(
          await request('/api/notifications/unread-count', { headers: inOther })
        )
      ).count
    ).toBe(0)
  })

  it('401 unauthenticated; 400 for a bad read body', async () => {
    expect((await request('/api/notifications')).status).toBe(401)
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const res = await request(
      '/api/notifications/read',
      { method: 'POST', headers: cookie },
      { json: { ids: [] } }
    )
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'validation_failed' })
  })
})

/**
 * Activity log (D19): writes append events via waitUntil; `GET /api/activity` is admin+, filterable,
 * resolves the actor and is tenant-scoped.
 */
import { describe, expect, it } from 'vitest'
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

describe('GET /api/activity', () => {
  it('records a key creation and an invitation, newest first, with the actor', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    await request('/api/keys', { method: 'POST', headers: cookie }, { json: { name: 'k' } })
    await request(
      '/api/invitations',
      { method: 'POST', headers: cookie },
      { json: { email: `act_${Date.now()}@example.test` } }
    )
    const res = await request('/api/activity', { headers: cookie })
    expect(res.status).toBe(200)
    const body = await json<{
      items: Array<{ type: string; actor: { email: string } | null; subjectType: string | null }>
      pagination: { total: number }
    }>(res)
    expect(body.items.map(i => i.type)).toEqual(['member.invited', 'api_key.created'])
    expect(body.items[0]?.actor?.email).toBe(user.email)
    expect(body.items[1]?.subjectType).toBe('ApiKey')
    const filtered = await json<{ items: Array<{ type: string }> }>(
      await request('/api/activity?type=api_key.created', { headers: cookie })
    )
    expect(filtered.items.map(i => i.type)).toEqual(['api_key.created'])
    const bySubject = await json<{ items: unknown[] }>(
      await request('/api/activity?subjectType=Invitation', { headers: cookie })
    )
    expect(bySubject.items).toHaveLength(1)
    const future = await json<{ items: unknown[] }>(
      await request(
        `/api/activity?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
        { headers: cookie }
      )
    )
    expect(future.items).toHaveLength(0)
  })

  it('member → 403; unauthenticated → 401; another tenant sees nothing of ours', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    await request('/api/keys', { method: 'POST', headers: cookie }, { json: { name: 'k' } })
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, tenant.id, 'member')
    const res = await request('/api/activity', {
      headers: sessionCookieHeader(await createTestSession(db, member.id, tenant.id)),
    })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    expect((await request('/api/activity')).status).toBe(401)
    const other = await createTestTenantWithUser(db, 'owner')
    const theirs = await json<{ pagination: { total: number } }>(
      await request('/api/activity', {
        headers: sessionCookieHeader(await createTestSession(db, other.user.id, other.tenant.id)),
      })
    )
    expect(theirs.pagination.total).toBe(0) // fixtures insert tenants directly; nothing of ours leaks
  })
})

/**
 * Access requests (D9): a tenant-less user lodges one; `/auth/session` surfaces it; tenant routes
 * answer 403 pending_approval; the admin decides (join / new_org / reject) — see admin.test.ts for
 * the decision matrix, this file covers the requester side.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { accessRequests } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()

describe('POST /api/access-requests', () => {
  it('creates ONE pending request for my email (body email ignored), updates on repeat', async () => {
    const user = await createTestUser(db)
    const cookie = sessionCookieHeader(await createTestSession(db, user.id))
    const tenant = await createTestTenant(db)
    const first = await request(
      '/api/access-requests',
      { method: 'POST', headers: cookie },
      { json: { email: 'someone-else@example.test', message: 'let me in' } }
    )
    expect(first.status).toBe(201)
    const body = await json<{ id: string; email: string; status: string; userId: string }>(first)
    expect(body).toMatchObject({ email: user.email, status: 'pending', userId: user.id })
    const second = await request(
      '/api/access-requests',
      { method: 'POST', headers: cookie },
      { json: { email: user.email, message: 'please', requestedTenantId: tenant.id } }
    )
    expect((await json<{ id: string }>(second)).id).toBe(body.id)
    const rows = await db
      .select()
      .from(accessRequests)
      .where(and(eq(accessRequests.email, user.email), eq(accessRequests.status, 'pending')))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ message: 'please', requestedTenantId: tenant.id })

    const session = await json<{ tenant: unknown; accessRequest: { status: string } }>(
      await request('/auth/session', { headers: cookie })
    )
    expect(session.tenant).toBeNull()
    expect(session.accessRequest).toEqual({ status: 'pending' })
    const denied = await request('/api/members', { headers: cookie })
    expect(denied.status).toBe(403)
    expect(await json(denied)).toMatchObject({ statusCode: 403, code: 'pending_approval' })
  })

  it('401 without a session; 400 envelope for a bad body', async () => {
    expect(
      (await request('/api/access-requests', { method: 'POST' }, { json: { email: 'a@b.co' } }))
        .status
    ).toBe(401)
    const user = await createTestUser(db)
    const cookie = sessionCookieHeader(await createTestSession(db, user.id))
    const res = await request(
      '/api/access-requests',
      { method: 'POST', headers: cookie },
      { json: { email: 'nope' } }
    )
    expect(res.status).toBe(400)
  })
})

/**
 * `/api/members` permission matrix (D10): owner / admin / member / support × list, role change,
 * remove; ownership invariants (owner-only owner changes, the last owner stays).
 */
import type { MembershipRole } from '@rocketflare/shared/tenants'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { tenantUsers } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()

type Actor = { role: MembershipRole; userId: string; cookie: Record<string, string> }
let tenantId: string
const actors = {} as Record<MembershipRole, Actor>

async function member(role: MembershipRole, tid = tenantId) {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tid, role)
  return {
    role,
    userId: user.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tid)),
  }
}

async function roleOf(userId: string, tid = tenantId) {
  const [row] = await db
    .select()
    .from(tenantUsers)
    .where(and(eq(tenantUsers.tenantId, tid), eq(tenantUsers.userId, userId)))
  return row?.role ?? null
}

beforeAll(async () => {
  const tenant = await createTestTenant(db)
  tenantId = tenant.id
  for (const role of ['owner', 'admin', 'member', 'support'] as const)
    actors[role] = await member(role)
})

describe('GET /api/members', () => {
  it.each(['owner', 'admin', 'member', 'support'] as const)(
    '%s → 200, paginated, includes support',
    async role => {
      const res = await request('/api/members?pageSize=50', { headers: actors[role].cookie })
      expect(res.status).toBe(200)
      const body = await json<{
        items: Array<{ userId: string; role: string; email: string }>
        pagination: { total: number }
      }>(res)
      expect(body.pagination.total).toBeGreaterThanOrEqual(4)
      expect(body.items.some(m => m.role === 'support')).toBe(true)
      expect(body.items.find(m => m.userId === actors.owner.userId)).toMatchObject({
        role: 'owner',
      })
    }
  )

  it('401 unauthenticated', async () => {
    expect((await request('/api/members')).status).toBe(401)
  })

  it('tenant isolation: another tenant cannot see these members', async () => {
    const other = await createTestTenant(db)
    const outsider = await member('owner', other.id)
    const body = await json<{ items: Array<{ userId: string }> }>(
      await request('/api/members', { headers: outsider.cookie })
    )
    expect(body.items.map(m => m.userId)).not.toContain(actors.owner.userId)
  })
})

describe('PATCH /api/members/:userId (role)', () => {
  const change = (actor: Actor, target: string, role: string) =>
    request(
      `/api/members/${target}`,
      { method: 'PATCH', headers: actor.cookie },
      { json: { role } }
    )

  it.each([
    ['owner', 200],
    ['admin', 200],
    ['support', 200],
    ['member', 403],
  ] as const)('%s promoting a member to admin → %i', async (role, status) => {
    const target = await member('member')
    const res = await change(actors[role], target.userId, 'admin')
    expect(res.status).toBe(status)
    expect(await roleOf(target.userId)).toBe(status === 200 ? 'admin' : 'member')
    if (status === 403)
      expect(await json(res)).toMatchObject({ statusCode: 403, code: 'forbidden' })
  })

  it('admin cannot assign owner; owner can', async () => {
    const target = await member('member')
    expect((await change(actors.admin, target.userId, 'owner')).status).toBe(403)
    expect(await roleOf(target.userId)).toBe('member')
    expect((await change(actors.owner, target.userId, 'owner')).status).toBe(200)
    expect(await roleOf(target.userId)).toBe('owner')
    // and back down (there are now two owners)
    expect((await change(actors.owner, target.userId, 'member')).status).toBe(200)
  })

  it('admin cannot demote an owner', async () => {
    const extraOwner = await member('owner')
    expect((await change(actors.admin, extraOwner.userId, 'member')).status).toBe(403)
    expect((await change(actors.owner, extraOwner.userId, 'member')).status).toBe(200)
  })

  it('the last owner cannot be demoted (409 last_owner)', async () => {
    const tenant = await createTestTenant(db)
    const solo = await member('owner', tenant.id)
    const res = await change(solo, solo.userId, 'admin')
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'last_owner' })
    expect(await roleOf(solo.userId, tenant.id)).toBe('owner')
  })

  it('support rows are locked (403) and `support` cannot be assigned (400)', async () => {
    expect((await change(actors.owner, actors.support.userId, 'member')).status).toBe(403)
    const target = await member('member')
    const res = await change(actors.owner, target.userId, 'support')
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'validation_failed' })
  })

  it('404 for a non-member and for a non-uuid', async () => {
    const stranger = await createTestUser(db)
    expect((await change(actors.owner, stranger.id, 'admin')).status).toBe(404)
    expect((await change(actors.owner, 'nope', 'admin')).status).toBe(404)
  })
})

describe('DELETE /api/members/:userId', () => {
  const remove = (actor: Actor, target: string) =>
    request(`/api/members/${target}`, { method: 'DELETE', headers: actor.cookie })

  it.each([
    ['owner', 204],
    ['admin', 204],
    ['support', 204],
    ['member', 403],
  ] as const)('%s removing a member → %i', async (role, status) => {
    const target = await member('member')
    expect((await remove(actors[role], target.userId)).status).toBe(status)
    expect(await roleOf(target.userId)).toBe(status === 204 ? null : 'member')
  })

  it('admin cannot remove an owner; owner can remove another owner', async () => {
    const extraOwner = await member('owner')
    expect((await remove(actors.admin, extraOwner.userId)).status).toBe(403)
    expect((await remove(actors.owner, extraOwner.userId)).status).toBe(204)
  })

  it('the last owner cannot remove themselves (409 last_owner)', async () => {
    const tenant = await createTestTenant(db)
    const solo = await member('owner', tenant.id)
    const res = await remove(solo, solo.userId)
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'last_owner' })
  })

  it('an admin may leave (remove themselves)', async () => {
    const leaver = await member('admin')
    expect((await remove(leaver, leaver.userId)).status).toBe(204)
    expect((await request('/api/members', { headers: leaver.cookie })).status).toBe(403)
  })

  it('removal is tenant-scoped: an owner elsewhere cannot remove our member', async () => {
    const other = await createTestTenant(db)
    const outsider = await member('owner', other.id)
    expect((await remove(outsider, actors.member.userId)).status).toBe(404)
    expect(await roleOf(actors.member.userId)).toBe('member')
  })
})

/**
 * `/api/groups` (D29): CRUD for types and groups, membership, and the three things that go wrong
 * when groups are bolted on carelessly — a duplicate name, a group id borrowed from another
 * tenant, and a delete that quietly changes who can see what.
 */
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  documentGroups,
  documents,
  groupMembers,
  groups,
  groupTypes,
  tenantUsers,
} from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()

let tenantId: string
let ownerCookie: Record<string, string>
let memberCookie: Record<string, string>
let memberUserId: string

async function actor(role: 'owner' | 'admin' | 'member', tid = tenantId) {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tid, role)
  return { userId: user.id, cookie: sessionCookieHeader(await createTestSession(db, user.id, tid)) }
}

beforeAll(async () => {
  const tenant = await createTestTenant(db)
  tenantId = tenant.id
  ownerCookie = (await actor('owner')).cookie
  const m = await actor('member')
  memberCookie = m.cookie
  memberUserId = m.userId
})

/** A type + a group, created through the API as the owner. */
async function makeGroup(name = `Finance ${Math.random().toString(36).slice(2, 8)}`) {
  const typeRes = await request(
    '/api/groups/types',
    { method: 'POST', headers: ownerCookie },
    { json: { name: `Department ${Math.random().toString(36).slice(2, 8)}` } }
  )
  const type = await json<{ id: string; name: string }>(typeRes)
  const groupRes = await request(
    '/api/groups',
    { method: 'POST', headers: ownerCookie },
    { json: { groupTypeId: type.id, name } }
  )
  return { type, group: await json<{ id: string; name: string; typeName: string }>(groupRes) }
}

describe('group types and groups', () => {
  it('creates, lists, renames and counts', async () => {
    const { type, group } = await makeGroup()
    expect(group).toMatchObject({ name: expect.any(String), typeName: type.name, memberCount: 0 })

    const list = await json<{ items: { id: string; groupCount: number }[] }>(
      await request('/api/groups/types', { headers: ownerCookie })
    )
    expect(list.items.find(t => t.id === type.id)?.groupCount).toBe(1)

    const renamed = await json<{ name: string }>(
      await request(
        `/api/groups/${group.id}`,
        { method: 'PATCH', headers: ownerCookie },
        { json: { name: 'Renamed' } }
      )
    )
    expect(renamed.name).toBe('Renamed')
  })

  it('refuses a duplicate name in the same tenant with 409', async () => {
    const { type, group } = await makeGroup('Duplicated')
    const res = await request(
      '/api/groups',
      { method: 'POST', headers: ownerCookie },
      { json: { groupTypeId: type.id, name: group.name } }
    )
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'group_exists', statusCode: 409 })
  })

  it('401 unauthenticated, 403 for a member on every administrative route', async () => {
    expect((await request('/api/groups/types')).status).toBe(401)
    expect((await request('/api/groups/types', { headers: memberCookie })).status).toBe(403)
    expect((await request('/api/groups', { headers: memberCookie })).status).toBe(403)
    const res = await request(
      '/api/groups/types',
      { method: 'POST', headers: memberCookie },
      { json: { name: 'Nope' } }
    )
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403 })
  })

  it('GET /mine is every member, and lists only their own groups', async () => {
    const { group } = await makeGroup()
    const before = await json<{ items: unknown[] }>(
      await request('/api/groups/mine', { headers: memberCookie })
    )
    expect(before.items).toEqual([])
    await request(
      `/api/groups/${group.id}/members`,
      { method: 'POST', headers: ownerCookie },
      { json: { userIds: [memberUserId] } }
    )
    const after = await json<{ items: { id: string }[] }>(
      await request('/api/groups/mine', { headers: memberCookie })
    )
    expect(after.items.map(g => g.id)).toEqual([group.id])
  })
})

describe('tenant isolation', () => {
  it('another tenant cannot read a group, and cannot attach one of ours to its own content', async () => {
    const { group } = await makeGroup()
    const other = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, other.user.id, other.tenant.id))

    expect((await request(`/api/groups/${group.id}`, { headers: cookie })).status).toBe(404)
    const lists = await json<{ items: unknown[] }>(
      await request('/api/groups', { headers: cookie })
    )
    expect(lists.items).toEqual([])

    const [doc] = await db
      .insert(documents)
      .values({ tenantId: other.tenant.id, title: 'Theirs', ownerUserId: other.user.id })
      .returning()
    const res = await request(
      `/api/ai/documents/${doc?.id}/visibility`,
      { method: 'PUT', headers: cookie },
      { json: { visibility: 'groups', groupIds: [group.id] } }
    )
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'unknown_group' })
  })
})

describe('membership', () => {
  it('adds several at once, is idempotent, and refuses a non-member with 400', async () => {
    const { group } = await makeGroup()
    const a = await actor('member')
    const b = await actor('member')
    const stranger = await createTestUser(db)

    await request(
      `/api/groups/${group.id}/members`,
      { method: 'POST', headers: ownerCookie },
      { json: { userIds: [a.userId, b.userId] } }
    )
    // A replayed add is a no-op rather than a unique violation.
    const again = await request(
      `/api/groups/${group.id}/members`,
      { method: 'POST', headers: ownerCookie },
      { json: { userIds: [a.userId] } }
    )
    expect(again.status).toBe(200)
    const detail = await json<{ members: unknown[]; memberCount: number }>(again)
    expect(detail.members).toHaveLength(2)
    expect(detail.memberCount).toBe(2)

    const bad = await request(
      `/api/groups/${group.id}/members`,
      { method: 'POST', headers: ownerCookie },
      { json: { userIds: [stranger.id] } }
    )
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ code: 'not_a_member' })

    const removed = await request(`/api/groups/${group.id}/members/${a.userId}`, {
      method: 'DELETE',
      headers: ownerCookie,
    })
    expect(removed.status).toBe(204)
  })

  it('removing a MEMBERSHIP cascades their group memberships — in the database, not in a service', async () => {
    const { group } = await makeGroup()
    const gone = await actor('member')
    await request(
      `/api/groups/${group.id}/members`,
      { method: 'POST', headers: ownerCookie },
      { json: { userIds: [gone.userId] } }
    )
    await db
      .delete(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, gone.userId)))
    const left = await db
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.tenantId, tenantId), eq(groupMembers.userId, gone.userId)))
    expect(left).toEqual([])
  })
})

describe('deleting something that still grants access', () => {
  it('409 group_in_use with the counts, and ?force=1 leaves the content FAIL-CLOSED', async () => {
    const { type, group } = await makeGroup()
    const [doc] = await db
      .insert(documents)
      .values({ tenantId, title: 'Restricted', visibility: 'groups' })
      .returning()
    await db
      .insert(documentGroups)
      .values({ tenantId, documentId: doc?.id ?? '', groupId: group.id })

    const refused = await request(`/api/groups/${group.id}`, {
      method: 'DELETE',
      headers: ownerCookie,
    })
    expect(refused.status).toBe(409)
    // One count per REGISTERED visibility resource — the kit's `documents`, plus one per installed
    // plugin (D31). `toMatchObject` on the kit's own key, so installing a plugin that adds a
    // resource widens the body without failing this.
    expect(await json(refused)).toMatchObject({
      code: 'group_in_use',
      details: { documents: 1 },
    })

    const forced = await request(`/api/groups/${group.id}?force=1`, {
      method: 'DELETE',
      headers: ownerCookie,
    })
    expect(forced.status).toBe(204)

    // The grant is gone with the group — and the document is STILL `groups`, so it narrowed to its
    // owner and admins rather than becoming visible to the whole organisation.
    const [after] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, doc?.id ?? ''))
    expect(after?.visibility).toBe('groups')
    const grants = await db
      .select()
      .from(documentGroups)
      .where(eq(documentGroups.documentId, doc?.id ?? ''))
    expect(grants).toEqual([])

    // Deleting the type takes its groups with it.
    expect(
      (await request(`/api/groups/types/${type.id}`, { method: 'DELETE', headers: ownerCookie }))
        .status
    ).toBe(204)
    expect(await db.select().from(groups).where(eq(groups.groupTypeId, type.id))).toEqual([])
    expect(await db.select().from(groupTypes).where(eq(groupTypes.id, type.id))).toEqual([])
  })
})

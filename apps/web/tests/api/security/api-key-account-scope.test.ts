/**
 * An API key acts only within its organisation: it sees that one organisation in the tenant list,
 * and cannot create organisations, read its creator's invitations elsewhere or file an access
 * request. Its creator's own profile stays reachable, and a session cookie keeps every one of these.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { accessRequests, teamInvitations, tenants } from '@/db/schema'
import {
  bearerHeader,
  createTestApiKey,
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'

const db = setupTestDatabase()

/** A creator in two organisations, with a key for the first and a pending invitation to a third. */
async function creatorWithKey() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const second = await createTestTenant(db)
  await linkUserToTenant(db, user.id, second.id, 'member')
  const third = await createTestTenant(db)
  await db.insert(teamInvitations).values({
    tenantId: third.id,
    email: user.email.toLowerCase(),
    role: 'member',
    tokenHash: `hash_${uniqueId()}`,
    invitedByUserId: user.id,
    expiresAt: new Date(Date.now() + 86_400_000),
  })
  const { key } = await createTestApiKey(db, tenant.id, user.id, { scopes: ['*'] })
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return { user, tenant, second, third, key: bearerHeader(key), cookie }
}

describe('API keys stay inside their organisation', () => {
  it("a key lists only its own organisation; the creator's session lists both", async () => {
    const { tenant, second, key, cookie } = await creatorWithKey()
    const viaKey = (await json(await request('/api/tenants', { headers: key }))) as {
      id: string
    }[]
    expect(viaKey.map(t => t.id)).toEqual([tenant.id])
    const viaCookie = (await json(await request('/api/tenants', { headers: cookie }))) as {
      id: string
    }[]
    expect(viaCookie.map(t => t.id).sort()).toEqual([tenant.id, second.id].sort())
  })

  it('a key cannot create an organisation', async () => {
    const { key } = await creatorWithKey()
    const slug = `key-made-${uniqueId().toLowerCase().replace(/_/g, '-')}`
    const res = await request(
      '/api/tenants',
      { method: 'POST', headers: key },
      { json: { name: 'Made by a key', slug } }
    )
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: 'insufficient_scope' })
    expect(await db.select().from(tenants).where(eq(tenants.slug, slug))).toHaveLength(0)
  })

  it("a key cannot read its creator's invitations to other organisations", async () => {
    const { third, key, cookie } = await creatorWithKey()
    const res = await request('/api/invitations/pending', { headers: key })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: 'insufficient_scope' })
    const viaCookie = (await json(
      await request('/api/invitations/pending', { headers: cookie })
    )) as { items: { tenantId: string }[] }
    expect(viaCookie.items.map(i => i.tenantId)).toContain(third.id)
  })

  it('a key cannot file an access request', async () => {
    const { user, key } = await creatorWithKey()
    const res = await request(
      '/api/access-requests',
      { method: 'POST', headers: key },
      { json: { email: user.email, message: 'let me in' } }
    )
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: 'insufficient_scope' })
    const rows = await db.select().from(accessRequests).where(eq(accessRequests.userId, user.id))
    expect(rows).toHaveLength(0)
  })

  it("a key still reads and edits its creator's profile", async () => {
    const { key } = await creatorWithKey()
    expect((await request('/api/me', { headers: key })).status).toBe(200)
    const res = await request('/api/me', { method: 'PATCH', headers: key }, { json: { name: 'K' } })
    expect(res.status).toBe(200)
  })
})

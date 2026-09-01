/**
 * `/api/keys` (D12): admin+ list/create/revoke; plaintext once; soft revoke; tenant isolation.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { API_KEY_PREFIX_LENGTH } from '@/api/utils/core/hash'
import { apiKeys } from '@/db/schema'
import {
  bearerHeader,
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()

async function actor(role: 'owner' | 'admin' | 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

describe('/api/keys', () => {
  it('POST returns the plaintext once; GET lists only prefixes; the key authenticates', async () => {
    const a = await actor('admin')
    const res = await request(
      '/api/keys',
      { method: 'POST', headers: a.cookie },
      { json: { name: 'CI', scopes: ['read'] } }
    )
    expect(res.status).toBe(201)
    const created = await json<{ id: string; key: string; keyPrefix: string; scopes: string[] }>(
      res
    )
    expect(created.key).toMatch(/^rocketflare_/)
    expect(created.keyPrefix).toBe(created.key.slice(0, API_KEY_PREFIX_LENGTH))
    expect(created.scopes).toEqual(['read'])
    const list = await json<{ items: Array<Record<string, unknown>> }>(
      await request('/api/keys', { headers: a.cookie })
    )
    const item = list.items.find(i => i.id === created.id) as Record<string, unknown>
    expect(item).toBeDefined()
    expect(item).not.toHaveProperty('key')
    expect(item).not.toHaveProperty('keyHash')
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id))
    expect(row?.keyHash).not.toBe(created.key)
    expect((await request('/api/tenant', { headers: bearerHeader(created.key) })).status).toBe(200)
  })

  it('member → 403 on list and create; unauthenticated → 401', async () => {
    const m = await actor('member')
    expect((await request('/api/keys', { headers: m.cookie })).status).toBe(403)
    const res = await request(
      '/api/keys',
      { method: 'POST', headers: m.cookie },
      { json: { name: 'x' } }
    )
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    expect((await request('/api/keys')).status).toBe(401)
  })

  it('DELETE soft-revokes: row stays, key stops working, 404 for another tenant', async () => {
    const o = await actor('owner')
    const created = await json<{ id: string; key: string }>(
      await request('/api/keys', { method: 'POST', headers: o.cookie }, { json: { name: 'temp' } })
    )
    const other = await actor('owner')
    expect(
      (await request(`/api/keys/${created.id}`, { method: 'DELETE', headers: other.cookie })).status
    ).toBe(404)
    expect(
      (await request(`/api/keys/${created.id}`, { method: 'DELETE', headers: o.cookie })).status
    ).toBe(204)
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id))
    expect(row?.revokedAt).not.toBeNull()
    expect((await request('/api/tenant', { headers: bearerHeader(created.key) })).status).toBe(401)
    const list = await json<{ items: Array<{ id: string; revokedAt: string | null }> }>(
      await request('/api/keys', { headers: o.cookie })
    )
    expect(list.items.find(i => i.id === created.id)?.revokedAt).toBeTruthy()
  })

  it('expiresAt is honoured and lastUsedAt is stamped on use', async () => {
    const o = await actor('owner')
    const created = await json<{ id: string; key: string }>(
      await request(
        '/api/keys',
        { method: 'POST', headers: o.cookie },
        { json: { name: 'exp', expiresAt: new Date(Date.now() + 60_000).toISOString() } }
      )
    )
    expect((await request('/api/tenant', { headers: bearerHeader(created.key) })).status).toBe(200)
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id))
    expect(row?.lastUsedAt).not.toBeNull()
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, created.id))
    expect((await request('/api/tenant', { headers: bearerHeader(created.key) })).status).toBe(401)
  })

  it('a Bearer request acts as the creator with their role (member key cannot create keys)', async () => {
    const o = await actor('owner')
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, o.tenant.id, 'member')
    const { createTestApiKey } = await import('../helpers/auth')
    const { key } = await createTestApiKey(db, o.tenant.id, member.id)
    expect(
      (
        await request(
          '/api/keys',
          { method: 'POST', headers: bearerHeader(key) },
          { json: { name: 'x' } }
        )
      ).status
    ).toBe(403)
    expect((await request('/api/members', { headers: bearerHeader(key) })).status).toBe(200)
  })
})

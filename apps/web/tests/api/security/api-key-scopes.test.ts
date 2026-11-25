/**
 * An API key's stored scopes limit what it can do: a read-only key cannot change anything, a
 * write or wildcard key can, and session cookies are not scoped at all.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { apiKeys, users } from '@/db/schema'
import {
  bearerHeader,
  createTestApiKey,
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'

const db = setupTestDatabase()

async function adminWithKey(scopes: string[]) {
  const { user, tenant } = await createTestTenantWithUser(db, 'admin')
  const { key } = await createTestApiKey(db, tenant.id, user.id, { scopes })
  return { user, tenant, headers: bearerHeader(key) }
}

describe('API key scopes', () => {
  it('a read-scoped key can read', async () => {
    const { headers } = await adminWithKey(['read'])
    expect((await request('/api/me', { headers })).status).toBe(200)
  })

  it('a read-scoped key cannot change its owner profile', async () => {
    const { user, headers } = await adminWithKey(['read'])
    const res = await request(
      '/api/me',
      { method: 'PATCH', headers },
      { json: { name: 'Changed by a read-scoped key' } }
    )
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: 'insufficient_scope' })
    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row?.name).toBe(user.name)
  })

  it('a read-scoped key cannot create or revoke keys', async () => {
    const { user, tenant, headers } = await adminWithKey(['read'])
    const { row: sibling } = await createTestApiKey(db, tenant.id, user.id)
    const created = await request(
      '/api/keys',
      { method: 'POST', headers },
      { json: { name: 'wider', scopes: ['read', 'write'] } }
    )
    expect(created.status).toBe(403)
    const revoked = await request(`/api/keys/${sibling.id}`, { method: 'DELETE', headers })
    expect(revoked.status).toBe(403)
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, sibling.id))
    expect(row?.revokedAt).toBeNull()
  })

  it('a key with no scopes can do nothing', async () => {
    const { headers } = await adminWithKey([])
    expect((await request('/api/me', { headers })).status).toBe(403)
  })

  it.each([[['write']], [['read', 'write']], [['*']]])(
    'a key scoped %j can read and write',
    async scopes => {
      const { headers } = await adminWithKey(scopes)
      expect((await request('/api/me', { headers })).status).toBe(200)
      const res = await request(
        '/api/me',
        { method: 'PATCH', headers },
        { json: { name: 'Renamed' } }
      )
      expect(res.status).toBe(200)
    }
  )

  it('a session cookie is not limited by scopes', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'admin')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const res = await request(
      '/api/me',
      { method: 'PATCH', headers: cookie },
      { json: { name: 'Renamed by session' } }
    )
    expect(res.status).toBe(200)
  })
})

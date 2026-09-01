/**
 * Cookie + Bearer authentication (D12): `/auth/session`, `authMiddleware` codes, sliding expiry,
 * logout, select-tenant.
 */
import type { SessionResponse } from '@gmgo/shared/auth'
import { ERROR_CODES } from '@gmgo/shared/errors'
import { eq } from 'drizzle-orm'
import { describe, expect, inject, it } from 'vitest'
import { SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { hashToken } from '@/api/utils/core/hash'
import { tenants, userSessions } from '@/db/schema'
import {
  bearerHeader,
  createTestApiKey,
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
const seed = inject('seed')

describe('GET /auth/session', () => {
  it('401 unauthorized without a cookie', async () => {
    const res = await request('/auth/session')
    expect(res.status).toBe(401)
    expect(await json(res)).toMatchObject({ statusCode: 401, code: ERROR_CODES.unauthorized })
  })

  it('401 for an unknown token', async () => {
    const res = await request('/auth/session', { headers: sessionCookieHeader('nope') })
    expect(res.status).toBe(401)
  })

  it('returns the session response for the seeded owner', async () => {
    const res = await request('/auth/session', { headers: sessionCookieHeader(seed.sessionToken) })
    expect(res.status).toBe(200)
    const body = await json<SessionResponse>(res)
    expect(body.user.email).toBe(seed.user.email)
    expect(body.tenant).toMatchObject({ id: seed.tenant.id, slug: seed.tenant.slug, role: 'owner' })
    expect(body.tenants.map(t => t.id)).toContain(seed.tenant.id)
    expect(body.permissions.length).toBeGreaterThan(0)
    expect(body).toMatchObject({
      features: [],
      tenancyMode: 'multi',
      signupMode: 'invite_only',
      version: 'test',
    })
    expect(body.accessRequest).toBeNull()
  })

  it('200 with tenant: null for a user with no membership', async () => {
    const user = await createTestUser(db)
    const token = await createTestSession(db, user.id)
    const res = await request('/auth/session', { headers: sessionCookieHeader(token) })
    expect(res.status).toBe(200)
    const body = await json<SessionResponse>(res)
    expect(body.tenant).toBeNull()
    expect(body.tenants).toEqual([])
    expect(body.permissions).toEqual([])
  })

  it('401 for an expired session and deletes the row', async () => {
    const user = await createTestUser(db)
    const token = await createTestSession(db, user.id, null, { expiresInDays: -1 })
    const res = await request('/auth/session', { headers: sessionCookieHeader(token) })
    expect(res.status).toBe(401)
    const rows = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.tokenHash, await hashToken(token)))
    expect(rows).toHaveLength(0)
  })

  it('slides the expiry when the last touch is over an hour old', async () => {
    const user = await createTestUser(db)
    const token = await createTestSession(db, user.id, null, { expiresInDays: 3 })
    const tokenHash = await hashToken(token)
    await db
      .update(userSessions)
      .set({ lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(userSessions.tokenHash, tokenHash))
    const res = await request('/auth/session', { headers: sessionCookieHeader(token) })
    expect(res.status).toBe(200)
    const [row] = await db.select().from(userSessions).where(eq(userSessions.tokenHash, tokenHash))
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000)
    expect(row?.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  it('403 blocked for a blocked user', async () => {
    const user = await createTestUser(db, { blockedAt: new Date() })
    const token = await createTestSession(db, user.id)
    const res = await request('/auth/session', { headers: sessionCookieHeader(token) })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: ERROR_CODES.blocked })
  })

  it('falls back to another membership when the selected tenant is stale', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const other = await createTestTenant(db)
    const token = await createTestSession(db, user.id, other.id) // not a member of `other`
    const res = await request('/auth/session', { headers: sessionCookieHeader(token) })
    const body = await json<SessionResponse>(res)
    expect(body.tenant?.id).toBe(tenant.id)
  })
})

describe('authMiddleware on /api/*', () => {
  it('401 unauthorized without credentials', async () => {
    const res = await request('/api/members')
    expect(res.status).toBe(401)
    expect(await json(res)).toMatchObject({ statusCode: 401, code: ERROR_CODES.unauthorized })
  })

  it('cookie path: 200 for the seeded owner', async () => {
    const res = await request('/api/tenant', { headers: sessionCookieHeader(seed.sessionToken) })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ id: seed.tenant.id, slug: seed.tenant.slug })
  })

  it('bearer path: the seeded API key resolves the tenant', async () => {
    const res = await request('/api/tenant', { headers: bearerHeader(seed.apiKey) })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ id: seed.tenant.id })
  })

  it('bearer path: invalid key → 401', async () => {
    const res = await request('/api/tenant', { headers: bearerHeader('gmgo_not_a_key') })
    expect(res.status).toBe(401)
  })

  it('bearer path: revoked and expired keys → 401', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const revoked = await createTestApiKey(db, tenant.id, user.id, { revokedAt: new Date() })
    const expired = await createTestApiKey(db, tenant.id, user.id, {
      expiresAt: new Date(Date.now() - 1000),
    })
    expect((await request('/api/tenant', { headers: bearerHeader(revoked.key) })).status).toBe(401)
    expect((await request('/api/tenant', { headers: bearerHeader(expired.key) })).status).toBe(401)
  })

  it('bearer path: key whose creator left the tenant → 401', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'admin')
    const { key } = await createTestApiKey(db, tenant.id, user.id)
    const other = await createTestUser(db)
    await linkUserToTenant(db, other.id, tenant.id, 'owner')
    const ownerToken = await createTestSession(db, other.id, tenant.id)
    const removed = await request(`/api/members/${user.id}`, {
      method: 'DELETE',
      headers: sessionCookieHeader(ownerToken),
    })
    expect(removed.status).toBe(204)
    expect((await request('/api/tenant', { headers: bearerHeader(key) })).status).toBe(401)
  })

  it('bearer path: /auth/session does not accept API keys', async () => {
    const res = await request('/auth/session', { headers: bearerHeader(seed.apiKey) })
    expect(res.status).toBe(401)
  })

  it('403 no_tenant for a session without membership on a tenant route', async () => {
    const user = await createTestUser(db)
    const token = await createTestSession(db, user.id)
    const res = await request('/api/members', { headers: sessionCookieHeader(token) })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: ERROR_CODES.noTenant })
  })

  it('403 tenant_suspended when the tenant is suspended', async () => {
    const { user, tenant } = await createTestTenantWithUser(
      db,
      'owner',
      {},
      { status: 'suspended' }
    )
    const token = await createTestSession(db, user.id, tenant.id)
    const res = await request('/api/members', { headers: sessionCookieHeader(token) })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: ERROR_CODES.tenantSuspended })
    await db.update(tenants).set({ status: 'active' }).where(eq(tenants.id, tenant.id))
  })
})

describe('POST /auth/select-tenant', () => {
  it('switches the session and 403s for a non-member tenant', async () => {
    const user = await createTestUser(db)
    const a = await createTestTenant(db)
    const b = await createTestTenant(db)
    const other = await createTestTenant(db)
    await linkUserToTenant(db, user.id, a.id, 'owner')
    await linkUserToTenant(db, user.id, b.id, 'member')
    const token = await createTestSession(db, user.id, a.id)
    const ok = await request(
      '/auth/select-tenant',
      { method: 'POST', headers: sessionCookieHeader(token) },
      { json: { tenantId: b.id } }
    )
    expect(ok.status).toBe(200)
    expect((await json<SessionResponse>(ok)).tenant?.id).toBe(b.id)
    const denied = await request(
      '/auth/select-tenant',
      { method: 'POST', headers: sessionCookieHeader(token) },
      { json: { tenantId: other.id } }
    )
    expect(denied.status).toBe(403)
  })

  it('400 validation envelope for a non-uuid', async () => {
    const res = await request(
      '/auth/select-tenant',
      { method: 'POST', headers: sessionCookieHeader(seed.sessionToken) },
      { json: { tenantId: 'nope' } }
    )
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ statusCode: 400, code: ERROR_CODES.validationFailed })
  })
})

describe('POST /auth/logout', () => {
  it('deletes the session row and clears the cookie', async () => {
    const user = await createTestUser(db)
    const token = await createTestSession(db, user.id)
    const res = await request('/auth/logout', {
      method: 'POST',
      headers: sessionCookieHeader(token),
    })
    expect(res.status).toBe(204)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
    const rows = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.tokenHash, await hashToken(token)))
    expect(rows).toHaveLength(0)
    expect((await request('/auth/session', { headers: sessionCookieHeader(token) })).status).toBe(
      401
    )
  })

  it('204 even without a session', async () => {
    expect((await request('/auth/logout', { method: 'POST' })).status).toBe(204)
  })
})

describe('GET /auth/methods', () => {
  it('lists magic link, configured providers and devLogin in development', async () => {
    const res = await request('/auth/methods')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      magicLink: true,
      providers: ['google', 'microsoft'],
      devLogin: true,
    })
  })

  it('hides unconfigured providers and devLogin outside development', async () => {
    const res = await request(
      '/auth/methods',
      {},
      {
        env: (await import('../mocks/bindings')).createTestEnv({
          APP_ENV: 'staging',
          GOOGLE_CLIENT_ID: '',
          GOOGLE_CLIENT_SECRET: '',
        }),
      }
    )
    expect(await json(res)).toEqual({ magicLink: true, providers: ['microsoft'], devLogin: false })
  })
})

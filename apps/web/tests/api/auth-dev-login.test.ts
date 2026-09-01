/**
 * `POST /auth/dev-login` (D11): development only — 404 elsewhere; creates/finds the user, bypasses
 * gating, sets the cookie, answers with the session response.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { tenants, tenantUsers, users } from '@/db/schema'
import {
  createTestTenantWithUser,
  createTestUser,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

const devLogin = (body: unknown, env = createTestEnv()) =>
  request('/auth/dev-login', { method: 'POST' }, { json: body, env })

describe('POST /auth/dev-login', () => {
  it('404 envelope outside development', async () => {
    for (const APP_ENV of ['staging', 'production'] as const) {
      const res = await devLogin({ email: 'x@example.test' }, createTestEnv({ APP_ENV }))
      expect(res.status).toBe(404)
      expect(await json(res)).toMatchObject({ statusCode: 404 })
    }
  })

  it('creates an unknown user (bypassing invite_only) and sets the cookie', async () => {
    const email = `dev_${uniqueId().toLowerCase()}@example.test`
    const res = await devLogin({ email, name: 'Dev Person' })
    expect(res.status).toBe(200)
    const body = await json<{ user: { email: string; name: string }; tenant: unknown }>(res)
    expect(body.user).toMatchObject({ email, name: 'Dev Person' })
    expect(body.tenant).toBeNull()
    const cookie = res.headers
      .getSetCookie()
      .find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`)) as string
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Path=/')
    const token = cookie.split(';')[0]?.split('=')[1] as string
    expect((await request('/auth/session', { headers: sessionCookieHeader(token) })).status).toBe(
      200
    )
    const [row] = await db.select().from(users).where(eq(users.email, email))
    expect(row?.emailVerifiedAt).not.toBeNull()
  })

  it('finds an existing member and selects their tenant', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'admin')
    const res = await devLogin({ email: user.email })
    const body = await json<{ tenant: { id: string; role: string } }>(res)
    expect(body.tenant).toMatchObject({ id: tenant.id, role: 'admin' })
  })

  it('refuses a blocked user with 403', async () => {
    const user = await createTestUser(db, { blockedAt: new Date() })
    const res = await devLogin({ email: user.email })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: 'blocked' })
  })

  it('400 envelope for an invalid body', async () => {
    const res = await devLogin({ email: 'nope' })
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'validation_failed' })
  })

  it('single mode: a new dev user is auto-joined to the single tenant', async () => {
    const env = createTestEnv({ TENANCY_MODE: 'single' })
    const email = `devsingle_${uniqueId().toLowerCase()}@example.test`
    const res = await devLogin({ email }, env)
    const body = await json<{ tenant: { id: string; role: string } }>(res)
    const [oldest] = await db.select().from(tenants).orderBy(tenants.createdAt).limit(1)
    expect(body.tenant).toMatchObject({ id: oldest?.id, role: 'member' })
    const [user] = await db.select().from(users).where(eq(users.email, email))
    const rows = await db
      .select()
      .from(tenantUsers)
      .where(
        and(eq(tenantUsers.userId, user?.id ?? ''), eq(tenantUsers.tenantId, oldest?.id ?? ''))
      )
    expect(rows).toHaveLength(1)
  })
})

/**
 * Magic-link login + sign-up gating (D9, D11, D12): request is always 202, verify sets the cookie
 * and redirects, expired/invalid/consumed tokens redirect with an error code, SIGNUP_MODE decides
 * new users, BOOTSTRAP_ADMIN_EMAILS promotes on verified login.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { requestMagicLink } from '@/api/routes/auth/magic-link'
import { hashToken } from '@/api/utils/core/hash'
import { randomToken } from '@/api/utils/core/ids'
import { loadConfig } from '@/config'
import {
  accessRequests,
  magicLinkTokens,
  teamInvitations,
  tenants,
  tenantUsers,
  users,
} from '@/db/schema'
import {
  createTestTenantWithUser,
  createTestUser,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

function stubLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** Issue a link the way the route does and return the verify URL (the "returned test hook"). */
async function linkFor(email: string, env: TestEnv = createTestEnv(), redirectTo?: string) {
  const logger = stubLogger()
  const { verifyUrl } = await requestMagicLink(db, loadConfig(env), logger, { email, redirectTo })
  return { verifyUrl, logger }
}

function sessionCookieFrom(res: Response): string | undefined {
  const cookie = res.headers.getSetCookie().find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`))
  return cookie?.split(';')[0]?.split('=')[1]
}

function location(res: Response): URL {
  return new URL(res.headers.get('location') ?? '', 'http://localhost:3001')
}

describe('POST /auth/magic-link/request', () => {
  it('202 { ok: true } and stores a hashed token row', async () => {
    const email = `ml_${uniqueId().toLowerCase()}@example.test`
    const res = await request('/auth/magic-link/request', { method: 'POST' }, { json: { email } })
    expect(res.status).toBe(202)
    expect(await json(res)).toEqual({ ok: true })
    const rows = await db.select().from(magicLinkTokens).where(eq(magicLinkTokens.email, email))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('202 for an unknown address too (anti-enumeration)', async () => {
    const res = await request(
      '/auth/magic-link/request',
      { method: 'POST' },
      { json: { email: `nobody_${uniqueId().toLowerCase()}@example.test` } }
    )
    expect(res.status).toBe(202)
  })

  it('400 envelope for an invalid email', async () => {
    const res = await request(
      '/auth/magic-link/request',
      { method: 'POST' },
      { json: { email: 'nope' } }
    )
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ statusCode: 400, code: 'validation_failed' })
  })

  it('logs the verify URL when RESEND_API_KEY is absent', async () => {
    const { verifyUrl, logger } = await linkFor(`log_${uniqueId().toLowerCase()}@example.test`)
    expect(verifyUrl).toContain('/auth/magic-link/verify?token=')
    const logged = logger.info.mock.calls.flat().map(String).join('\n')
    expect(logged).toContain(verifyUrl)
  })
})

describe('GET /auth/magic-link/verify', () => {
  it('signs in an existing member: cookie set, 302 to /', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const { verifyUrl } = await linkFor(user.email)
    const res = await request(verifyUrl)
    expect(res.status).toBe(302)
    expect(location(res).pathname).toBe('/')
    const token = sessionCookieFrom(res)
    expect(token).toBeTruthy()
    const session = await request('/auth/session', {
      headers: sessionCookieHeader(token as string),
    })
    expect(session.status).toBe(200)
    expect((await json<{ tenant: { id: string } }>(session)).tenant.id).toBe(tenant.id)
    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row?.lastLoginAt).not.toBeNull()
  })

  it('honours a safe redirectTo and rejects an absolute one', async () => {
    const user = await createTestUser(db)
    const a = await linkFor(user.email, createTestEnv(), '/settings/members')
    expect(location(await request(a.verifyUrl)).pathname).toBe('/settings/members')
    const b = await linkFor(user.email)
    const res = await request(
      `${b.verifyUrl}&redirectTo=${encodeURIComponent('https://evil.example/x')}`
    )
    expect(location(res).pathname).toBe('/')
  })

  it('a consumed token → /login?error=invalid_token', async () => {
    const user = await createTestUser(db)
    const { verifyUrl } = await linkFor(user.email)
    expect((await request(verifyUrl)).status).toBe(302)
    const second = await request(verifyUrl)
    expect(location(second).pathname).toBe('/login')
    expect(location(second).searchParams.get('error')).toBe('invalid_token')
  })

  it('garbage → invalid_token; expired → expired', async () => {
    const bad = await request('/auth/magic-link/verify?token=garbage')
    expect(location(bad).searchParams.get('error')).toBe('invalid_token')
    const user = await createTestUser(db)
    const token = randomToken(32)
    await db.insert(magicLinkTokens).values({
      email: user.email,
      tokenHash: await hashToken(token),
      expiresAt: new Date(Date.now() - 1000),
    })
    const res = await request(`/auth/magic-link/verify?token=${token}`)
    expect(location(res).searchParams.get('error')).toBe('expired')
  })

  it('blocked user → /login?error=blocked', async () => {
    const user = await createTestUser(db, { blockedAt: new Date() })
    const { verifyUrl } = await linkFor(user.email)
    expect(location(await request(verifyUrl)).searchParams.get('error')).toBe('blocked')
  })
})

describe('sign-up gating (SIGNUP_MODE)', () => {
  it('invite_only: unknown address → not_invited, no user created', async () => {
    const email = `gate_${uniqueId().toLowerCase()}@example.test`
    const { verifyUrl } = await linkFor(email)
    const res = await request(verifyUrl)
    expect(location(res).searchParams.get('error')).toBe('not_invited')
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0)
  })

  it('invite_only: an address with a pending invitation is admitted (no tenant yet)', async () => {
    const { user: inviter, tenant } = await createTestTenantWithUser(db, 'owner')
    const email = `invitee_${uniqueId().toLowerCase()}@example.test`
    await db.insert(teamInvitations).values({
      tenantId: tenant.id,
      email,
      role: 'member',
      tokenHash: await hashToken(randomToken(32)),
      invitedByUserId: inviter.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    const { verifyUrl } = await linkFor(email)
    const res = await request(verifyUrl)
    expect(location(res).pathname).toBe('/')
    const token = sessionCookieFrom(res) as string
    const body = await json<{ tenant: unknown; user: { email: string; emailVerifiedAt: string } }>(
      await request('/auth/session', { headers: sessionCookieHeader(token) })
    )
    expect(body.user.email).toBe(email)
    expect(body.user.emailVerifiedAt).toBeTruthy()
    expect(body.tenant).toBeNull()
  })

  it('open (multi): creates the user and a personal workspace as owner', async () => {
    const env = createTestEnv({ SIGNUP_MODE: 'open' })
    const email = `open_${uniqueId().toLowerCase()}@example.test`
    const { verifyUrl } = await linkFor(email, env)
    const res = await request(verifyUrl, {}, { env })
    const token = sessionCookieFrom(res) as string
    const body = await json<{ tenant: { name: string; role: string } | null }>(
      await request('/auth/session', { headers: sessionCookieHeader(token) }, { env })
    )
    expect(body.tenant?.role).toBe('owner')
    expect(body.tenant?.name).toMatch(/workspace$/)
  })

  it('approval: creates the user + a pending access request; session has no tenant', async () => {
    const env = createTestEnv({ SIGNUP_MODE: 'approval' })
    const email = `appr_${uniqueId().toLowerCase()}@example.test`
    const { verifyUrl } = await linkFor(email, env)
    const res = await request(verifyUrl, {}, { env })
    const token = sessionCookieFrom(res) as string
    const body = await json<{ tenant: unknown; accessRequest: { status: string } | null }>(
      await request('/auth/session', { headers: sessionCookieHeader(token) }, { env })
    )
    expect(body.tenant).toBeNull()
    expect(body.accessRequest).toEqual({ status: 'pending' })
    const rows = await db
      .select()
      .from(accessRequests)
      .where(and(eq(accessRequests.email, email), eq(accessRequests.status, 'pending')))
    expect(rows).toHaveLength(1)
    // A second login reuses the same pending request.
    const again = await linkFor(email, env)
    await request(again.verifyUrl, {}, { env })
    expect(
      await db
        .select()
        .from(accessRequests)
        .where(and(eq(accessRequests.email, email), isNull(accessRequests.decidedAt)))
    ).toHaveLength(1)
    // Tenant routes answer 403 pending_approval.
    const denied = await request('/api/members', { headers: sessionCookieHeader(token) }, { env })
    expect(denied.status).toBe(403)
    expect(await json(denied)).toMatchObject({ code: 'pending_approval' })
  })

  it('BOOTSTRAP_ADMIN_EMAILS: first verified login creates a global admin (even in invite_only)', async () => {
    const email = `boot_${uniqueId().toLowerCase()}@example.test`
    const env = createTestEnv({
      BOOTSTRAP_ADMIN_EMAILS: `Other@example.test, ${email.toUpperCase()}`,
    })
    const { verifyUrl } = await linkFor(email, env)
    const res = await request(verifyUrl, {}, { env })
    expect(location(res).pathname).toBe('/')
    const [row] = await db.select().from(users).where(eq(users.email, email))
    expect(row?.isGlobalAdmin).toBe(true)
    expect(row?.emailVerifiedAt).not.toBeNull()
    // and the admin console works with no tenant at all
    const token = sessionCookieFrom(res) as string
    const admin = await request(
      '/api/admin/users?pageSize=1',
      { headers: sessionCookieHeader(token) },
      { env }
    )
    expect(admin.status).toBe(200)
  })

  it('BOOTSTRAP_ADMIN_EMAILS: promotes an existing unverified user only on verified login', async () => {
    const user = await createTestUser(db, { emailVerifiedAt: null })
    const env = createTestEnv({ BOOTSTRAP_ADMIN_EMAILS: user.email })
    const { verifyUrl } = await linkFor(user.email, env)
    await request(verifyUrl, {}, { env })
    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row?.isGlobalAdmin).toBe(true)
    expect(row?.emailVerifiedAt).not.toBeNull()
  })

  it('single-tenant auto-join: an open sign-up joins the oldest tenant as member', async () => {
    const env = createTestEnv({ TENANCY_MODE: 'single', SIGNUP_MODE: 'open' })
    const email = `single_${uniqueId().toLowerCase()}@example.test`
    const { verifyUrl } = await linkFor(email, env)
    const res = await request(verifyUrl, {}, { env })
    const [oldest] = await db.select().from(tenants).orderBy(tenants.createdAt).limit(1)
    const [user] = await db.select().from(users).where(eq(users.email, email))
    const membership = await db
      .select()
      .from(tenantUsers)
      .where(
        and(eq(tenantUsers.userId, user?.id ?? ''), eq(tenantUsers.tenantId, oldest?.id ?? ''))
      )
    expect(membership[0]?.role).toBe('member')
    expect(res.status).toBe(302)
    expect(sql).toBeDefined()
  })
})

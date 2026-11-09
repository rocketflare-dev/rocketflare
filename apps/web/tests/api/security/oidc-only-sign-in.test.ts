/**
 * `AUTH_OIDC_ONLY=true` turns the magic-link routes off on the server: a request mints no token and
 * sends no mail (the answer is the same 202), a link issued earlier is refused, and `/auth/methods`
 * reports the method as unavailable.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { requestMagicLink } from '@/api/routes/auth/magic-link'
import { loadConfig } from '@/config'
import { magicLinkTokens } from '@/db/schema'
import { createTestTenantWithUser, SESSION_COOKIE_NAME } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const env = () =>
  createTestEnv({
    APP_ENV: 'production',
    APP_URL: 'https://app.example',
    OIDC_ISSUER: 'https://issuer.example/realms/test',
    OIDC_CLIENT_ID: 'test-client',
    OIDC_CLIENT_SECRET: 'test-secret',
    AUTH_OIDC_ONLY: 'true',
  })

const tokensFor = (email: string) =>
  db.select().from(magicLinkTokens).where(eq(magicLinkTokens.email, email.toLowerCase()))

describe('AUTH_OIDC_ONLY and magic links', () => {
  it('POST /auth/magic-link/request answers 202 and mints nothing', async () => {
    const { user } = await createTestTenantWithUser(db, 'member')
    const res = await request(
      '/auth/magic-link/request',
      { method: 'POST' },
      { env: env(), json: { email: user.email } }
    )
    expect(res.status).toBe(202)
    expect(await json(res)).toEqual({ ok: true })
    expect(await tokensFor(user.email)).toHaveLength(0)
  })

  it('POST /auth/magic-link/verify refuses a link issued earlier and leaves it unspent', async () => {
    const { user } = await createTestTenantWithUser(db, 'member')
    const testEnv = env()
    const { verifyUrl } = await requestMagicLink(db, loadConfig(testEnv), logger, {
      email: user.email,
    })
    const token = new URL(verifyUrl).searchParams.get('token') as string
    const res = await request(
      '/auth/magic-link/verify',
      { method: 'POST', body: new URLSearchParams({ token }) },
      { env: testEnv }
    )
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location') as string, 'https://app.example').search).toBe(
      '?error=oidc_only'
    )
    expect(res.headers.getSetCookie().join()).not.toContain(SESSION_COOKIE_NAME)
    const unspent = await db
      .select()
      .from(magicLinkTokens)
      .where(and(eq(magicLinkTokens.email, user.email), isNull(magicLinkTokens.consumedAt)))
    expect(unspent).toHaveLength(1)
  })

  it('/auth/methods reports magic links as off', async () => {
    const methods = await json<{ magicLink: boolean; oidcOnly: boolean }>(
      await request('/auth/methods', {}, { env: env() })
    )
    expect(methods).toMatchObject({ magicLink: false, oidcOnly: true })
  })
})

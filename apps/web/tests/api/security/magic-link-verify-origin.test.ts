/**
 * `POST /auth/magic-link/verify` is same-origin only: a cross-site form post is refused without
 * spending the token or signing anyone in. The emailed-link flow (the confirm page's own form) and
 * a client that sends no fetch metadata at all still sign in.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { requestMagicLink } from '@/api/routes/auth/magic-link'
import { loadConfig } from '@/config'
import { magicLinkTokens } from '@/db/schema'
import { createTestTenantWithUser, SESSION_COOKIE_NAME } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const APP = 'https://app.example'
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

async function issuedLink() {
  const { user } = await createTestTenantWithUser(db, 'member')
  const env = createTestEnv({ APP_ENV: 'production', APP_URL: APP })
  const { verifyUrl } = await requestMagicLink(db, loadConfig(env), logger, { email: user.email })
  return { env, user, token: new URL(verifyUrl).searchParams.get('token') as string }
}

const post = (
  env: ReturnType<typeof createTestEnv>,
  token: string,
  headers: Record<string, string>
) =>
  request(
    '/auth/magic-link/verify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ token }).toString(),
    },
    { env }
  )

const unspent = async (email: string) => {
  const rows = await db.select().from(magicLinkTokens).where(eq(magicLinkTokens.email, email))
  return rows.filter(r => r.consumedAt === null).length
}

describe('POST /auth/magic-link/verify origin check', () => {
  it.each([
    ['fetch metadata', { 'Sec-Fetch-Site': 'cross-site' }],
    ['a foreign Origin', { Origin: 'https://other.example' }],
    ['a foreign Referer', { Referer: 'https://other.example/page' }],
  ])('a cross-site post named by %s is refused', async (_, headers) => {
    const { env, user, token } = await issuedLink()
    const res = await post(env, token, headers)
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: 'csrf_failed' })
    expect(res.headers.getSetCookie().join()).not.toContain(SESSION_COOKIE_NAME)
    expect(await unspent(user.email)).toBe(1)
  })

  it("the confirm page's own form signs in", async () => {
    const { env, token } = await issuedLink()
    const res = await post(env, token, {
      Origin: APP,
      Referer: `${APP}/magic-link/confirm?token=${token}`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'navigate',
    })
    expect(res.status).toBe(303)
    expect(res.headers.getSetCookie().join()).toContain(SESSION_COOKIE_NAME)
  })

  it('a client sending no fetch metadata signs in', async () => {
    const { env, token } = await issuedLink()
    const res = await post(env, token, {})
    expect(res.status).toBe(303)
  })
})

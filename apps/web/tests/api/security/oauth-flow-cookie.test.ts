// @vitest-isolate
// Stubs the provider's HTTP endpoints on the global fetch, so it needs its own module registry.
/**
 * The OAuth flow cookie is a `__Host-` cookie: a same-named cookie without the prefix is not read,
 * and the return path it carries is re-checked at the callback, so a value that is not a
 * same-origin path never reaches `Location`.
 */
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { oauthProviders } from '@/db/schema'
import { createTestSession, createTestTenantWithUser, uniqueId } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const realFetch = globalThis.fetch
const APP = 'https://app.example'
let sub: string

beforeEach(() => {
  sub = `sub_${uniqueId()}`
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'access-token', token_type: 'Bearer' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.startsWith('https://openidconnect.googleapis.com/')) {
      return new Response(
        JSON.stringify({ sub, email: `${sub}@example.test`, email_verified: true }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    return realFetch(input, init)
  })
})
afterEach(() => vi.restoreAllMocks())

function flowValue(flow: Record<string, unknown>): string {
  return btoa(JSON.stringify(flow)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('OAuth flow cookie', () => {
  const env = () => createTestEnv({ APP_ENV: 'production', APP_URL: APP })

  it('is set with the __Host- prefix, Secure, Path=/ and no Domain', async () => {
    const res = await request('/auth/google', {}, { env: env() })
    const cookie = res.headers
      .getSetCookie()
      .find(c => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`)) as string
    expect(OAUTH_STATE_COOKIE_NAME.startsWith('__Host-')).toBe(true)
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Path=/')
    expect(cookie.toLowerCase()).not.toContain('domain=')
  })

  it('a cookie named without the prefix is not read at the callback', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const session = await createTestSession(db, user.id, tenant.id)
    const flow = flowValue({
      provider: 'google',
      state: 'state-fixture',
      verifier: 'verifier-fixture',
      redirectTo: '/settings',
      linkUserId: user.id,
    })
    const res = await request(
      '/auth/google/callback?code=code-fixture&state=state-fixture',
      { headers: { Cookie: `oauth_state=${flow}; ${SESSION_COOKIE_NAME}=${session}` } },
      { env: env() }
    )
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location') as string, APP).searchParams.get('error')).toBe(
      'oauth_state_mismatch'
    )
    const links = await db
      .select()
      .from(oauthProviders)
      .where(eq(oauthProviders.providerUserId, sub))
    expect(links).toHaveLength(0)
  })

  it('a return path that is not a same-origin path is dropped at the callback', async () => {
    const res = await request(
      '/auth/google/callback?code=code-fixture&state=state-fixture',
      {
        headers: {
          Cookie: `${OAUTH_STATE_COOKIE_NAME}=${flowValue({
            provider: 'google',
            state: 'state-fixture',
            verifier: 'verifier-fixture',
            redirectTo: 'https://other.example/landed',
          })}`,
        },
      },
      { env: createTestEnv({ APP_ENV: 'production', APP_URL: APP, SIGNUP_MODE: 'open' }) }
    )
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location') as string, APP).origin).toBe(APP)
  })
})

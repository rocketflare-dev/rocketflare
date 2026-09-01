// @vitest-isolate
// Mocks the `arctic` module and the global fetch, so this file needs its own registry.
/**
 * Generic OAuth router (D11, D12): start sets the single `oauth_state` cookie and redirects to the
 * provider; the callback validates state, exchanges the code (stubbed arctic), fetches the profile
 * (stubbed fetch), links/creates the user under sign-up gating and sets the session cookie.
 */
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('arctic', () => {
  class FakeClient {
    createAuthorizationURL(state: string, verifier: string, scopes: string[]) {
      const url = new URL('https://provider.test/authorize')
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', verifier.slice(0, 8))
      url.searchParams.set('scope', scopes.join(' '))
      return url
    }
    async validateAuthorizationCode(code: string) {
      if (code === 'bad-code') throw new Error('invalid_grant')
      return {
        accessToken: () => `access-${code}`,
        hasRefreshToken: () => true,
        refreshToken: () => 'refresh-token',
        accessTokenExpiresAt: () => new Date(Date.now() + 3600_000),
      }
    }
  }
  return {
    Google: FakeClient,
    MicrosoftEntraId: FakeClient,
    generateState: () => `state-${Math.random().toString(36).slice(2)}`,
    generateCodeVerifier: () => `verifier-${Math.random().toString(36).slice(2)}`,
  }
})

import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { decrypt } from '@/api/auth/oauth-encryption'
import { oauthProviders, users } from '@/db/schema'
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

interface Profile {
  sub: string
  email: string
  email_verified?: boolean
  name?: string
  picture?: string
}

let profile: Profile
const realFetch = globalThis.fetch

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://openidconnect.googleapis.com/')) {
      return new Response(JSON.stringify(profile), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.startsWith('https://graph.microsoft.com/')) {
      return new Response(
        JSON.stringify({
          id: profile.sub,
          displayName: profile.name ?? null,
          mail: profile.email,
          userPrincipalName: profile.email,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    return realFetch(input, init)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function cookieValue(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .find(c => c.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.slice(name.length + 1)
}

function location(res: Response): URL {
  return new URL(res.headers.get('location') ?? '', 'http://localhost:3001')
}

async function start(provider = 'google', env = createTestEnv(), query = '') {
  const res = await request(`/auth/${provider}${query}`, {}, { env })
  expect(res.status).toBe(302)
  const flowCookie = cookieValue(res, OAUTH_STATE_COOKIE_NAME) as string
  expect(flowCookie).toBeTruthy()
  const state = location(res).searchParams.get('state') as string
  return { flowCookie, state, env }
}

async function callback(
  provider: string,
  flow: { flowCookie: string; state: string; env: ReturnType<typeof createTestEnv> },
  overrides: { code?: string; state?: string; cookie?: string } = {}
) {
  const params = new URLSearchParams({
    code: overrides.code ?? 'good-code',
    state: overrides.state ?? flow.state,
  })
  const cookie = overrides.cookie ?? `${OAUTH_STATE_COOKIE_NAME}=${flow.flowCookie}`
  return request(
    `/auth/${provider}/callback?${params}`,
    { headers: { Cookie: cookie } },
    { env: flow.env }
  )
}

describe('GET /auth/:provider', () => {
  it('redirects to the provider with state + PKCE and sets ONE oauth_state cookie', async () => {
    const res = await request('/auth/google')
    expect(res.status).toBe(302)
    const target = location(res)
    expect(target.hostname).toBe('provider.test')
    expect(target.searchParams.get('code_challenge')).toBeTruthy()
    const cookies = res.headers.getSetCookie()
    expect(cookies.filter(c => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`))).toHaveLength(1)
    expect(cookies[0]).toContain('HttpOnly')
    expect(cookies[0]).toContain('SameSite=Lax')
  })

  it('404 envelope for an unknown provider', async () => {
    const res = await request('/auth/facebook')
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ statusCode: 404, code: 'not_found' })
  })

  it('404 for a provider without credentials', async () => {
    const env = createTestEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' })
    expect((await request('/auth/google', {}, { env })).status).toBe(404)
    expect((await request('/auth/microsoft', {}, { env })).status).toBe(302)
  })

  it('503 oauth_encryption_key_missing when OAUTH_ENCRYPTION_KEY is unset', async () => {
    const env = createTestEnv({ OAUTH_ENCRYPTION_KEY: '' })
    const res = await request('/auth/google', {}, { env })
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ code: 'oauth_encryption_key_missing' })
  })
})

describe('GET /auth/:provider/callback', () => {
  it('links an existing user by verified email, encrypts tokens, sets the session cookie', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    profile = {
      sub: `sub_${uniqueId()}`,
      email: user.email.toUpperCase(),
      email_verified: true,
      name: 'G User',
      picture: 'https://img.test/a.png',
    }
    const flow = await start()
    const res = await callback('google', flow)
    expect(res.status).toBe(302)
    expect(location(res).pathname).toBe('/')
    const token = cookieValue(res, SESSION_COOKIE_NAME) as string
    expect(token).toBeTruthy()
    // the flow cookie is cleared
    expect(
      res.headers
        .getSetCookie()
        .some(
          c => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=;`) || /oauth_state=.*Max-Age=0/.test(c)
        )
    ).toBe(true)
    const session = await json<{ user: { id: string }; tenant: { id: string } }>(
      await request('/auth/session', { headers: sessionCookieHeader(token) })
    )
    expect(session.user.id).toBe(user.id)
    expect(session.tenant.id).toBe(tenant.id)
    const [link] = await db
      .select()
      .from(oauthProviders)
      .where(eq(oauthProviders.providerUserId, profile.sub))
    expect(link?.userId).toBe(user.id)
    expect(link?.accessTokenEnc).not.toContain('access-good-code')
    expect(
      await decrypt(link?.accessTokenEnc as string, process.env.OAUTH_ENCRYPTION_KEY as string)
    ).toBe('access-good-code')
    expect(link?.refreshTokenEnc).toBeTruthy()
  })

  it('a second login with the same provider subject resolves the same user (no email lookup)', async () => {
    const user = await createTestUser(db)
    profile = { sub: `sub_${uniqueId()}`, email: user.email, email_verified: true }
    await callback('google', await start())
    // Change the asserted email: the link by subject must still win.
    profile = { ...profile, email: `changed_${uniqueId().toLowerCase()}@example.test` }
    const res = await callback('google', await start())
    const token = cookieValue(res, SESSION_COOKIE_NAME) as string
    const session = await json<{ user: { id: string } }>(
      await request('/auth/session', { headers: sessionCookieHeader(token) })
    )
    expect(session.user.id).toBe(user.id)
    expect(await db.select().from(users).where(eq(users.email, profile.email))).toHaveLength(0)
  })

  it('state mismatch → /login?error=oauth_state_mismatch', async () => {
    profile = { sub: 'x', email: 'x@example.test', email_verified: true }
    const flow = await start()
    const res = await callback('google', flow, { state: 'forged' })
    expect(location(res).searchParams.get('error')).toBe('oauth_state_mismatch')
  })

  it('callback for a different provider than the cookie → oauth_state_mismatch', async () => {
    profile = { sub: 'x', email: 'x@example.test', email_verified: true }
    const flow = await start('google')
    const res = await callback('microsoft', flow)
    expect(location(res).searchParams.get('error')).toBe('oauth_state_mismatch')
  })

  it('missing cookie → oauth_state_mismatch; provider error → oauth_failed; bad code → oauth_failed', async () => {
    profile = { sub: 'x', email: 'x@example.test', email_verified: true }
    const flow = await start()
    expect(location(await callback('google', flow, { cookie: '' })).searchParams.get('error')).toBe(
      'oauth_state_mismatch'
    )
    const err = await request(`/auth/google/callback?error=access_denied&state=${flow.state}`, {
      headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=${flow.flowCookie}` },
    })
    expect(location(err).searchParams.get('error')).toBe('oauth_failed')
    const flow2 = await start()
    expect(
      location(await callback('google', flow2, { code: 'bad-code' })).searchParams.get('error')
    ).toBe('oauth_failed')
  })

  it('email_verified === false is refused', async () => {
    const user = await createTestUser(db)
    profile = { sub: `sub_${uniqueId()}`, email: user.email, email_verified: false }
    const res = await callback('google', await start())
    expect(location(res).searchParams.get('error')).toBe('email_unverified')
    expect(
      await db.select().from(oauthProviders).where(eq(oauthProviders.providerUserId, profile.sub))
    ).toHaveLength(0)
  })

  it('new user under invite_only → not_invited; under open → created with a workspace', async () => {
    profile = {
      sub: `sub_${uniqueId()}`,
      email: `oauth_new_${uniqueId().toLowerCase()}@example.test`,
      email_verified: true,
      name: 'New Person',
    }
    const denied = await callback('google', await start())
    expect(location(denied).searchParams.get('error')).toBe('not_invited')

    const env = createTestEnv({ SIGNUP_MODE: 'open' })
    const res = await callback('google', await start('google', env))
    expect(location(res).pathname).toBe('/')
    const token = cookieValue(res, SESSION_COOKIE_NAME) as string
    const session = await json<{ user: { name: string; email: string }; tenant: { role: string } }>(
      await request('/auth/session', { headers: sessionCookieHeader(token) }, { env })
    )
    expect(session.user).toMatchObject({ name: 'New Person', email: profile.email })
    expect(session.tenant.role).toBe('owner')
  })

  it('microsoft: profile from Graph, no verified flag → admitted', async () => {
    const user = await createTestUser(db)
    profile = { sub: `ms_${uniqueId()}`, email: user.email, name: 'MS User' }
    const res = await callback('microsoft', await start('microsoft'))
    expect(location(res).pathname).toBe('/')
    const [link] = await db
      .select()
      .from(oauthProviders)
      .where(eq(oauthProviders.providerUserId, profile.sub))
    expect(link).toMatchObject({ provider: 'microsoft', userId: user.id })
  })

  it('link mode attaches the provider to the signed-in user; GET/DELETE /auth/providers manage it', async () => {
    const user = await createTestUser(db)
    const other = await createTestUser(db)
    const { createTestSession } = await import('../helpers/auth')
    const token = await createTestSession(db, user.id)
    profile = { sub: `link_${uniqueId()}`, email: other.email, email_verified: true }
    const startRes = await request('/auth/google?link=1&redirectTo=/settings/profile', {
      headers: sessionCookieHeader(token),
    })
    expect(startRes.status).toBe(302)
    const flowCookie = cookieValue(startRes, OAUTH_STATE_COOKIE_NAME) as string
    const state = location(startRes).searchParams.get('state') as string
    const res = await request(`/auth/google/callback?code=good-code&state=${state}`, {
      headers: {
        Cookie: `${OAUTH_STATE_COOKIE_NAME}=${flowCookie}; ${SESSION_COOKIE_NAME}=${token}`,
      },
    })
    expect(location(res).pathname).toBe('/settings/profile')
    const list = await json<{ providers: Array<{ provider: string }> }>(
      await request('/auth/providers', { headers: sessionCookieHeader(token) })
    )
    expect(list.providers.map(p => p.provider)).toEqual(['google'])
    // the same subject cannot now be linked to `other`
    const otherToken = await createTestSession(db, other.id)
    const s2 = await request('/auth/google?link=1', { headers: sessionCookieHeader(otherToken) })
    const res2 = await request(
      `/auth/google/callback?code=good-code&state=${location(s2).searchParams.get('state')}`,
      {
        headers: {
          Cookie: `${OAUTH_STATE_COOKIE_NAME}=${cookieValue(s2, OAUTH_STATE_COOKIE_NAME)}; ${SESSION_COOKIE_NAME}=${otherToken}`,
        },
      }
    )
    expect(location(res2).searchParams.get('error')).toBe('provider_linked_elsewhere')
    const del = await request('/auth/providers/google', {
      method: 'DELETE',
      headers: sessionCookieHeader(token),
    })
    expect(del.status).toBe(204)
    expect(
      (
        await request('/auth/providers/google', {
          method: 'DELETE',
          headers: sessionCookieHeader(token),
        })
      ).status
    ).toBe(404)
    expect((await request('/auth/providers')).status).toBe(401)
  })
})

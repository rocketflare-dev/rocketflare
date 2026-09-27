// @vitest-isolate
// Spies on the global fetch (a fake OIDC issuer) and moves the clock, so it needs its own registry.
/**
 * Generic OIDC provider: discovery → code + PKCE + nonce → token exchange → `id_token` verified
 * against the issuer's JWKS. A fetch stub plays the issuer (discovery, token, JWKS, userinfo) and
 * signs real id_tokens with a jose key pair, so every check `jwtVerify` makes is exercised for real.
 */
import { logoutResponseSchema } from '@rocketflare/shared/auth'
import { eq } from 'drizzle-orm'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { resetOidcCaches } from '@/api/auth/providers/oidc'
import { oauthProviders, userSessions, users } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

const ISSUER = 'https://idp.test/realms/acme'
const CLIENT_ID = 'rocketflare-test'

function oidcEnv(overrides: Record<string, unknown> = {}) {
  return createTestEnv({
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: 'test-oidc-client-secret',
    ...overrides,
  })
}

// ---- The fake issuer ------------------------------------------------------------------------

interface SigningKey {
  kid: string
  privateKey: CryptoKey
  jwk: Record<string, unknown>
}

async function newKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const kid = `kid-${uniqueId()}`
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
  }
}

interface Issuer {
  discovery: Record<string, unknown>
  /** What the JWKS endpoint publishes. */
  published: SigningKey[]
  /** What the token endpoint signs with. */
  signer: SigningKey
  /** code → the nonce the start step sent (so the default id_token carries the right one). */
  nonces: Map<string, string>
  usedCodes: Set<string>
  /** Claims merged over the defaults for the next id_token(s). */
  claims: Record<string, unknown>
  /** Remove these claims from the id_token entirely. */
  omit: string[]
  userinfo: Record<string, unknown> | null
  jwksFetches: number
  discoveryFetches: number
  tokenRequests: Array<{ body: URLSearchParams; authorization: string | null }>
}

let idp: Issuer
const realFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function signIdToken(nonce: string | undefined): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: JWTPayload = {
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: now,
    exp: now + 300,
    nonce,
    ...idp.claims,
  }
  for (const key of idp.omit) delete claims[key]
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: idp.signer.kid })
    .sign(idp.signer.privateKey)
}

beforeEach(async () => {
  resetOidcCaches()
  const key = await newKey()
  idp = {
    discovery: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
      token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
      jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
      userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`,
      end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
    },
    published: [key],
    signer: key,
    nonces: new Map(),
    usedCodes: new Set(),
    claims: {},
    omit: [],
    userinfo: null,
    jwksFetches: 0,
    discoveryFetches: 0,
    tokenRequests: [],
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    const url = req.url
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      idp.discoveryFetches++
      return jsonResponse(idp.discovery)
    }
    if (url === idp.discovery.jwks_uri) {
      idp.jwksFetches++
      return jsonResponse({ keys: idp.published.map(k => k.jwk) })
    }
    if (url === idp.discovery.token_endpoint) {
      const body = new URLSearchParams(await req.text())
      idp.tokenRequests.push({ body, authorization: req.headers.get('authorization') })
      const code = body.get('code') ?? ''
      // A real issuer redeems a code ONCE — the replay defence the router relies on.
      if (idp.usedCodes.has(code)) return jsonResponse({ error: 'invalid_grant' }, 400)
      idp.usedCodes.add(code)
      return jsonResponse({
        access_token: `access-${code}`,
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: await signIdToken(idp.nonces.get(code)),
      })
    }
    if (url === idp.discovery.userinfo_endpoint) {
      return idp.userinfo ? jsonResponse(idp.userinfo) : jsonResponse({ error: 'no' }, 401)
    }
    return realFetch(input, init)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---- Driving the flow -----------------------------------------------------------------------

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

type Env = ReturnType<typeof createTestEnv>

async function start(env: Env, query = '', headers: Record<string, string> = {}) {
  const res = await request(`/auth/oidc${query}`, { headers }, { env })
  expect(res.status).toBe(302)
  const target = location(res)
  const flowCookie = cookieValue(res, OAUTH_STATE_COOKIE_NAME) as string
  return {
    res,
    target,
    flowCookie,
    state: target.searchParams.get('state') as string,
    nonce: target.searchParams.get('nonce') as string,
  }
}

async function callback(
  env: Env,
  flow: { flowCookie: string; state: string; nonce: string },
  code = `code-${uniqueId()}`
) {
  idp.nonces.set(code, flow.nonce)
  const params = new URLSearchParams({ code, state: flow.state })
  return request(
    `/auth/oidc/callback?${params}`,
    { headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=${flow.flowCookie}` } },
    { env }
  )
}

async function signIn(env: Env, query = '') {
  return callback(env, await start(env, query))
}

async function sessionUserId(res: Response, env: Env): Promise<string> {
  const token = cookieValue(res, SESSION_COOKIE_NAME) as string
  expect(token).toBeTruthy()
  const session = await json<{ user: { id: string } }>(
    await request('/auth/session', { headers: sessionCookieHeader(token) }, { env })
  )
  return session.user.id
}

function linkFor(sub: string) {
  return db
    .select()
    .from(oauthProviders)
    .where(eq(oauthProviders.providerUserId, `${ISSUER}|${sub}`))
}

// ---- Tests ----------------------------------------------------------------------------------

describe('GET /auth/oidc', () => {
  it('404 when no issuer is configured — the provider does not exist', async () => {
    const res = await request('/auth/oidc')
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ statusCode: 404, code: 'not_found' })
    expect(idp.discoveryFetches).toBe(0)
  })

  it('redirects to the discovered authorization endpoint with PKCE S256, a nonce and the scopes', async () => {
    const env = oidcEnv({ OIDC_SCOPES: 'email profile groups' })
    const { target, flowCookie, nonce } = await start(env)
    expect(`${target.origin}${target.pathname}`).toBe(idp.discovery.authorization_endpoint)
    expect(target.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(target.searchParams.get('redirect_uri')).toBe('http://localhost:3001/auth/oidc/callback')
    expect(target.searchParams.get('code_challenge_method')).toBe('S256')
    expect(target.searchParams.get('code_challenge')).toBeTruthy()
    // `openid` is always sent, whether OIDC_SCOPES lists it or not.
    expect(target.searchParams.get('scope')).toBe('openid email profile groups')
    expect(nonce).toBeTruthy()
    expect(flowCookie).toBeTruthy()
  })

  it('caches discovery per isolate', async () => {
    const env = oidcEnv()
    await start(env)
    await start(env)
    expect(idp.discoveryFetches).toBe(1)
  })

  it('a discovery document whose issuer differs from OIDC_ISSUER is refused (mix-up defence)', async () => {
    idp.discovery.issuer = 'https://evil.test'
    const res = await request('/auth/oidc', {}, { env: oidcEnv() })
    expect(location(res).pathname).toBe('/login')
    expect(location(res).searchParams.get('error')).toBe('oauth_failed')
  })
})

describe('GET /auth/oidc/callback', () => {
  it('links an existing user by verified email; the identity key is issuer|sub', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const sub = `sub_${uniqueId()}`
    idp.claims = { sub, email: user.email.toUpperCase(), email_verified: true, name: 'Oidc User' }
    const env = oidcEnv()
    const res = await signIn(env)
    expect(res.status).toBe(302)
    expect(location(res).pathname).toBe('/')
    expect(await sessionUserId(res, env)).toBe(user.id)
    const [link] = await linkFor(sub)
    expect(link).toMatchObject({ provider: 'oidc', userId: user.id })
    expect(link?.scopes).toEqual(['openid', 'email', 'profile'])
    // The client secret went as HTTP Basic, and the PKCE verifier with it.
    const tokenRequest = idp.tokenRequests.at(-1)
    expect(tokenRequest?.authorization).toMatch(/^Basic /)
    expect(tokenRequest?.body.get('code_verifier')).toBeTruthy()
    expect(tenant.id).toBeTruthy()
  })

  it('a second sign-in resolves the same user through the link, whatever the email says', async () => {
    const user = await createTestUser(db)
    const sub = `sub_${uniqueId()}`
    idp.claims = { sub, email: user.email, email_verified: true }
    const env = oidcEnv()
    await signIn(env)
    idp.claims = { ...idp.claims, email: `changed_${uniqueId().toLowerCase()}@example.test` }
    const res = await signIn(env)
    expect(await sessionUserId(res, env)).toBe(user.id)
  })

  it('a new user goes through the sign-up rules: invite_only refuses, open creates', async () => {
    const email = `oidc_new_${uniqueId().toLowerCase()}@example.test`
    idp.claims = { sub: `sub_${uniqueId()}`, email, email_verified: true, name: 'New Person' }
    const denied = await signIn(oidcEnv())
    expect(location(denied).searchParams.get('error')).toBe('not_invited')

    const env = oidcEnv({ SIGNUP_MODE: 'open' })
    const res = await signIn(env)
    expect(location(res).pathname).toBe('/')
    const [created] = await db.select().from(users).where(eq(users.email, email))
    expect(created?.name).toBe('New Person')
    expect(await sessionUserId(res, env)).toBe(created?.id)
  })

  it('honours ?returnUrl= (what the login page sends) and still accepts ?redirectTo=', async () => {
    const user = await createTestUser(db)
    idp.claims = { sub: `sub_${uniqueId()}`, email: user.email, email_verified: true }
    const env = oidcEnv()
    const viaReturnUrl = await signIn(env, `?returnUrl=${encodeURIComponent('/documents?x=1')}`)
    expect(`${location(viaReturnUrl).pathname}${location(viaReturnUrl).search}`).toBe(
      '/documents?x=1'
    )
    const viaRedirectTo = await signIn(env, '?redirectTo=/settings')
    expect(location(viaRedirectTo).pathname).toBe('/settings')
    // Absolute URLs are still refused (open-redirect guard).
    const evil = await signIn(env, `?returnUrl=${encodeURIComponent('https://evil.test/')}`)
    expect(location(evil).host).toBe('localhost:3001')
    expect(location(evil).pathname).toBe('/')
  })

  it('a replayed code is rejected: the second callback signs nobody in', async () => {
    const user = await createTestUser(db)
    idp.claims = { sub: `sub_${uniqueId()}`, email: user.email, email_verified: true }
    const env = oidcEnv()
    const flow = await start(env)
    const code = `code-${uniqueId()}`
    const first = await callback(env, flow, code)
    expect(cookieValue(first, SESSION_COOKIE_NAME)).toBeTruthy()
    const before = await db.select().from(userSessions).where(eq(userSessions.userId, user.id))
    const replay = await callback(env, flow, code)
    expect(location(replay).searchParams.get('error')).toBe('oauth_failed')
    expect(cookieValue(replay, SESSION_COOKIE_NAME) ?? '').toBe('')
    const after = await db.select().from(userSessions).where(eq(userSessions.userId, user.id))
    expect(after).toHaveLength(before.length)
  })

  it('a forged state is rejected before any token request', async () => {
    const env = oidcEnv()
    const flow = await start(env)
    const res = await callback(env, { ...flow, state: 'forged' })
    expect(location(res).searchParams.get('error')).toBe('oauth_state_mismatch')
    expect(idp.tokenRequests).toHaveLength(0)
  })

  it.each([
    ['a nonce from another flow', { nonce: 'not-the-flow-nonce' }],
    ['the wrong audience', { aud: 'some-other-client' }],
    ['the wrong issuer', { iss: 'https://evil.test' }],
    [
      'an expired token',
      {
        iat: Math.floor(Date.now() / 1000) - 3600,
        exp: Math.floor(Date.now() / 1000) - 1800,
      },
    ],
    ['several audiences without azp = us', { aud: [CLIENT_ID, 'other'], azp: 'other' }],
  ])('rejects an id_token with %s', async (_label, claims) => {
    const user = await createTestUser(db)
    const sub = `sub_${uniqueId()}`
    idp.claims = { sub, email: user.email, email_verified: true, ...claims }
    const res = await signIn(oidcEnv())
    expect(location(res).searchParams.get('error')).toBe('oauth_failed')
    expect(cookieValue(res, SESSION_COOKIE_NAME) ?? '').toBe('')
    expect(await linkFor(sub)).toHaveLength(0)
  })

  it('rejects an id_token signed by a key the issuer does not publish', async () => {
    const user = await createTestUser(db)
    idp.signer = await newKey()
    idp.claims = { sub: `sub_${uniqueId()}`, email: user.email, email_verified: true }
    const res = await signIn(oidcEnv())
    expect(location(res).searchParams.get('error')).toBe('oauth_failed')
  })

  it('key rotation: a new kid refetches the JWKS (after the cooldown) and succeeds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const user = await createTestUser(db)
    idp.claims = { sub: `sub_${uniqueId()}`, email: user.email, email_verified: true }
    const env = oidcEnv()
    expect(cookieValue(await signIn(env), SESSION_COOKIE_NAME)).toBeTruthy()
    expect(idp.jwksFetches).toBe(1)
    // The cached set serves the next sign-in with no fetch.
    await signIn(env)
    expect(idp.jwksFetches).toBe(1)

    const next = await newKey()
    idp.published = [idp.signer, next]
    idp.signer = next
    vi.setSystemTime(Date.now() + 31_000)
    const res = await signIn(env)
    expect(location(res).pathname).toBe('/')
    expect(await sessionUserId(res, env)).toBe(user.id)
    expect(idp.jwksFetches).toBe(2)
  })

  it('a MISSING email_verified is refused by default: no email linking, no admission', async () => {
    const user = await createTestUser(db)
    const sub = `sub_${uniqueId()}`
    idp.claims = { sub, email: user.email }
    const res = await signIn(oidcEnv({ SIGNUP_MODE: 'open' }))
    expect(location(res).searchParams.get('error')).toBe('email_unverified')
    expect(cookieValue(res, SESSION_COOKIE_NAME) ?? '').toBe('')
    expect(await linkFor(sub)).toHaveLength(0)
    // Nor through userinfo: a flag it omits is just as missing.
    const sub2 = `sub_${uniqueId()}`
    idp.claims = { sub: sub2 }
    idp.userinfo = { sub: sub2, email: user.email }
    const viaUserinfo = await signIn(oidcEnv())
    expect(location(viaUserinfo).searchParams.get('error')).toBe('email_unverified')
  })

  it('OIDC_TRUST_EMAIL=true accepts a missing email_verified (single-tenant Entra)', async () => {
    const user = await createTestUser(db)
    const sub = `sub_${uniqueId()}`
    idp.claims = { sub, email: user.email }
    const env = oidcEnv({ OIDC_TRUST_EMAIL: 'true' })
    const res = await signIn(env)
    expect(await sessionUserId(res, env)).toBe(user.id)
    const [link] = await linkFor(sub)
    expect(link?.userId).toBe(user.id)
  })

  it.each([
    [false, 'false'],
    ['false', 'false'],
    [false, 'true'],
    ['false', 'true'],
  ])('email_verified = %j is refused (OIDC_TRUST_EMAIL=%s)', async (verified, trust) => {
    const user = await createTestUser(db)
    const sub = `sub_${uniqueId()}`
    idp.claims = { sub, email: user.email, email_verified: verified }
    const res = await signIn(oidcEnv({ OIDC_TRUST_EMAIL: trust }))
    expect(location(res).searchParams.get('error')).toBe('email_unverified')
    expect(await linkFor(sub)).toHaveLength(0)
  })

  it('no email in the id_token → topped up from userinfo, whose sub must match', async () => {
    const user = await createTestUser(db)
    const sub = `sub_${uniqueId()}`
    idp.claims = { sub }
    idp.userinfo = { sub, email: user.email, email_verified: true }
    const env = oidcEnv()
    const res = await signIn(env)
    expect(await sessionUserId(res, env)).toBe(user.id)

    idp.claims = { sub: `sub_${uniqueId()}` }
    idp.userinfo = { sub: 'someone-else', email: user.email, email_verified: true }
    const mismatch = await signIn(env)
    expect(location(mismatch).searchParams.get('error')).toBe('oauth_failed')
  })

  it('a public client (no secret) sends client_id in the body and no Authorization header', async () => {
    const user = await createTestUser(db)
    idp.claims = { sub: `sub_${uniqueId()}`, email: user.email, email_verified: true }
    const env = oidcEnv({ OIDC_CLIENT_SECRET: '' })
    const res = await signIn(env)
    expect(await sessionUserId(res, env)).toBe(user.id)
    const tokenRequest = idp.tokenRequests.at(-1)
    expect(tokenRequest?.authorization).toBeNull()
    expect(tokenRequest?.body.get('client_id')).toBe(CLIENT_ID)
  })

  it('link mode attaches the issuer identity to the signed-in user', async () => {
    const user = await createTestUser(db)
    const token = await createTestSession(db, user.id)
    const sub = `sub_${uniqueId()}`
    idp.claims = {
      sub,
      email: `other_${uniqueId().toLowerCase()}@example.test`,
      email_verified: true,
    }
    const env = oidcEnv()
    const flow = await start(env, '?link=1&returnUrl=/profile', sessionCookieHeader(token))
    idp.nonces.set('link-code', flow.nonce)
    const res = await request(
      `/auth/oidc/callback?code=link-code&state=${flow.state}`,
      {
        headers: {
          Cookie: `${OAUTH_STATE_COOKIE_NAME}=${flow.flowCookie}; ${SESSION_COOKIE_NAME}=${token}`,
        },
      },
      { env }
    )
    expect(location(res).pathname).toBe('/profile')
    const [link] = await linkFor(sub)
    expect(link?.userId).toBe(user.id)
  })
})

describe('AUTH_OIDC_ONLY', () => {
  it('refuses to start or finish Google / Microsoft, and offers only oidc', async () => {
    const env = oidcEnv({ AUTH_OIDC_ONLY: 'true' })
    for (const path of [
      '/auth/google',
      '/auth/microsoft',
      '/auth/google/callback?code=x&state=y',
    ]) {
      const res = await request(path, {}, { env })
      expect(res.status).toBe(302)
      expect(location(res).pathname).toBe('/login')
      expect(location(res).searchParams.get('error')).toBe('oidc_only')
    }
    expect((await request('/auth/oidc', {}, { env })).status).toBe(302)
    expect(await json(await request('/auth/methods', {}, { env }))).toEqual({
      magicLink: true,
      providers: ['oidc'],
      devLogin: true,
      oidc: { label: 'Single sign-on' },
      oidcOnly: true,
    })
  })

  it('without an issuer is a configuration error', async () => {
    const res = await request(
      '/auth/methods',
      {},
      { env: createTestEnv({ AUTH_OIDC_ONLY: 'true' }) }
    )
    expect(res.status).toBe(500)
    expect(await json(res)).toMatchObject({ statusCode: 500 })
  })
})

describe('GET /auth/methods with an issuer', () => {
  it('adds oidc to the providers with its configured label; oidcOnly false', async () => {
    const env = oidcEnv({ OIDC_LABEL: 'Acme SSO', APP_ENV: 'staging' })
    expect(await json(await request('/auth/methods', {}, { env }))).toEqual({
      magicLink: true,
      providers: ['google', 'microsoft', 'oidc'],
      devLogin: false,
      oidc: { label: 'Acme SSO' },
      oidcOnly: false,
    })
  })
})

describe('POST /auth/logout with an issuer', () => {
  it('200 { endSessionUrl } when discovery advertises end_session_endpoint; the session is gone', async () => {
    const user = await createTestUser(db)
    const token = await createTestSession(db, user.id)
    const env = oidcEnv()
    const res = await request(
      '/auth/logout',
      { method: 'POST', headers: sessionCookieHeader(token) },
      { env }
    )
    expect(res.status).toBe(200)
    const { endSessionUrl } = logoutResponseSchema.parse(await res.json())
    const url = new URL(endSessionUrl)
    expect(`${url.origin}${url.pathname}`).toBe(idp.discovery.end_session_endpoint)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
      'http://localhost:3001/login?signedOut=1'
    )
    expect(url.searchParams.has('id_token_hint')).toBe(false)
    expect(
      (await request('/auth/session', { headers: sessionCookieHeader(token) }, { env })).status
    ).toBe(401)
  })

  it('204 when the issuer has no end_session_endpoint, or discovery fails', async () => {
    delete idp.discovery.end_session_endpoint
    expect((await request('/auth/logout', { method: 'POST' }, { env: oidcEnv() })).status).toBe(204)
    resetOidcCaches()
    idp.discovery.issuer = 'https://evil.test'
    expect((await request('/auth/logout', { method: 'POST' }, { env: oidcEnv() })).status).toBe(204)
  })
})

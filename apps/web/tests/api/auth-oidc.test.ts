// @vitest-isolate
// Spies on the global fetch (a fake OIDC issuer) and moves the clock, so it needs its own registry.
/**
 * Generic OIDC provider: discovery → code + PKCE + nonce → token exchange → `id_token` verified
 * against the issuer's JWKS. A fetch stub plays the issuer (discovery, token, JWKS, userinfo) and
 * signs real id_tokens with a jose key pair, so every check `jwtVerify` makes is exercised for real.
 */
import { logoutResponseSchema } from '@rocketflare/shared/auth'
import { and, eq } from 'drizzle-orm'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { resetOidcCaches } from '@/api/auth/providers/oidc'
import { setTenantExternalOrg } from '@/api/services/admin'
import {
  accessRequests,
  oauthProviders,
  tenants,
  tenantUsers,
  userSessions,
  users,
} from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

/**
 * A fixture SSO policy (`ServerPlugin.ssoPolicy`): plugin `acme` claims `@acme-sso.test` and
 * routes it to its `sso` method. Every other address is unclaimed, so the rest of the file runs
 * exactly as without it.
 */
vi.mock('@/api/routes/auth/sso', async () => {
  const { evaluateSsoPolicyForAll } = await import('@/api/auth/sso-policy')
  const fixtures = [
    {
      shared: { id: 'acme' },
      loginMethods: () => [{ id: 'sso', label: 'Acme SSO', startPath: '/api/hooks/acme/sso' }],
      ssoPolicy: async (_db: unknown, email: string) =>
        email.endsWith('@acme-sso.test') ? { required: true as const, methodId: 'sso' } : null,
    },
  ]
  return {
    // biome-ignore lint/suspicious/noExplicitAny: the mock forwards the real signature untouched
    ssoDecisionFor: (db: any, cfg: any, emails: any, logger: any) =>
      // biome-ignore lint/suspicious/noExplicitAny: fixtures are structurally ServerPlugins
      evaluateSsoPolicyForAll(fixtures as any, db, cfg, emails, logger),
  }
})

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
  /** When set, the token endpoint answers with this instead of tokens (an issuer refusing). */
  tokenFailure: { status: number; body: unknown } | null
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
    tokenFailure: null,
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
      if (idp.tokenFailure) return jsonResponse(idp.tokenFailure.body, idp.tokenFailure.status)
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
  it('SSO required: a claimed domain is refused before anyone is admitted, linked or signed in', async () => {
    const email = `sso_${uniqueId().toLowerCase()}@acme-sso.test`
    const sub = `sub_${uniqueId()}`
    idp.claims = { sub, email, email_verified: true }
    const env = oidcEnv({ SIGNUP_MODE: 'open' })
    const res = await signIn(env, `?returnUrl=${encodeURIComponent('/documents')}`)
    expect(res.status).toBe(302)
    expect(location(res).pathname).toBe('/login')
    expect(location(res).searchParams.get('error')).toBe('sso_required')
    expect(location(res).searchParams.get('method')).toBe('acme:sso')
    expect(location(res).searchParams.get('returnUrl')).toBe('/documents')
    expect(cookieValue(res, SESSION_COOKIE_NAME)).toBeFalsy()
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0)
    expect(await linkFor(sub)).toHaveLength(0)
  })

  it('SSO required: a LINKED account on a claimed domain is refused whatever the issuer asserts', async () => {
    const user = await createTestUser(db, {
      email: `linked_${uniqueId().toLowerCase()}@acme-sso.test`,
    })
    const sub = `sub_${uniqueId()}`
    await db.insert(oauthProviders).values({
      userId: user.id,
      provider: 'oidc',
      providerUserId: `${ISSUER}|${sub}`,
      email: 'personal@example.test',
    })
    idp.claims = { sub, email: 'personal@example.test', email_verified: true }
    const res = await signIn(oidcEnv())
    expect(location(res).searchParams.get('error')).toBe('sso_required')
    expect(cookieValue(res, SESSION_COOKIE_NAME)).toBeFalsy()
  })

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
    // A plugin's methods (the example plugin's, in development) are not the kit's to pin here.
    const { pluginMethods: _plugins, ...methods } = await json<Record<string, unknown>>(
      await request('/auth/methods', {}, { env })
    )
    expect(methods).toEqual({
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
    const { pluginMethods: _plugins, ...body } = await json<Record<string, unknown>>(
      await request('/auth/methods', {}, { env })
    )
    expect(body).toEqual({
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
    // Amazon Cognito's /logout returns to the app only with `logout_uri`.
    expect(url.searchParams.get('logout_uri')).toBe('http://localhost:3001/login?signedOut=1')
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

// ---- IdP-managed tenancy (OIDC_MANAGED_TENANCY) ---------------------------------------------

describe('OIDC_MANAGED_TENANCY', () => {
  type Org = { id: string; slug: string; name: string; role: string }

  /** An issuer with its own role names, an admit claim and a global-admin claim. */
  function managedEnv(overrides: Record<string, unknown> = {}) {
    return oidcEnv({
      OIDC_MANAGED_TENANCY: 'true',
      OIDC_ROLE_MAP: 'org_admin:admin,org_member:member,org_staff:admin',
      OIDC_ADMIT_CLAIM: 'staff',
      OIDC_GLOBAL_ADMIN_CLAIM: 'platform_admin',
      ...overrides,
    })
  }

  function newOrg(role = 'org_member'): Org {
    const id = uniqueId()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
    return { id: `org-${id}`, slug: `acme-${id}`, name: `Acme ${id}`, role }
  }

  /** The next id_token is the managing issuer's for `email`. */
  function managedToken(
    email: string,
    orgs: Org[],
    extra: Record<string, unknown> = {},
    sub = `sub_${email}`
  ) {
    idp.claims = {
      sub,
      email,
      email_verified: true,
      name: 'Managed Person',
      staff: false,
      platform_admin: false,
      orgs,
      ...extra,
    }
  }

  function newEmail() {
    return `idp_${uniqueId().toLowerCase()}@example.test`
  }

  async function tenantFor(org: Org) {
    const [row] = await db.select().from(tenants).where(eq(tenants.externalOrgId, org.id))
    return row
  }

  async function membership(tenantId: string, userId: string) {
    const [row] = await db
      .select()
      .from(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)))
    return row
  }

  async function sessionOf(res: Response, env: Env) {
    const token = cookieValue(res, SESSION_COOKIE_NAME) as string
    expect(token).toBeTruthy()
    return sessionFor(token, env)
  }

  async function sessionFor(token: string, env: Env) {
    return json<{
      user: { id: string; isGlobalAdmin: boolean }
      tenant: { id: string; role: string } | null
      tenants: Array<{ id: string; role: string }>
      accessRequest: { status: string } | null
    }>(await request('/auth/session', { headers: sessionCookieHeader(token) }, { env }))
  }

  it('first sign-in creates the tenant (no owner) and an idp membership, whatever SIGNUP_MODE says', async () => {
    for (const mode of ['invite_only', 'approval'] as const) {
      const email = newEmail()
      const org = newOrg('org_admin')
      managedToken(email, [org])
      const env = managedEnv({ SIGNUP_MODE: mode })
      const res = await signIn(env)
      expect(location(res).pathname).toBe('/')

      const tenant = await tenantFor(org)
      expect(tenant).toMatchObject({ name: org.name, slug: org.slug })
      const session = await sessionOf(res, env)
      expect(session.tenant?.id).toBe(tenant?.id)
      expect(session.tenant?.role).toBe('admin')
      expect(session.accessRequest).toBeNull()
      expect(await membership(tenant?.id as string, session.user.id)).toMatchObject({
        role: 'admin',
        source: 'idp',
      })
      // Managed tenancy never writes `owner`: a new tenant is ownerless.
      const owners = await db
        .select()
        .from(tenantUsers)
        .where(and(eq(tenantUsers.tenantId, tenant?.id as string), eq(tenantUsers.role, 'owner')))
      expect(owners).toHaveLength(0)
      // Nobody is left "waiting for an administrator".
      const requests = await db.select().from(accessRequests).where(eq(accessRequests.email, email))
      expect(requests).toHaveLength(0)
    }
  })

  it('maps issuer roles through OIDC_ROLE_MAP, and skips an org whose role is not in it', async () => {
    const email = newEmail()
    const member = newOrg('org_member')
    const staffed = newOrg('org_staff')
    const unmapped = newOrg('overlord')
    managedToken(email, [member, staffed, unmapped], { staff: true })
    const env = managedEnv()
    const session = await sessionOf(await signIn(env), env)
    const roles = Object.fromEntries(session.tenants.map(t => [t.id, t.role]))
    expect(roles[(await tenantFor(member))?.id as string]).toBe('member')
    expect(roles[(await tenantFor(staffed))?.id as string]).toBe('admin')
    expect(await tenantFor(unmapped)).toBeUndefined()
  })

  it('a second sign-in keeps the tenant in step: new name, new role, same tenant', async () => {
    const email = newEmail()
    const org = newOrg('org_member')
    managedToken(email, [org])
    const env = managedEnv()
    const first = await sessionOf(await signIn(env), env)
    const before = await tenantFor(org)

    managedToken(email, [{ ...org, name: 'Acme Renamed', role: 'org_admin' }])
    const second = await sessionOf(await signIn(env), env)
    expect(second.user.id).toBe(first.user.id)
    const after = await tenantFor(org)
    expect(after?.id).toBe(before?.id)
    expect(after?.name).toBe('Acme Renamed')
    expect(after?.slug).toBe(before?.slug)
    expect(await membership(after?.id as string, first.user.id)).toMatchObject({
      role: 'admin',
      source: 'idp',
    })
  })

  it('an unlinked tenant with the org slug becomes the org tenant; its owner stays', async () => {
    const org = newOrg()
    const { user: owner, tenant: made } = await createTestTenantWithUser(db, 'owner', undefined, {
      slug: org.slug,
    })
    const first = newEmail()
    managedToken(first, [org])
    const firstId = await sessionUserId(await signIn(managedEnv()), managedEnv())
    managedToken(newEmail(), [org])
    await signIn(managedEnv())
    expect((await tenantFor(org))?.id).toBe(made.id)
    expect(
      await db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, `${org.slug}-2`))
    ).toEqual([])
    expect(await membership(made.id, firstId)).toMatchObject({ role: 'member', source: 'idp' })
    expect(await membership(made.id, owner.id)).toMatchObject({ role: 'owner' })
  })

  it('a tenant with the slug that is linked to another org is never taken; the slug is made unique', async () => {
    const org = newOrg()
    const other = newOrg()
    const taken = await createTestTenant(db, { slug: org.slug, externalOrgId: other.id })
    managedToken(newEmail(), [org])
    await signIn(managedEnv())
    const tenant = await tenantFor(org)
    expect(tenant?.id).not.toBe(taken.id)
    expect(tenant?.slug).toBe(`${org.slug}-2`)
  })

  it('a tenant made by hand and linked by an admin is the one the org signs in to', async () => {
    const org = newOrg()
    const { user: owner, tenant: made } = await createTestTenantWithUser(db, 'owner')
    await setTenantExternalOrg(db, made.id, org.id, owner)
    const email = newEmail()
    managedToken(email, [org])
    const userId = await sessionUserId(await signIn(managedEnv()), managedEnv())
    expect((await tenantFor(org))?.id).toBe(made.id)
    expect(await membership(made.id, userId)).toMatchObject({ role: 'member', source: 'idp' })
    expect(await membership(made.id, owner.id)).toMatchObject({ role: 'owner' })
  })

  it('an org gone from the claims loses its idp membership; manual ones stay; the session is unpinned', async () => {
    const email = newEmail()
    const keep = newOrg()
    const drop = newOrg()
    managedToken(email, [keep, drop])
    const env = managedEnv()
    const first = await sessionOf(await signIn(env), env)
    const userId = first.user.id
    const dropped = (await tenantFor(drop))?.id as string
    const manual = await createTestTenant(db)
    await linkUserToTenant(db, userId, manual.id, 'member')
    // An older session sits in the tenant about to be removed.
    const pinned = await createTestSession(db, userId, dropped)

    managedToken(email, [keep])
    const res = await signIn(env)
    const session = await sessionOf(res, env)
    expect(await membership(dropped, userId)).toBeUndefined()
    expect(await membership((await tenantFor(keep))?.id as string, userId)).toMatchObject({
      source: 'idp',
    })
    expect(await membership(manual.id, userId)).toMatchObject({ source: 'manual', role: 'member' })
    expect(session.tenants.map(t => t.id)).not.toContain(dropped)
    const [old] = await db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), eq(userSessions.selectedTenantId, dropped)))
    expect(old).toBeUndefined()
    expect((await sessionFor(pinned, env)).tenant?.id).toBe((await tenantFor(keep))?.id)
  })

  it('an owner row and a support row are never rewritten; a manual admin/member row is adopted', async () => {
    const email = newEmail()
    const owned = newOrg('org_member')
    const adopted = newOrg('org_admin')
    const user = await createTestUser(db, { email })
    const ownedTenant = await createTestTenant(db, { externalOrgId: owned.id })
    const adoptedTenant = await createTestTenant(db, { externalOrgId: adopted.id })
    await linkUserToTenant(db, user.id, ownedTenant.id, 'owner')
    await linkUserToTenant(db, user.id, adoptedTenant.id, 'member')
    managedToken(email, [owned, adopted])
    await signIn(managedEnv())
    expect(await membership(ownedTenant.id, user.id)).toMatchObject({
      role: 'owner',
      source: 'manual',
    })
    expect(await membership(adoptedTenant.id, user.id)).toMatchObject({
      role: 'admin',
      source: 'idp',
    })
  })

  it('the global-admin claim sets the flag, and its absence clears only what the issuer set', async () => {
    const email = newEmail()
    const env = managedEnv()
    managedToken(email, [], { staff: true, platform_admin: true })
    const granted = await sessionOf(await signIn(env), env)
    expect(granted.user.isGlobalAdmin).toBe(true)
    const [row] = await db.select().from(users).where(eq(users.id, granted.user.id))
    expect(row?.globalAdminSource).toBe('idp')

    managedToken(email, [], { staff: true, platform_admin: false })
    const cleared = await sessionOf(await signIn(env), env)
    expect(cleared.user.isGlobalAdmin).toBe(false)
    const [after] = await db.select().from(users).where(eq(users.id, granted.user.id))
    expect(after?.globalAdminSource).toBeNull()

    // A global admin the app made itself is not the issuer's to take away.
    const manualAdmin = await createTestUser(db, { isGlobalAdmin: true })
    managedToken(manualAdmin.email, [], { staff: true })
    const kept = await sessionOf(await signIn(env), env)
    expect(kept.user.id).toBe(manualAdmin.id)
    expect(kept.user.isGlobalAdmin).toBe(true)
  })

  it('the admit claim with no orgs signs in to the no-tenant experience, not an access request', async () => {
    const email = newEmail()
    managedToken(email, [], { staff: true })
    const env = managedEnv({ SIGNUP_MODE: 'approval' })
    const session = await sessionOf(await signIn(env), env)
    expect(session.tenant).toBeNull()
    expect(session.tenants).toEqual([])
    expect(session.accessRequest).toBeNull()
  })

  it('a person already waiting on an access request is seated and the request closed', async () => {
    const email = newEmail()
    const env = managedEnv({ SIGNUP_MODE: 'approval' })
    // Plain OIDC + approval leaves the person waiting; the claims seat them.
    idp.claims = { sub: `sub_${email}`, email, email_verified: true }
    const waiting = await sessionOf(await signIn(oidcEnv({ SIGNUP_MODE: 'approval' })), env)
    expect(waiting.accessRequest).toEqual({ status: 'pending' })

    const org = newOrg()
    managedToken(email, [org])
    const seated = await sessionOf(await signIn(env), env)
    expect(seated.user.id).toBe(waiting.user.id)
    expect(seated.tenant?.id).toBe((await tenantFor(org))?.id)
    const [requestRow] = await db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.email, email))
    expect(requestRow?.status).toBe('approved')
  })

  it('an idp membership is 409 idp_managed to edit or remove; a manual one still works', async () => {
    const org = newOrg('org_member')
    const email = newEmail()
    managedToken(email, [org])
    const env = managedEnv()
    const member = await sessionOf(await signIn(env), env)
    const tenantId = (await tenantFor(org))?.id as string
    const owner = await createTestUser(db)
    await linkUserToTenant(db, owner.id, tenantId, 'owner')
    const manual = await createTestUser(db)
    await linkUserToTenant(db, manual.id, tenantId, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, owner.id, tenantId))

    const patch = await request(`/api/members/${member.user.id}`, {
      method: 'PATCH',
      headers: { ...cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    })
    expect(patch.status).toBe(409)
    expect(await json(patch)).toMatchObject({ statusCode: 409, code: 'idp_managed' })
    const remove = await request(`/api/members/${member.user.id}`, {
      method: 'DELETE',
      headers: cookie,
    })
    expect(remove.status).toBe(409)
    expect(await json(remove)).toMatchObject({ code: 'idp_managed' })
    expect(await membership(tenantId, member.user.id)).toMatchObject({ role: 'member' })

    const list = await json<{ items: Array<{ userId: string; source: string }> }>(
      await request('/api/members?pageSize=50', { headers: cookie })
    )
    expect(list.items.find(m => m.userId === member.user.id)?.source).toBe('idp')

    const manualPatch = await request(`/api/members/${manual.id}`, {
      method: 'PATCH',
      headers: { ...cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    })
    expect(manualPatch.status).toBe(200)
    const manualRemove = await request(`/api/members/${manual.id}`, {
      method: 'DELETE',
      headers: cookie,
    })
    expect(manualRemove.status).toBe(204)
  })

  it.each([
    [
      'an OAuth error body',
      {
        error: 'invalid_request',
        error_description: 'PreTokenGeneration failed with error UserLambdaValidationException.',
      },
    ],
    [
      'an AWS error body',
      { __type: 'UserLambdaValidationException', message: 'No grant for this app' },
    ],
  ])(
    'a 400 UserLambdaValidationException at the token exchange → no_access (%s)',
    async (_l, body) => {
      idp.tokenFailure = { status: 400, body }
      const res = await signIn(managedEnv())
      expect(location(res).pathname).toBe('/login')
      expect(location(res).searchParams.get('error')).toBe('no_access')
      expect(cookieValue(res, SESSION_COOKIE_NAME) ?? '').toBe('')
    }
  )

  it('any other failed token exchange is still oauth_failed', async () => {
    idp.tokenFailure = { status: 400, body: { error: 'invalid_grant' } }
    const res = await signIn(managedEnv())
    expect(location(res).searchParams.get('error')).toBe('oauth_failed')
  })

  it('malformed claims are ignored: nothing is created or removed, and admission is plain OIDC', async () => {
    const email = newEmail()
    const org = newOrg()
    managedToken(email, [org])
    const env = managedEnv()
    const first = await sessionOf(await signIn(env), env)
    const tenantId = (await tenantFor(org))?.id as string

    const stranger = newOrg()
    managedToken(email, [], { orgs: [{ ...stranger, id: 42 }] })
    const second = await sessionOf(await signIn(env), env)
    expect(second.user.id).toBe(first.user.id)
    expect(await tenantFor(stranger)).toBeUndefined()
    expect(await membership(tenantId, first.user.id)).toMatchObject({ source: 'idp' })

    // A new person with malformed claims meets SIGNUP_MODE like any OIDC sign-in.
    managedToken(newEmail(), [], { orgs: 'acme' })
    expect(location(await signIn(env)).searchParams.get('error')).toBe('not_invited')
  })

  it('links a person who already signed in with Google at the same verified email', async () => {
    const user = await createTestUser(db)
    await db.insert(oauthProviders).values({
      userId: user.id,
      provider: 'google',
      providerUserId: `google-${uniqueId()}`,
      email: user.email,
    })
    const org = newOrg('org_admin')
    managedToken(user.email, [org])
    const env = managedEnv()
    const session = await sessionOf(await signIn(env), env)
    expect(session.user.id).toBe(user.id)
    expect(await linkFor(`sub_${user.email}`)).toHaveLength(1)
    expect(await membership((await tenantFor(org))?.id as string, user.id)).toMatchObject({
      role: 'admin',
      source: 'idp',
    })
  })

  it('a managed session ends OIDC_SESSION_MAX_AGE_DAYS after sign-in, however active', async () => {
    managedToken(newEmail(), [newOrg()])
    const env = managedEnv()
    const res = await signIn(env)
    const userId = (await sessionOf(res, env)).user.id
    const [row] = await db.select().from(userSessions).where(eq(userSessions.userId, userId))
    const days = (d: Date | null | undefined) => ((d?.getTime() ?? 0) - Date.now()) / 86_400_000
    expect(days(row?.expiresAt)).toBeGreaterThan(6.9)
    expect(days(row?.expiresAt)).toBeLessThan(7.1)
    expect(row?.maxExpiresAt?.getTime()).toBe(row?.expiresAt.getTime())

    // Use renews `lastSeenAt` but never moves the end.
    await db
      .update(userSessions)
      .set({ lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(userSessions.id, row?.id as string))
    await sessionOf(res, env)
    const [used] = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, row?.id as string))
    expect(used?.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(used?.expiresAt.getTime()).toBe(row?.maxExpiresAt?.getTime())

    // The cookie ends with it.
    const cookie = res.headers.getSetCookie().find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`))
    const expires = new Date(/Expires=([^;]+)/i.exec(cookie ?? '')?.[1] ?? 0)
    expect(days(expires)).toBeLessThan(7.1)

    // Configurable.
    managedToken(newEmail(), [newOrg()])
    const short = managedEnv({ OIDC_SESSION_MAX_AGE_DAYS: '1' })
    const shortUser = (await sessionOf(await signIn(short), short)).user.id
    const [shortRow] = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, shortUser))
    expect(days(shortRow?.expiresAt)).toBeLessThan(1.1)
  })

  it('under managed tenancy every sign-in is capped, not only an OIDC one', async () => {
    const env = managedEnv()
    const email = newEmail()
    const res = await request('/auth/dev-login', { method: 'POST' }, { json: { email }, env })
    expect(res.status).toBe(200)
    const [row] = await db
      .select({ s: userSessions })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(eq(users.email, email))
    const days = ((row?.s.maxExpiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
  })

  it('a session without a cap still slides over 30 days', async () => {
    const email = newEmail()
    idp.claims = { sub: `sub_${email}`, email, email_verified: true }
    const env = oidcEnv({ SIGNUP_MODE: 'open' })
    const res = await signIn(env)
    const userId = await sessionUserId(res, env)
    const [row] = await db.select().from(userSessions).where(eq(userSessions.userId, userId))
    expect(row?.maxExpiresAt).toBeNull()
    await db
      .update(userSessions)
      .set({
        lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .where(eq(userSessions.id, row?.id as string))
    await sessionUserId(res, env)
    const [slid] = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, row?.id as string))
    expect(((slid?.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000).toBeGreaterThan(29.9)
  })

  it('the default config reads `orgs` with roles admin and member', async () => {
    const email = newEmail()
    const org = newOrg('admin')
    managedToken(email, [org])
    const env = oidcEnv({ OIDC_MANAGED_TENANCY: 'true' })
    const session = await sessionOf(await signIn(env), env)
    expect(session.tenant).toMatchObject({ id: (await tenantFor(org))?.id, role: 'admin' })
  })

  it('without OIDC_MANAGED_TENANCY the claims are not read at all', async () => {
    const org = newOrg('org_admin')
    managedToken(newEmail(), [org])
    const res = await signIn(oidcEnv())
    expect(location(res).searchParams.get('error')).toBe('not_invited')
    expect(await tenantFor(org)).toBeUndefined()
  })

  // ---- Identity events (POST /api/identity/events) --------------------------------------------

  const WEBHOOK_SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`

  function eventsEnv(overrides: Record<string, unknown> = {}) {
    return managedEnv({ IDENTITY_WEBHOOK_SECRET: WEBHOOK_SECRET, ...overrides })
  }

  async function sign(secret: string, id: string, timestamp: number, body: string) {
    const key = await crypto.subtle.importKey(
      'raw',
      Buffer.from(secret.slice('whsec_'.length), 'base64'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${body}`)
    )
    return `v1,${Buffer.from(mac).toString('base64')}`
  }

  let eventSeq = 0
  /** An event `minutesAgo` old (default: now), with a fresh id. */
  function event(type: string, data: Record<string, unknown>, minutesAgo = 0) {
    eventSeq++
    return {
      id: `evt_${eventSeq}_${uniqueId()}`,
      type,
      occurredAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      data,
    }
  }

  async function post(
    env: Env,
    body: { id: string } & Record<string, unknown>,
    opts: { secrets?: string[]; timestamp?: number; send?: string } = {}
  ) {
    const text = JSON.stringify(body)
    const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000)
    const signatures = await Promise.all(
      (opts.secrets ?? [WEBHOOK_SECRET]).map(s => sign(s, body.id, timestamp, text))
    )
    return request(
      '/api/identity/events',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'webhook-id': body.id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signatures.join(' '),
        },
        body: opts.send ?? text,
      },
      { env }
    )
  }

  /** A person signed in through the issuer with `orgs`; returns their ids and person ref. */
  async function signedIn(orgs: Org[], env = eventsEnv()) {
    const email = newEmail()
    managedToken(email, orgs)
    const res = await signIn(env)
    const userId = (await sessionOf(res, env)).user.id
    return { email, userId, res, person: { personId: `p-${email}`, email, sub: `sub_${email}` } }
  }

  it('identity events: 404 unless managed tenancy and a secret are configured', async () => {
    const e = event('org.suspended', { orgId: 'x' })
    expect((await post(managedEnv(), e)).status).toBe(404)
    expect((await post(oidcEnv({ IDENTITY_WEBHOOK_SECRET: WEBHOOK_SECRET }), e)).status).toBe(404)
  })

  it('identity events: refuses a missing or wrong signature and a stale timestamp', async () => {
    const env = eventsEnv()
    const e = event('org.suspended', { orgId: 'x' })
    const other = `whsec_${Buffer.alloc(32, 1).toString('base64')}`
    expect((await post(env, e, { secrets: [other] })).status).toBe(401)
    expect((await post(env, e, { secrets: [] })).status).toBe(401)
    const old = Math.floor(Date.now() / 1000) - 6 * 60
    expect((await post(env, e, { timestamp: old })).status).toBe(401)
    // The body signed is the body checked.
    const tampered = await post(env, e, { send: JSON.stringify({ ...e, data: { orgId: 'y' } }) })
    expect(tampered.status).toBe(401)
    // During a rotation either of two signatures verifies.
    expect((await post(env, e, { secrets: [other, WEBHOOK_SECRET] })).status).toBe(204)
  })

  it('identity events: an unknown type is accepted and ignored; a malformed known one is 400', async () => {
    const env = eventsEnv()
    expect((await post(env, event('person.renamed', { anything: true }))).status).toBe(204)
    expect((await post(env, event('org.renamed', { orgId: 'x' }))).status).toBe(400)
  })

  it('membership.removed takes the person out of the tenant and unpins their session', async () => {
    const org = newOrg()
    const keep = newOrg()
    const env = eventsEnv()
    const { userId, person, res } = await signedIn([org, keep], env)
    const tenantId = (await tenantFor(org))?.id as string
    const pinned = await createTestSession(db, userId, tenantId)

    expect(
      (await post(env, event('membership.removed', { ...person, orgId: org.id }))).status
    ).toBe(204)
    expect(await membership(tenantId, userId)).toBeUndefined()
    expect(await membership((await tenantFor(keep))?.id as string, userId)).toBeDefined()
    expect((await sessionFor(pinned, env)).tenant?.id).toBe((await tenantFor(keep))?.id)
    expect((await sessionOf(res, env)).tenants.map(t => t.id)).not.toContain(tenantId)
  })

  it('a token issued before an event never overwrites it, and an event newer than the token stays', async () => {
    const org = newOrg()
    const env = eventsEnv()
    const email = newEmail()
    const person = { personId: `p-${email}`, email, sub: `sub_${email}` }
    const minutesAgo = (m: number) => Math.floor(Date.now() / 1000) - m * 60
    managedToken(email, [org], { iat: minutesAgo(10) })
    const userId = (await sessionOf(await signIn(env), env)).user.id
    const tenantId = (await tenantFor(org))?.id as string

    const promoted = event(
      'membership.role_changed',
      { ...person, orgId: org.id, role: 'org_admin' },
      1
    )
    expect((await post(env, promoted)).status).toBe(204)
    const renamed = event('org.renamed', { orgId: org.id, name: 'Renamed By Event' }, 1)
    expect((await post(env, renamed)).status).toBe(204)

    // A token from before both events, still saying member and the old name.
    managedToken(email, [org], { iat: minutesAgo(2) })
    await signIn(env)
    expect(await membership(tenantId, userId)).toMatchObject({ role: 'admin', source: 'idp' })
    expect((await tenantFor(org))?.name).toBe('Renamed By Event')
    // The event still counts as newer than the row, so its retry is applied, not stale.
    expect((await post(env, promoted)).status).toBe(204)
    expect(await membership(tenantId, userId)).toMatchObject({ role: 'admin' })

    // A fresh token wins again.
    managedToken(email, [org])
    await signIn(env)
    expect(await membership(tenantId, userId)).toMatchObject({ role: 'member' })
  })

  it('membership.role_changed maps the role, changes only an existing membership, and an unmapped role removes it', async () => {
    const org = newOrg('org_member')
    const env = eventsEnv()
    const { userId, person } = await signedIn([org], env)
    const tenantId = (await tenantFor(org))?.id as string

    await post(
      env,
      event('membership.role_changed', { ...person, orgId: org.id, role: 'org_admin' })
    )
    expect(await membership(tenantId, userId)).toMatchObject({ role: 'admin', source: 'idp' })

    // A person with no membership there gains none.
    const stranger = await signedIn([newOrg()], env)
    await post(
      env,
      event('membership.role_changed', { ...stranger.person, orgId: org.id, role: 'org_admin' })
    )
    expect(await membership(tenantId, stranger.userId)).toBeUndefined()

    await post(
      env,
      event('membership.role_changed', { ...person, orgId: org.id, role: 'overlord' })
    )
    expect(await membership(tenantId, userId)).toBeUndefined()
  })

  it('events apply in any order: one older than the last sign-in or event is skipped', async () => {
    const org = newOrg('org_member')
    const env = eventsEnv()
    const { userId, person } = await signedIn([org], env)
    const tenantId = (await tenantFor(org))?.id as string

    // Older than the sign-in: the sign-in's claims are newer.
    await post(env, event('membership.removed', { ...person, orgId: org.id }, 5))
    expect(await membership(tenantId, userId)).toBeDefined()

    // A newer change, then an older one arriving late.
    const newer = event('membership.role_changed', { ...person, orgId: org.id, role: 'org_admin' })
    await post(env, newer)
    const late = event('membership.role_changed', { ...person, orgId: org.id, role: 'org_member' })
    late.occurredAt = new Date(Date.parse(newer.occurredAt) - 1000).toISOString()
    await post(env, late)
    expect(await membership(tenantId, userId)).toMatchObject({ role: 'admin' })

    // A retry of the same event changes nothing and still answers 204.
    expect((await post(env, newer)).status).toBe(204)
    expect(await membership(tenantId, userId)).toMatchObject({ role: 'admin' })

    // Renames too.
    const renamed = event('org.renamed', { orgId: org.id, name: 'Newer Name' })
    await post(env, renamed)
    const staleRename = event('org.renamed', { orgId: org.id, name: 'Older Name' })
    staleRename.occurredAt = new Date(Date.parse(renamed.occurredAt) - 1000).toISOString()
    await post(env, staleRename)
    expect((await tenantFor(org))?.name).toBe('Newer Name')
  })

  it('person.suspended ends sessions started before it and removes idp memberships, not manual ones', async () => {
    const org = newOrg()
    const env = eventsEnv()
    const { userId, person, res } = await signedIn([org], env)
    const manual = await createTestTenant(db)
    await linkUserToTenant(db, userId, manual.id, 'member')

    // Found by sub even when the email has changed.
    await post(env, event('person.suspended', { ...person, email: 'changed@example.test' }))
    const token = cookieValue(res, SESSION_COOKIE_NAME) as string
    const after = await request('/auth/session', { headers: sessionCookieHeader(token) }, { env })
    expect(after.status).toBe(401)
    expect(await membership((await tenantFor(org))?.id as string, userId)).toBeUndefined()
    expect(await membership(manual.id, userId)).toMatchObject({ source: 'manual' })
  })

  it('a person without a sub is found by email; an unknown person or org is a no-op 204', async () => {
    const org = newOrg()
    const env = eventsEnv()
    const { userId, email } = await signedIn([org], env)
    const res = await post(
      env,
      event('membership.removed', { personId: 'p', email: email.toUpperCase(), orgId: org.id })
    )
    expect(res.status).toBe(204)
    expect(await membership((await tenantFor(org))?.id as string, userId)).toBeUndefined()

    const nobody = { personId: 'p', email: 'nobody@example.test' }
    expect((await post(env, event('person.suspended', nobody))).status).toBe(204)
    expect((await post(env, event('org.suspended', { orgId: 'org-unknown' }))).status).toBe(204)
  })

  it('grant.revoked and org.suspended remove the idp memberships of an org; an owner stays', async () => {
    const org = newOrg()
    const env = eventsEnv()
    const a = await signedIn([org], env)
    const b = await signedIn([org], env)
    const tenantId = (await tenantFor(org))?.id as string
    const owner = await createTestUser(db)
    await linkUserToTenant(db, owner.id, tenantId, 'owner')

    // With a person: only that person.
    await post(env, event('grant.revoked', { orgId: org.id, person: a.person }))
    expect(await membership(tenantId, a.userId)).toBeUndefined()
    expect(await membership(tenantId, b.userId)).toBeDefined()

    // Without: everyone the issuer seated.
    await post(env, event('grant.revoked', { orgId: org.id, appId: 'ignored' }))
    expect(await membership(tenantId, b.userId)).toBeUndefined()
    expect(await membership(tenantId, owner.id)).toMatchObject({ role: 'owner' })

    // The next sign-in that the claims allow restores access.
    managedToken(b.email, [org])
    await signIn(env)
    expect(await membership(tenantId, b.userId)).toMatchObject({ source: 'idp' })

    await post(env, event('org.suspended', { orgId: org.id }))
    expect(await membership(tenantId, b.userId)).toBeUndefined()
  })
})

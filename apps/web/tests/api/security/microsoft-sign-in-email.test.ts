// @vitest-isolate
// Stubs the provider's HTTP endpoints on the global fetch, so it needs its own module registry.
/**
 * Microsoft sign-in identifies the person by the user principal name, and trusts it only when the
 * signing-in directory lists the UPN's domain among its verified domains. The separately editable
 * `mail` attribute is never used. An address that is not proven — an unlisted domain, a personal
 * Microsoft account, a failed lookup — neither matches an account nor admits anyone, while an
 * identity already linked from account settings still signs in, and link mode still links.
 */
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { oauthProviders, users } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  sessionCookieHeader,
  uniqueId,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const APP = 'https://app.example'
const ENTRA = 'https://login.microsoftonline.com'
const realFetch = globalThis.fetch
let graphMe: Record<string, unknown> = {}
/** What Graph `/organization` answers: the directory's verified domains, or an error status. */
let organization: string[] | number = []

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new Request(input, init).url
    if (url === `${ENTRA}/common/v2.0/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: `${ENTRA}/{tenantid}/v2.0`,
        authorization_endpoint: `${ENTRA}/common/oauth2/v2.0/authorize`,
        token_endpoint: `${ENTRA}/common/oauth2/v2.0/token`,
        jwks_uri: `${ENTRA}/common/discovery/v2.0/keys`,
        id_token_signing_alg_values_supported: ['RS256'],
      })
    }
    if (url === `${ENTRA}/common/oauth2/v2.0/token`) {
      return jsonResponse({ access_token: 'graph-access-token', token_type: 'Bearer' })
    }
    if (url.startsWith('https://graph.microsoft.com/v1.0/organization')) {
      if (typeof organization === 'number') {
        return new Response('{"error":{"code":"Request_BadRequest"}}', { status: organization })
      }
      return jsonResponse({
        value: [{ verifiedDomains: organization.map(name => ({ name, isDefault: false })) }],
      })
    }
    if (url.startsWith('https://graph.microsoft.com/v1.0/me')) return jsonResponse(graphMe)
    return realFetch(input, init)
  })
})
afterEach(() => vi.restoreAllMocks())

function setCookie(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .find(c => c.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.slice(name.length + 1)
}

const domainOf = (email: string) => email.slice(email.indexOf('@') + 1)

async function signIn(
  env: ReturnType<typeof createTestEnv>,
  startHeaders: Record<string, string> = {},
  link = false
) {
  const start = await request(
    `/auth/microsoft${link ? '?link=1' : ''}`,
    { headers: startHeaders },
    { env }
  )
  const flow = setCookie(start, OAUTH_STATE_COOKIE_NAME)
  const state = new URL(start.headers.get('location') as string).searchParams.get('state')
  return request(
    `/auth/microsoft/callback?code=code&state=${state}`,
    {
      headers: {
        Cookie: [
          `${OAUTH_STATE_COOKIE_NAME}=${flow}`,
          ...(startHeaders.Cookie ? [startHeaders.Cookie] : []),
        ].join('; '),
      },
    },
    { env }
  )
}

const errorOf = (res: Response) =>
  new URL(res.headers.get('location') as string, APP).searchParams.get('error')

async function linksOf(objectId: string) {
  return db.select().from(oauthProviders).where(eq(oauthProviders.providerUserId, objectId))
}

describe('Microsoft sign-in email', () => {
  it('a differing `mail` attribute does not sign in the account that owns that address', async () => {
    const { user: owner } = await createTestTenantWithUser(db, 'owner')
    const principal = `person_${uniqueId().toLowerCase()}@directory.onmicrosoft.com`
    const objectId = `oid_${uniqueId()}`
    graphMe = { id: objectId, displayName: 'P', mail: owner.email, userPrincipalName: principal }
    organization = ['directory.onmicrosoft.com']
    const env = createTestEnv({ APP_ENV: 'production', APP_URL: APP })
    const res = await signIn(env)
    const links = await db
      .select()
      .from(oauthProviders)
      .where(eq(oauthProviders.providerUserId, objectId))
    for (const link of links) expect(link.userId).not.toBe(owner.id)
    const token = setCookie(res, SESSION_COOKIE_NAME)
    if (token) {
      const session = await json<{ user: { id: string } }>(
        await request('/auth/session', { headers: sessionCookieHeader(token) }, { env })
      )
      expect(session.user.id).not.toBe(owner.id)
    }
  })

  it('a `mail` attribute naming a bootstrap admin address grants nothing', async () => {
    const admin = `bootstrap_${uniqueId().toLowerCase()}@example.test`
    const principal = `person_${uniqueId().toLowerCase()}@directory.onmicrosoft.com`
    graphMe = {
      id: `oid_${uniqueId()}`,
      displayName: 'P',
      mail: admin,
      userPrincipalName: principal,
    }
    organization = ['directory.onmicrosoft.com']
    const env = createTestEnv({
      APP_ENV: 'production',
      APP_URL: APP,
      SIGNUP_MODE: 'open',
      BOOTSTRAP_ADMIN_EMAILS: admin,
    })
    await signIn(env)
    expect(await db.select().from(users).where(eq(users.email, admin))).toHaveLength(0)
  })

  it('a person whose principal name is their address, on a verified domain, signs in', async () => {
    const { user } = await createTestTenantWithUser(db, 'member')
    const objectId = `oid_${uniqueId()}`
    graphMe = { id: objectId, displayName: 'P', mail: null, userPrincipalName: user.email }
    organization = ['other.example', domainOf(user.email).toUpperCase()]
    const res = await signIn(createTestEnv({ APP_ENV: 'production', APP_URL: APP }))
    expect(new URL(res.headers.get('location') as string, APP).pathname).toBe('/')
    const [link] = await db
      .select()
      .from(oauthProviders)
      .where(eq(oauthProviders.providerUserId, objectId))
    expect(link?.userId).toBe(user.id)
  })

  it.each([
    ['a domain the directory has not verified', ['directory.onmicrosoft.com']],
    ['a personal account (no directory to ask)', 403],
    ['a directory that lists no domains', []],
  ] as const)('%s: no email link and no admission', async (_case, answer) => {
    organization = answer as string[] | number
    const existing = await createTestUser(db)
    const objectId = `oid_${uniqueId()}`
    graphMe = { id: objectId, displayName: 'P', mail: null, userPrincipalName: existing.email }
    const env = createTestEnv({ APP_ENV: 'production', APP_URL: APP, SIGNUP_MODE: 'open' })
    const res = await signIn(env)
    expect(errorOf(res)).toBe('email_unverified')
    expect(await linksOf(objectId)).toEqual([])

    const newcomer = `new_${uniqueId().toLowerCase()}@unverified.example`
    const newcomerId = `oid_${uniqueId()}`
    graphMe = { id: newcomerId, displayName: 'N', mail: null, userPrincipalName: newcomer }
    expect(errorOf(await signIn(env))).toBe('email_unverified')
    expect(await db.select().from(users).where(eq(users.email, newcomer))).toHaveLength(0)
  })

  it('a personal account the person linked from account settings signs in', async () => {
    organization = 403
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const objectId = `oid_${uniqueId()}`
    const personal = `personal_${uniqueId().toLowerCase()}@outlook.com`
    graphMe = { id: objectId, displayName: 'P', mail: null, userPrincipalName: personal }
    const env = createTestEnv({ APP_ENV: 'production', APP_URL: APP })
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))

    // Link mode, from a signed-in session, links the unverified address.
    const linked = await signIn(env, cookie, true)
    expect(errorOf(linked)).toBeNull()
    const [link] = await linksOf(objectId)
    expect(link?.userId).toBe(user.id)

    // Later, signed out, the same identity signs in to that account.
    const res = await signIn(env)
    expect(errorOf(res)).toBeNull()
    const token = setCookie(res, SESSION_COOKIE_NAME) as string
    const session = await json<{ user: { id: string } }>(
      await request('/auth/session', { headers: sessionCookieHeader(token) }, { env })
    )
    expect(session.user.id).toBe(user.id)
  })
})

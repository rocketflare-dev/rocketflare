// @vitest-isolate
// Replaces the plugin barrel's SSO policies with fixtures (vi.mock), so it needs its own registry.
/**
 * "SSO required" per email domain (`ServerPlugin.ssoPolicy`, `api/auth/sso-policy.ts`) at every
 * kit enforcement point, with FIXTURE policies standing in for an SSO plugin's connections — so
 * none of this depends on which plugins a copy has installed:
 *
 * - `acme` claims `@acme-sso.test` and routes it to its `sso` login method;
 * - `broken` throws for `@broken-sso.test` (fail closed) and answers null for everything else.
 *
 * The OAuth/OIDC callback's case lives in `auth-oidc.test.ts`, beside the fake issuer.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { configMiddleware } from '@/api/middleware/config'
import { databaseMiddleware } from '@/api/middleware/database'
import { errorHandler } from '@/api/middleware/error-handler'
import { requestIdMiddleware, requestLogger } from '@/api/middleware/request-logger'
import { requestMagicLink, requestSignInEmail } from '@/api/routes/auth/magic-link'
import { createRouter } from '@/api/utils/routes/router'
import { loadConfig } from '@/config'
import { magicLinkTokens, oauthProviders, users } from '@/db/schema'
import { identityFor } from '@/plugins/api'
import { createTestUser, uniqueId } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

vi.mock('@/api/routes/auth/sso', async () => {
  const { evaluateSsoPolicyForAll } = await import('@/api/auth/sso-policy')
  const fixtures = [
    {
      shared: { id: 'acme' },
      loginMethods: () => [{ id: 'sso', label: 'Acme SSO', startPath: '/api/hooks/acme/sso' }],
      ssoPolicy: async (_db: unknown, email: string) =>
        email.endsWith('@acme-sso.test')
          ? { required: true as const, methodId: 'sso', label: 'Acme SSO' }
          : null,
    },
    {
      shared: { id: 'broken' },
      ssoPolicy: async (_db: unknown, email: string) => {
        if (email.endsWith('@broken-sso.test')) throw new Error('connections table unreachable')
        return null
      },
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

const stubLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
const acmeEmail = () => `sso_${uniqueId().toLowerCase()}@acme-sso.test`

function location(res: Response): URL {
  return new URL(res.headers.get('location') ?? '', 'http://localhost:3001')
}

function sessionCookieFrom(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.split(';')[0]
}

/** Open the emailed link, then press "Sign in" on the confirm page. */
async function followLink(verifyUrl: string, env: TestEnv = createTestEnv()) {
  const opened = await request(verifyUrl, {}, { env })
  const confirm = location(opened)
  return request(
    '/auth/magic-link/verify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.fromEntries(confirm.searchParams)).toString(),
    },
    { env }
  )
}

async function mintLink(email: string, env: TestEnv = createTestEnv()) {
  return (await requestMagicLink(db, loadConfig(env), stubLogger(), { email })).verifyUrl
}

async function tokenRows(email: string) {
  return db.select().from(magicLinkTokens).where(eq(magicLinkTokens.email, email))
}

describe('magic link', () => {
  it('request: 202 with the usual body, NO token minted, a token-free SSO email instead', async () => {
    const email = acmeEmail()
    const res = await request('/auth/magic-link/request', { method: 'POST' }, { json: { email } })
    expect(res.status).toBe(202)
    expect(await json(res)).toEqual({ ok: true })
    expect(await tokenRows(email)).toHaveLength(0)

    const sent = await requestSignInEmail(db, loadConfig(createTestEnv()), stubLogger(), { email })
    expect(sent.kind).toBe('sso_required')
    if (sent.kind !== 'sso_required') throw new Error('unreachable')
    const url = new URL(sent.loginUrl)
    expect(url.pathname).toBe('/login')
    expect(url.searchParams.get('error')).toBe('sso_required')
    expect(url.searchParams.get('method')).toBe('acme:sso')
    expect(url.searchParams.get('email')).toBe(email)
    expect(url.searchParams.has('token')).toBe(false)
    expect(await tokenRows(email)).toHaveLength(0)
  })

  it('an invitation’s sign-in is routed to SSO with the invite as the return path', async () => {
    const sent = await requestSignInEmail(db, loadConfig(createTestEnv()), stubLogger(), {
      email: acmeEmail(),
      redirectTo: '/invite/abc123',
    })
    if (sent.kind !== 'sso_required') throw new Error(`expected sso_required, got ${sent.kind}`)
    expect(new URL(sent.loginUrl).searchParams.get('returnUrl')).toBe('/invite/abc123')
  })

  it('verify refuses a token minted before the policy existed, and admits nobody', async () => {
    const email = acmeEmail()
    await createTestUser(db, { email })
    const res = await followLink(await mintLink(email))
    expect(res.status).toBe(302)
    expect(location(res).pathname).toBe('/login')
    expect(location(res).searchParams.get('error')).toBe('sso_required')
    expect(location(res).searchParams.get('method')).toBe('acme:sso')
    expect(sessionCookieFrom(res)).toBeUndefined()
    // The token is spent all the same: the refusal is not a way to keep a link alive.
    const [row] = await tokenRows(email)
    expect(row?.consumedAt).not.toBeNull()
  })

  it('a policy that throws fails closed: refused, with no method to route to', async () => {
    const email = `x_${uniqueId().toLowerCase()}@broken-sso.test`
    await createTestUser(db, { email })
    const res = await followLink(await mintLink(email))
    expect(location(res).searchParams.get('error')).toBe('sso_required')
    expect(location(res).searchParams.has('method')).toBe(false)
    expect(sessionCookieFrom(res)).toBeUndefined()
  })

  it('break-glass: a BOOTSTRAP_ADMIN_EMAILS address signs in by magic link regardless', async () => {
    const email = acmeEmail()
    const env = createTestEnv({ BOOTSTRAP_ADMIN_EMAILS: email })
    const sent = await requestSignInEmail(db, loadConfig(env), stubLogger(), { email })
    expect(sent.kind).toBe('magic_link')
    if (sent.kind !== 'magic_link') throw new Error('unreachable')
    const res = await followLink(sent.verifyUrl, env)
    expect(location(res).pathname).toBe('/')
    expect(sessionCookieFrom(res)).toBeTruthy()
    const [admin] = await db.select().from(users).where(eq(users.email, email))
    expect(admin?.isGlobalAdmin).toBe(true)
  })

  it('an unclaimed domain is unaffected', async () => {
    const user = await createTestUser(db)
    const sent = await requestSignInEmail(db, loadConfig(createTestEnv()), stubLogger(), {
      email: user.email,
    })
    expect(sent.kind).toBe('magic_link')
    if (sent.kind !== 'magic_link') throw new Error('unreachable')
    const res = await followLink(sent.verifyUrl)
    expect(location(res).pathname).toBe('/')
    expect(sessionCookieFrom(res)).toBeTruthy()
  })
})

describe('dev login', () => {
  it('403 sso_required with the method to route to', async () => {
    const res = await request(
      '/auth/dev-login',
      { method: 'POST' },
      { json: { email: acmeEmail() } }
    )
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({
      statusCode: 403,
      code: 'sso_required',
      details: { method: 'acme:sso' },
    })
  })

  it('an unclaimed domain signs in as before', async () => {
    const user = await createTestUser(db)
    const res = await request(
      '/auth/dev-login',
      { method: 'POST' },
      { json: { email: user.email } }
    )
    expect(res.status).toBe(200)
  })
})

/**
 * `identityFor(c, id).signIn` from a handler of plugin `id` — the shape a plugin's public route
 * has, on the kit's own middleware, so neither fixture needs to be an installed plugin.
 */
function idpApp(pluginId: string) {
  const app = createRouter()
  app.onError(errorHandler)
  app.use('*', requestIdMiddleware, requestLogger, configMiddleware, databaseMiddleware)
  app.get('/sign-in', c =>
    identityFor(c, pluginId).signIn({
      subject: `fixture|${c.req.query('email')}`,
      email: c.req.query('email') ?? '',
      emailVerified: true,
      linkByEmail: true,
    })
  )
  return app
}

async function signInVia(pluginId: string, email: string) {
  const params = new URLSearchParams({ email })
  return request(`/sign-in?${params}`, {}, { app: idpApp(pluginId) })
}

describe('a plugin’s identityFor().signIn', () => {
  it('the claiming plugin’s own sign-in passes', async () => {
    const email = acmeEmail()
    await createTestUser(db, { email })
    const res = await signInVia('acme', email)
    expect(res.status).toBe(302)
    expect(location(res).pathname).toBe('/')
    expect(sessionCookieFrom(res)).toBeTruthy()
  })

  it('a DIFFERENT plugin’s sign-in for that address is refused, and links nothing', async () => {
    const email = acmeEmail()
    const user = await createTestUser(db, { email })
    const res = await signInVia('other-idp', email)
    expect(location(res).pathname).toBe('/login')
    expect(location(res).searchParams.get('error')).toBe('sso_required')
    expect(location(res).searchParams.get('method')).toBe('acme:sso')
    expect(sessionCookieFrom(res)).toBeUndefined()
    const links = await db
      .select()
      .from(oauthProviders)
      .where(
        and(eq(oauthProviders.userId, user.id), eq(oauthProviders.provider, 'plugin:other-idp'))
      )
    expect(links).toHaveLength(0)
  })

  it('a plugin’s sign-in for an unclaimed address is unaffected', async () => {
    const user = await createTestUser(db)
    const res = await signInVia('other-idp', user.email)
    expect(location(res).pathname).toBe('/')
  })
})

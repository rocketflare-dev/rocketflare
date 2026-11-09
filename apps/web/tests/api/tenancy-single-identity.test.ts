// @vitest-isolate
// Replaces the plugin barrel's SSO policies with a fixture (vi.mock), so it needs its own registry.
/**
 * The enterprise-identity seam under `TENANCY_MODE=single`, where the one tenant is the whole
 * deployment (`getSingleTenant`, the oldest row — the setup of `tenancy-single.test.ts`):
 *
 * - `identityFor(c, id).signIn` lands in THE tenant with the asserted role, follows `SIGNUP_MODE`
 *   (auto-join as member) without one, and treats any other tenant id as one that does not exist;
 * - `ServerPlugin.ssoPolicy` holds in single mode too, with the bootstrap break-glass seating the
 *   operator in the tenant;
 * - `provisionFor(ctx, id).deprovision` BLOCKS the leaver (`blocked_source = 'plugin:<id>'`) and
 *   ends every session, so no other method signs them back in; only the same plugin's
 *   `setMembership` lifts it, never an admin's `manual` block;
 * - multi mode, for contrast, never blocks.
 *
 * Fixture plugins, not installed ones: `acme` claims `@acme-sso.test`, `scim` claims nothing.
 */
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE_NAME } from '@/api/auth/cookies'
import { configMiddleware } from '@/api/middleware/config'
import { databaseMiddleware } from '@/api/middleware/database'
import { errorHandler } from '@/api/middleware/error-handler'
import { requestIdMiddleware, requestLogger } from '@/api/middleware/request-logger'
import { requestMagicLink } from '@/api/routes/auth/magic-link'
import { createLogger } from '@/api/utils/core/logger'
import { getSingleTenant } from '@/api/utils/db/tenant-helpers'
import { createRouter } from '@/api/utils/routes/router'
import { loadConfig } from '@/config'
import { type Tenant, tenantUsers, userSessions, users } from '@/db/schema'
import { identityFor, provisionFor } from '@/plugins/api'
import {
  bearerHeader,
  createTestApiKey,
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
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
  ]
  return {
    // biome-ignore lint/suspicious/noExplicitAny: the mock forwards the real signature untouched
    ssoDecisionFor: (db: any, cfg: any, emails: any, logger: any) =>
      // biome-ignore lint/suspicious/noExplicitAny: fixtures are structurally ServerPlugins
      evaluateSsoPolicyForAll(fixtures as any, db, cfg, emails, logger),
  }
})

const db = setupTestDatabase()
const singleEnv = createTestEnv({ TENANCY_MODE: 'single', SIGNUP_MODE: 'open' })
const multiEnv = createTestEnv({ TENANCY_MODE: 'multi', SIGNUP_MODE: 'open' })
const logger = createLogger({ level: 'silent' })

let single: Tenant
let other: Tenant

beforeAll(async () => {
  other = await createTestTenant(db)
  const anchor = await getSingleTenant(db)
  if (!anchor || anchor.id === other.id) {
    // An empty database: the tenant just made is the anchor; make a second, unreachable one.
    single = other
    other = await createTestTenant(db)
  } else {
    single = anchor
  }
})

const newEmail = (domain = 'example.test') => `single_${uniqueId().toLowerCase()}@${domain}`
const ctxFor = (env: TestEnv) => ({ db, config: loadConfig(env), logger, env })
const provision = (pluginId = 'scim', env: TestEnv = singleEnv) =>
  provisionFor(ctxFor(env), pluginId)

function location(res: Response): URL {
  return new URL(res.headers.get('location') ?? '', 'http://localhost:3001')
}

function sessionCookieFrom(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.split(';')[0]
}

/** `identityFor(c, id).signIn` from a fixture plugin's public route, on the kit's own middleware. */
function idpApp(pluginId: string) {
  const app = createRouter()
  app.onError(errorHandler)
  app.use('*', requestIdMiddleware, requestLogger, configMiddleware, databaseMiddleware)
  app.get('/sign-in', c => {
    const q = c.req.query()
    return identityFor(c, pluginId).signIn({
      subject: `fixture|${q.email}`,
      email: q.email ?? '',
      emailVerified: true,
      linkByEmail: q.linkByEmail === 'true',
      ...(q.tenantId ? { tenantId: q.tenantId } : {}),
      ...(q.role === 'admin' || q.role === 'member' ? { role: q.role } : {}),
    })
  })
  return app
}

async function signInVia(
  pluginId: string,
  params: Record<string, string>,
  env: TestEnv = singleEnv
) {
  return request(`/sign-in?${new URLSearchParams(params)}`, {}, { app: idpApp(pluginId), env })
}

/** Mint a magic link and press "Sign in" on its confirm page. */
async function magicLinkSignIn(email: string, env: TestEnv = singleEnv) {
  const { verifyUrl } = await requestMagicLink(db, loadConfig(env), logger, { email })
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

async function devLogin(email: string, env: TestEnv = singleEnv) {
  return request('/auth/dev-login', { method: 'POST' }, { json: { email }, env })
}

async function membershipOf(userId: string, tenantId = single.id) {
  return db.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)),
  })
}

async function userRow(userId: string) {
  return db.query.users.findFirst({ where: eq(users.id, userId) })
}

async function sessionsOf(userId: string) {
  return db.select().from(userSessions).where(eq(userSessions.userId, userId))
}

/** A SCIM-provisioned member of the single tenant, signed in twice (pinned + unpinned) with a key. */
async function provisionedMember(pluginId = 'scim') {
  const email = newEmail()
  const person = await provision(pluginId).upsertUser({
    subject: `scim|${email}`,
    email,
    emailVerified: true,
    linkByEmail: true,
  })
  await provision(pluginId).setMembership({
    tenantId: single.id,
    userId: person.id,
    role: 'member',
  })
  const pinned = await createTestSession(db, person.id, single.id)
  const unpinned = await createTestSession(db, person.id, null)
  const { key } = await createTestApiKey(db, single.id, person.id)
  return { person, email, pinned, unpinned, key }
}

describe('single mode: identityFor().signIn', () => {
  it('with tenantId + role: a new person lands in THE tenant with that role, idp-managed', async () => {
    const email = newEmail()
    const res = await signInVia('scim', {
      linkByEmail: 'true',
      email,
      tenantId: single.id,
      role: 'admin',
    })
    expect(location(res).pathname).toBe('/')
    const cookie = sessionCookieFrom(res)
    expect(cookie).toBeTruthy()
    const person = await db.query.users.findFirst({ where: eq(users.email, email) })
    expect(await membershipOf(person?.id ?? '')).toMatchObject({ role: 'admin', source: 'idp' })
    const session = await json<{ tenant: { id: string; role: string }; tenancyMode: string }>(
      await request('/auth/session', { headers: { Cookie: cookie ?? '' } }, { env: singleEnv })
    )
    expect(session).toMatchObject({
      tenancyMode: 'single',
      tenant: { id: single.id, role: 'admin' },
    })
  })

  it('without a role: admitted by SIGNUP_MODE — open auto-joins as member, invite_only refuses', async () => {
    const email = newEmail()
    const res = await signInVia('scim', { linkByEmail: 'true', email })
    expect(location(res).pathname).toBe('/')
    const person = await db.query.users.findFirst({ where: eq(users.email, email) })
    expect(await membershipOf(person?.id ?? '')).toMatchObject({ role: 'member', source: 'manual' })

    const refused = await signInVia(
      'scim',
      { linkByEmail: 'true', email: newEmail() },
      createTestEnv({ TENANCY_MODE: 'single', SIGNUP_MODE: 'invite_only' })
    )
    expect(location(refused).searchParams.get('error')).toBe('not_invited')
  })

  it('any tenant but THE tenant is one that does not exist: no_access, nothing written', async () => {
    const email = newEmail()
    const res = await signInVia('scim', {
      linkByEmail: 'true',
      email,
      tenantId: other.id,
      role: 'admin',
    })
    expect(location(res).searchParams.get('error')).toBe('no_access')
    expect(await db.query.users.findFirst({ where: eq(users.email, email) })).toBeUndefined()
  })

  it('an existing unlinked account is account_exists without linkByEmail, linked with it', async () => {
    const existing = await createTestUser(db)
    await linkUserToTenant(db, existing.id, single.id, 'member')
    const refused = await signInVia('scim', { email: existing.email })
    expect(location(refused).searchParams.get('error')).toBe('account_exists')
    const linked = await signInVia('scim', { email: existing.email, linkByEmail: 'true' })
    expect(location(linked).pathname).toBe('/')
  })

  it('SSO required: only the claiming plugin signs the domain in, into THE tenant', async () => {
    const email = newEmail('acme-sso.test')
    const refused = await signInVia('scim', {
      linkByEmail: 'true',
      email,
      tenantId: single.id,
      role: 'member',
    })
    expect(location(refused).searchParams.get('error')).toBe('sso_required')
    expect(location(refused).searchParams.get('method')).toBe('acme:sso')
    const own = await signInVia('acme', {
      linkByEmail: 'true',
      email,
      tenantId: single.id,
      role: 'member',
    })
    expect(location(own).pathname).toBe('/')
    const person = await db.query.users.findFirst({ where: eq(users.email, email) })
    expect(await membershipOf(person?.id ?? '')).toMatchObject({ role: 'member', source: 'idp' })
  })
})

describe('single mode: ssoPolicy on the kit’s own methods', () => {
  it('magic link and dev login refuse a claimed address, and seat nobody', async () => {
    const email = newEmail('acme-sso.test')
    const res = await magicLinkSignIn(email)
    expect(location(res).searchParams.get('error')).toBe('sso_required')
    expect(sessionCookieFrom(res)).toBeUndefined()
    const dev = await devLogin(email)
    expect(dev.status).toBe(403)
    expect(await json(dev)).toMatchObject({ code: 'sso_required', details: { method: 'acme:sso' } })
    expect(await db.query.users.findFirst({ where: eq(users.email, email) })).toBeUndefined()
  })

  it('break-glass: a bootstrap admin with a claimed address signs in and joins THE tenant', async () => {
    const email = newEmail('acme-sso.test')
    const env = createTestEnv({
      TENANCY_MODE: 'single',
      SIGNUP_MODE: 'invite_only',
      BOOTSTRAP_ADMIN_EMAILS: email,
    })
    const res = await magicLinkSignIn(email, env)
    expect(location(res).pathname).toBe('/')
    const admin = await db.query.users.findFirst({ where: eq(users.email, email) })
    expect(admin?.isGlobalAdmin).toBe(true)
    // The tenant already exists, so `onNoTenant` seats them in it (it creates it on an empty DB).
    expect(await membershipOf(admin?.id ?? '')).toMatchObject({ role: 'member' })
  })
})

describe('single mode: provisionFor', () => {
  it('works on THE tenant and answers 404 for any other', async () => {
    const { person } = await provisionedMember()
    const members = await provision().listMembers({ tenantId: single.id })
    expect(members.find(m => m.userId === person.id)).toMatchObject({
      role: 'member',
      source: 'idp',
      blocked: false,
    })
    for (const call of [
      () => provision().listMembers({ tenantId: other.id }),
      () => provision().setMembership({ tenantId: other.id, userId: person.id, role: 'admin' }),
      () => provision().removeMembership({ tenantId: other.id, userId: person.id }),
      () => provision().deprovision({ tenantId: other.id, userId: person.id }),
    ]) {
      await expect(call()).rejects.toMatchObject({ statusCode: 404 })
    }
    expect(await membershipOf(person.id, other.id)).toBeUndefined()
  })

  it('deprovision BLOCKS the leaver: every session, the API key and every way back in end', async () => {
    const { person, email, pinned, unpinned, key } = await provisionedMember()
    expect(await provision().deprovision({ tenantId: single.id, userId: person.id })).toEqual({
      removed: true,
      sessionsEnded: 2,
      retained: null,
      blocked: true,
    })
    expect(await userRow(person.id)).toMatchObject({ blockedSource: 'plugin:scim' })
    expect(await sessionsOf(person.id)).toHaveLength(0)
    expect(await membershipOf(person.id)).toBeUndefined()

    for (const token of [pinned, unpinned]) {
      const res = await request(
        '/auth/session',
        { headers: sessionCookieHeader(token) },
        {
          env: singleEnv,
        }
      )
      expect(res.status).toBe(401)
    }
    const keyed = await request('/api/members', { headers: bearerHeader(key) }, { env: singleEnv })
    expect(keyed.status).toBe(401)

    // No other method — not dev login's `onNoTenant`, not another plugin — seats them again.
    expect(location(await magicLinkSignIn(email)).searchParams.get('error')).toBe('blocked')
    const dev = await devLogin(email)
    expect(dev.status).toBe(403)
    expect(await json(dev)).toMatchObject({ code: 'blocked' })
    const viaOther = await signInVia('other-idp', { email, linkByEmail: 'true' })
    expect(location(viaOther).searchParams.get('error')).toBe('blocked')
    expect(await membershipOf(person.id)).toBeUndefined()

    // A repeat changes nothing and reports the same state.
    expect(await provision().deprovision({ tenantId: single.id, userId: person.id })).toEqual({
      removed: false,
      sessionsEnded: 0,
      retained: null,
      blocked: true,
    })
    // A profile refresh is not a reactivation.
    expect(
      await provision().upsertUser({
        subject: `scim|${email}`,
        email,
        emailVerified: true,
        linkByEmail: true,
      })
    ).toMatchObject({ id: person.id, blocked: true })
    // Nor is a sign-in through the very plugin that blocked them.
    const own = await signInVia('scim', {
      email,
      tenantId: single.id,
      role: 'member',
      linkByEmail: 'true',
    })
    expect(location(own).searchParams.get('error')).toBe('blocked')
  })

  it('the SAME plugin’s setMembership reactivates; another plugin’s does not', async () => {
    const { person, email } = await provisionedMember()
    await provision().deprovision({ tenantId: single.id, userId: person.id })

    await provision('other-idp').setMembership({
      tenantId: single.id,
      userId: person.id,
      role: 'member',
    })
    expect((await userRow(person.id))?.blockedAt).not.toBeNull()

    await provision().setMembership({ tenantId: single.id, userId: person.id, role: 'admin' })
    expect(await userRow(person.id)).toMatchObject({ blockedAt: null, blockedSource: null })
    const res = await magicLinkSignIn(email)
    expect(location(res).pathname).toBe('/')
    expect(await membershipOf(person.id)).toMatchObject({ role: 'admin', source: 'idp' })
  })

  it('an admin’s block is manual: no IdP reactivation lifts it, and it supersedes an IdP block', async () => {
    const admin = await createTestGlobalAdmin(db)
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id, single.id))
    const block = (userId: string, blocked: boolean) =>
      request(
        `/api/admin/users/${userId}/block`,
        { method: 'POST', headers: adminCookie },
        { env: singleEnv, json: { blocked } }
      )

    const { person } = await provisionedMember()
    expect((await block(person.id, true)).status).toBe(200)
    expect(await userRow(person.id)).toMatchObject({ blockedSource: 'manual' })
    await provision().setMembership({ tenantId: single.id, userId: person.id, role: 'member' })
    expect((await userRow(person.id))?.blockedAt).not.toBeNull()
    expect(await provision().deprovision({ tenantId: single.id, userId: person.id })).toMatchObject(
      { removed: true, blocked: true }
    )
    expect(await userRow(person.id)).toMatchObject({ blockedSource: 'manual' })

    // An admin blocking an IdP-blocked person makes it theirs; Unblock clears either.
    const second = await provisionedMember()
    await provision().deprovision({ tenantId: single.id, userId: second.person.id })
    await block(second.person.id, true)
    expect(await userRow(second.person.id)).toMatchObject({ blockedSource: 'manual' })
    await provision().setMembership({
      tenantId: single.id,
      userId: second.person.id,
      role: 'member',
    })
    expect((await userRow(second.person.id))?.blockedAt).not.toBeNull()
    await block(second.person.id, false)
    expect(await userRow(second.person.id)).toMatchObject({ blockedAt: null, blockedSource: null })

    const detail = await json<{ blockedSource: string | null }>(
      await request(`/api/admin/users/${person.id}`, { headers: adminCookie }, { env: singleEnv })
    )
    expect(detail.blockedSource).toBe('manual')
  })

  it('blocks only someone the IdP speaks for, and never a global admin', async () => {
    // A `manual` member: retained, not blocked, sessions kept.
    const manual = await createTestUser(db)
    await linkUserToTenant(db, manual.id, single.id, 'member')
    await createTestSession(db, manual.id, single.id)
    expect(await provision().deprovision({ tenantId: single.id, userId: manual.id })).toEqual({
      removed: false,
      sessionsEnded: 0,
      retained: { role: 'member', source: 'manual' },
      blocked: false,
    })
    expect(await sessionsOf(manual.id)).toHaveLength(1)

    // No `idp` row and no link from this plugin: the IdP does not know them.
    const stranger = await createTestUser(db)
    expect(await provision().deprovision({ tenantId: single.id, userId: stranger.id })).toEqual({
      removed: false,
      sessionsEnded: 0,
      retained: null,
      blocked: false,
    })
    expect((await userRow(stranger.id))?.blockedAt).toBeNull()

    // A global admin with an `idp` row loses the row, never the console.
    const operator = await createTestGlobalAdmin(db)
    await provision().setMembership({ tenantId: single.id, userId: operator.id, role: 'admin' })
    expect(await provision().deprovision({ tenantId: single.id, userId: operator.id })).toEqual({
      removed: true,
      sessionsEnded: 0,
      retained: null,
      blocked: false,
    })
    expect((await userRow(operator.id))?.blockedAt).toBeNull()
  })
})

describe('multi mode, for contrast: deprovision never blocks', () => {
  it('the leaver is removed from that tenant only, and a later sign-in finds no tenant', async () => {
    const tenant = await createTestTenant(db)
    const email = newEmail()
    const scim = provision('scim', multiEnv)
    const person = await scim.upsertUser({
      subject: `scim|${email}`,
      email,
      emailVerified: true,
      linkByEmail: true,
    })
    await scim.setMembership({ tenantId: tenant.id, userId: person.id, role: 'member' })
    const unpinned = await createTestSession(db, person.id, null)
    expect(await scim.deprovision({ tenantId: tenant.id, userId: person.id })).toEqual({
      removed: true,
      sessionsEnded: 0,
      retained: null,
      blocked: false,
    })
    expect((await userRow(person.id))?.blockedAt).toBeNull()
    // The unpinned session survives, with no tenant to act in.
    const session = await json<{ tenant: unknown; tenants: unknown[] }>(
      await request('/auth/session', { headers: sessionCookieHeader(unpinned) }, { env: multiEnv })
    )
    expect(session).toMatchObject({ tenant: null, tenants: [] })
    // SIGNUP_MODE=open gives a NEW person a workspace; a returning one gets none by magic link.
    const res = await magicLinkSignIn(email, multiEnv)
    expect(location(res).pathname).toBe('/')
    expect(await db.select().from(tenantUsers).where(eq(tenantUsers.userId, person.id))).toEqual([])
  })
})

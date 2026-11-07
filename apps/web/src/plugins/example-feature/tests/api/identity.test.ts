/**
 * The identity seam, through the example plugin: `identityFor(c, id).signIn` behind the dev-only
 * example SSO (`api/sso.ts`), `provisionFor(ctx, id)` directly, and `ServerPlugin.loginMethods` on
 * `GET /auth/methods`.
 *
 * Everything runs the REAL mount and the real database, because what is being proved is what the
 * kit writes on the plugin's behalf — a user, a provider link under `plugin:example-feature`, an
 * `idp` membership, a session pinned to the tenant — none of which the plugin touches itself.
 *
 * The flag is turned on with a per-tenant override, for the reason `example-feature.test.ts` gives.
 */
import { EXAMPLE_FEATURE_FLAG } from '@rocketflare/shared/plugins/example-feature/index'
import {
  createTestEnv,
  createTestSession,
  createTestTenant,
  createTestUser,
  json,
  linkUserToTenant,
  request,
  sessionCookieHeader,
  setupTestDatabase,
  uniqueId,
} from '@testkit/integration'
import { makeJobCtx } from '@testkit/unit'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { provisionFor, signState } from '@/plugins/api'
import { allTables } from '@/plugins/api/peers'
import { EXAMPLE_SSO_PURPOSE } from '../../shared'

const db = setupTestDatabase()

const HOOKS = '/api/hooks/example-feature/sso'
const PROVIDER = 'plugin:example-feature'

let tenantId: string
let ownerCookie: Record<string, string>

async function setFlagFor(tenant: string, enabled: boolean) {
  const { featureFlags, tenantFeatureOverrides } = allTables()
  await db
    .insert(featureFlags)
    .values({ key: EXAMPLE_FEATURE_FLAG, state: 'off' })
    .onConflictDoNothing()
  await db
    .insert(tenantFeatureOverrides)
    .values({ tenantId: tenant, flagKey: EXAMPLE_FEATURE_FLAG, enabled })
    .onConflictDoUpdate({
      target: [tenantFeatureOverrides.tenantId, tenantFeatureOverrides.flagKey],
      set: { enabled },
    })
}

function newEmail() {
  return `sso_${uniqueId().toLowerCase()}@example.test`
}

function location(res: Response): URL {
  return new URL(res.headers.get('location') ?? '', 'http://localhost')
}

/** The example IdP round trip: start (which signs the assertion) → callback (which signs in). */
async function ssoSignIn(params: Record<string, string>, env = createTestEnv()) {
  const start = await request(`${HOOKS}/start?${new URLSearchParams(params)}`, {}, { env })
  expect(start.status).toBe(302)
  const callback = location(start)
  expect(callback.pathname).toBe(`${HOOKS}/callback`)
  return request(`${callback.pathname}${callback.search}`, {}, { env })
}

/** A callback with an assertion the example `start` would never write (it always says verified). */
async function callbackWith(assertion: Record<string, unknown>) {
  const state = await signState(makeJobCtx({ db }).config, EXAMPLE_SSO_PURPOSE, assertion)
  return request(`${HOOKS}/callback?state=${encodeURIComponent(state)}`)
}

async function userByEmail(email: string) {
  const { users } = allTables()
  return db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email}` })
}

async function membership(userId: string, tenant = tenantId) {
  const { tenantUsers } = allTables()
  return db.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.tenantId, tenant), eq(tenantUsers.userId, userId)),
  })
}

async function linksOf(userId: string) {
  const { oauthProviders } = allTables()
  return db
    .select({ provider: oauthProviders.provider, subject: oauthProviders.providerUserId })
    .from(oauthProviders)
    .where(eq(oauthProviders.userId, userId))
}

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenantId))
  await setFlagFor(tenantId, true)
})

afterAll(async () => {
  const { tenantFeatureOverrides } = allTables()
  await db
    .delete(tenantFeatureOverrides)
    .where(
      and(
        eq(tenantFeatureOverrides.flagKey, EXAMPLE_FEATURE_FLAG),
        eq(tenantFeatureOverrides.tenantId, tenantId)
      )
    )
})

describe('identity.signIn', () => {
  it('admits a new person into the tenant with an idp membership and a pinned session', async () => {
    const email = newEmail()
    const res = await ssoSignIn({ email, tenantId, role: 'member', returnUrl: '/settings' })
    expect(res.status).toBe(302)
    expect(location(res).pathname).toBe('/settings')
    expect(res.headers.get('set-cookie') ?? '').toMatch(/__Host-session=[^;]+;/)

    const user = await userByEmail(email)
    expect(user?.emailVerifiedAt).not.toBeNull()
    if (!user) throw new Error('no user')
    expect(await membership(user.id)).toMatchObject({ role: 'member', source: 'idp' })
    expect(await linksOf(user.id)).toEqual([{ provider: PROVIDER, subject: `demo|${email}` }])

    const { userSessions } = allTables()
    const [session] = await db
      .select({ selected: userSessions.selectedTenantId })
      .from(userSessions)
      .where(eq(userSessions.userId, user.id))
    expect(session?.selected).toBe(tenantId)
  })

  it('reuses the link on the next sign-in, and follows the role the IdP now asserts', async () => {
    const email = newEmail()
    await ssoSignIn({ email, tenantId, role: 'member' })
    const first = await userByEmail(email)
    const again = await ssoSignIn({ email, tenantId, role: 'admin' })
    expect(again.status).toBe(302)
    expect(location(again).pathname).toBe('/')
    const second = await userByEmail(email)
    expect(second?.id).toBe(first?.id)
    if (!second) throw new Error('no user')
    expect(await linksOf(second.id)).toHaveLength(1)
    expect(await membership(second.id)).toMatchObject({ role: 'admin', source: 'idp' })
  })

  it('refuses an unverified email and writes nothing', async () => {
    const email = newEmail()
    const res = await callbackWith({
      subject: `demo|${email}`,
      email,
      emailVerified: false,
      linkByEmail: false,
      tenantId,
      role: 'member',
    })
    expect(res.status).toBe(302)
    expect(location(res).pathname).toBe('/login')
    expect(location(res).searchParams.get('error')).toBe('email_unverified')
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/__Host-session=[^;]/)
    expect(await userByEmail(email)).toBeUndefined()
  })

  it('refuses a blocked person, whether found by link or by email', async () => {
    const { users } = allTables()
    const blocked = await createTestUser(db, { blockedAt: new Date() })
    const byEmail = await ssoSignIn({ email: blocked.email, tenantId, role: 'member' })
    expect(location(byEmail).searchParams.get('error')).toBe('blocked')
    expect(await membership(blocked.id)).toBeUndefined()

    const email = newEmail()
    await ssoSignIn({ email, tenantId, role: 'member' })
    const linked = await userByEmail(email)
    if (!linked) throw new Error('no user')
    await db.update(users).set({ blockedAt: new Date() }).where(eq(users.id, linked.id))
    const byLink = await ssoSignIn({ email, tenantId, role: 'member' })
    expect(location(byLink).searchParams.get('error')).toBe('blocked')
    expect(byLink.headers.get('set-cookie') ?? '').not.toMatch(/__Host-session=[^;]/)
  })

  it('refuses to attach to an existing account by email without linkByEmail', async () => {
    const existing = await createTestUser(db)
    const assertion = {
      subject: `demo|${existing.email}`,
      email: existing.email,
      emailVerified: true,
      tenantId,
      role: 'member',
    }
    const refused = await callbackWith({ ...assertion, linkByEmail: false })
    expect(location(refused).searchParams.get('error')).toBe('account_exists')
    expect(refused.headers.get('set-cookie') ?? '').not.toMatch(/__Host-session=[^;]/)
    expect(await linksOf(existing.id)).toHaveLength(0)
    expect(await membership(existing.id)).toBeUndefined()

    const allowed = await callbackWith({ ...assertion, linkByEmail: true })
    expect(location(allowed).pathname).toBe('/')
    expect(await linksOf(existing.id)).toEqual([
      { provider: PROVIDER, subject: `demo|${existing.email}` },
    ])
  })

  it('follows SIGNUP_MODE when no tenant is asserted (invite_only here)', async () => {
    const res = await ssoSignIn({ email: newEmail() })
    expect(location(res).searchParams.get('error')).toBe('not_invited')
  })

  it('signs nobody into a tenant that does not exist', async () => {
    const email = newEmail()
    const res = await callbackWith({
      subject: `demo|${email}`,
      email,
      emailVerified: true,
      linkByEmail: false,
      tenantId: crypto.randomUUID(),
      role: 'member',
    })
    // The plugin's own flag check answers first (a missing tenant has no flags); behind it,
    // `signIn` itself would refuse with `no_access`.
    expect(res.status).toBe(404)
    expect(await userByEmail(email)).toBeUndefined()
  })

  it('is development only, both halves', async () => {
    const env = createTestEnv({ APP_ENV: 'staging' })
    const res = await request(`${HOOKS}/start?email=${newEmail()}`, {}, { env })
    expect(res.status).toBe(404)
    expect((await request(`${HOOKS}/callback?state=x`, {}, { env })).status).toBe(404)
  })
})

describe('loginMethods', () => {
  it('puts the example method on GET /auth/methods in development, namespaced', async () => {
    const body = await json<{ pluginMethods?: unknown[] }>(await request('/auth/methods'))
    expect(body.pluginMethods).toContainEqual({
      id: 'example-feature:demo-sso',
      label: 'Example SSO (development only)',
      startPath: '/api/hooks/example-feature/sso/start',
      askEmail: true,
    })
    const staging = createTestEnv({ APP_ENV: 'staging' })
    const off = await json<{ pluginMethods?: { id: string }[] }>(
      await request('/auth/methods', {}, { env: staging })
    )
    expect((off.pluginMethods ?? []).map(m => m.id)).not.toContain('example-feature:demo-sso')
  })
})

describe('provisionFor', () => {
  const provision = () => provisionFor(makeJobCtx({ db }), 'example-feature')

  it('creates a person with a link and no session, and finds them both ways', async () => {
    const email = newEmail()
    const created = await provision().upsertUser({
      subject: `scim|${email}`,
      email,
      name: 'Pat Provisioned',
      emailVerified: true,
    })
    expect(created).toMatchObject({ email, name: 'Pat Provisioned', blocked: false })
    expect(await provision().findUser({ subject: `scim|${email}` })).toEqual(created)
    expect(await provision().findUser({ email: email.toUpperCase() })).toEqual(created)
    expect(await linksOf(created.id)).toEqual([{ provider: PROVIDER, subject: `scim|${email}` }])
    const { userSessions } = allTables()
    const sessions = await db.select().from(userSessions).where(eq(userSessions.userId, created.id))
    expect(sessions).toHaveLength(0)

    const renamed = await provision().upsertUser({
      subject: `scim|${email}`,
      email,
      name: 'Pat Renamed',
      emailVerified: true,
    })
    expect(renamed).toMatchObject({ id: created.id, name: 'Pat Renamed' })
  })

  it('never links an unverified email to an existing account, and keeps a block', async () => {
    const existing = await createTestUser(db)
    await expect(
      provision().upsertUser({
        subject: `scim|${existing.email}`,
        email: existing.email,
        emailVerified: false,
      })
    ).rejects.toMatchObject({ code: 'email_unverified' })
    expect(await linksOf(existing.id)).toHaveLength(0)

    const blocked = await createTestUser(db, { blockedAt: new Date() })
    const result = await provision().upsertUser({
      subject: `scim|${blocked.email}`,
      email: blocked.email,
      emailVerified: true,
      linkByEmail: true,
    })
    expect(result).toMatchObject({ id: blocked.id, blocked: true })
  })

  it('links an existing account by email only when the plugin says it may (linkByEmail)', async () => {
    const existing = await createTestUser(db)
    await expect(
      provision().upsertUser({
        subject: `scim|${existing.email}`,
        email: existing.email,
        emailVerified: true,
      })
    ).rejects.toMatchObject({ code: 'account_exists' })
    expect(await linksOf(existing.id)).toHaveLength(0)

    const linked = await provision().upsertUser({
      subject: `scim|${existing.email}`,
      email: existing.email,
      emailVerified: true,
      linkByEmail: true,
    })
    expect(linked.id).toBe(existing.id)
    expect(await linksOf(existing.id)).toEqual([
      { provider: PROVIDER, subject: `scim|${existing.email}` },
    ])
  })

  it('sets an idp membership the members API then refuses to edit, and removes it', async () => {
    const email = newEmail()
    const person = await provision().upsertUser({
      subject: `scim|${email}`,
      email,
      emailVerified: true,
    })
    expect(
      await provision().setMembership({ tenantId, userId: person.id, role: 'member' })
    ).toEqual({ role: 'member', source: 'idp' })

    const patch = await request(
      `/api/members/${person.id}`,
      { method: 'PATCH', headers: ownerCookie },
      { json: { role: 'admin' } }
    )
    expect(patch.status).toBe(409)
    expect(await json(patch)).toMatchObject({ code: 'idp_managed' })

    const members = await provision().listMembers({ tenantId })
    expect(members.find(m => m.userId === person.id)).toMatchObject({
      email,
      role: 'member',
      source: 'idp',
      blocked: false,
    })

    expect(await provision().removeMembership({ tenantId, userId: person.id })).toBe(true)
    expect(await membership(person.id)).toBeUndefined()
    expect(await provision().removeMembership({ tenantId, userId: person.id })).toBe(false)
  })

  it('leaves manual and owner rows alone', async () => {
    const manual = await createTestUser(db)
    await linkUserToTenant(db, manual.id, tenantId, 'member')
    expect(await provision().removeMembership({ tenantId, userId: manual.id })).toBe(false)
    expect(await membership(manual.id)).toMatchObject({ source: 'manual' })

    const owner = await createTestUser(db)
    await linkUserToTenant(db, owner.id, tenantId, 'owner')
    expect(await provision().setMembership({ tenantId, userId: owner.id, role: 'member' })).toEqual(
      {
        role: 'owner',
        source: 'manual',
      }
    )
  })

  it('refuses a tenant or a person that does not exist', async () => {
    const someone = await createTestUser(db)
    const missing = crypto.randomUUID()
    await expect(
      provision().setMembership({ tenantId: missing, userId: someone.id, role: 'member' })
    ).rejects.toMatchObject({ statusCode: 404 })
    await expect(
      provision().setMembership({ tenantId, userId: missing, role: 'member' })
    ).rejects.toMatchObject({ statusCode: 404 })
    await expect(provision().listMembers({ tenantId: missing })).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})

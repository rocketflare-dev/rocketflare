/**
 * What a plugin's identity provider may do to an account, whichever comes first: the person
 * signing up, or the provider asserting their address. A per-tenant IdP speaks for one
 * organisation; it never gets a platform role and never holds an address it has not proved.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { admitUser } from '@/api/services/auth'
import { createRouter } from '@/api/utils/routes/router'
import { loadConfig } from '@/config'
import { oauthProviders, tenants, users } from '@/db/schema'
import { identityFor, type PluginSignInInput, provisionFor } from '@/plugins/api'
import { createTestTenant, createTestUser, uniqueId } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const PLUGIN = 'acme-sso'
const bootstrapEmail = `operator_${uniqueId().toLowerCase()}@example.test`
const env = createTestEnv({
  APP_ENV: 'production',
  APP_URL: 'https://app.example',
  BOOTSTRAP_ADMIN_EMAILS: bootstrapEmail,
})
const config = loadConfig(env)
const logger = { debug() {}, info() {}, warn() {}, error() {} }

const fixture = createRouter()
fixture.use('*', async (c, next) => {
  c.set('db', db as never)
  c.set('config', config)
  c.set('logger', logger as never)
  await next()
})
fixture.get('/callback', c =>
  identityFor(c, PLUGIN).signIn(JSON.parse(c.req.query('a') ?? '{}') as PluginSignInInput)
)

async function signIn(assertion: PluginSignInInput) {
  const res = await request(
    `/callback?${new URLSearchParams({ a: JSON.stringify(assertion) })}`,
    {},
    { env, app: fixture }
  )
  return {
    status: res.status,
    location: res.headers.get('location') ?? '',
    cookie: res.headers.get('set-cookie') ?? '',
  }
}

const provision = () => provisionFor({ db, config, logger, env } as never, PLUGIN)
const freshEmail = () => `person_${uniqueId().toLowerCase()}@example.test`

describe('an IdP asserting a BOOTSTRAP_ADMIN_EMAILS address', () => {
  it('signIn refuses a new listed address and creates nothing', async () => {
    const res = await signIn({
      subject: `c|${uniqueId()}`,
      email: bootstrapEmail,
      emailVerified: true,
      linkByEmail: true,
    })
    expect(res.status).toBe(302)
    expect(res.location).toContain('error=account_exists')
    expect(res.cookie).not.toContain('__Host-session')
    expect(
      await db.query.users.findFirst({ where: eq(users.email, bootstrapEmail) })
    ).toBeUndefined()
  })

  it('upsertUser refuses a new listed address and creates nothing', async () => {
    await expect(
      provision().upsertUser({
        subject: `c|${uniqueId()}`,
        email: bootstrapEmail,
        emailVerified: true,
        linkByEmail: true,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'account_exists' })
    expect(
      await db.query.users.findFirst({ where: eq(users.email, bootstrapEmail) })
    ).toBeUndefined()
  })

  it('signIn cannot link or promote an existing account on a listed address', async () => {
    const email = `operator_${uniqueId().toLowerCase()}@example.test`
    const listed = createTestEnv({
      APP_ENV: 'production',
      APP_URL: 'https://app.example',
      BOOTSTRAP_ADMIN_EMAILS: email,
    })
    const cfg = loadConfig(listed)
    const app = createRouter()
    app.use('*', async (c, next) => {
      c.set('db', db as never)
      c.set('config', cfg)
      c.set('logger', logger as never)
      await next()
    })
    app.get('/cb', c =>
      identityFor(c, PLUGIN).signIn({
        subject: `c|${email}`,
        email,
        emailVerified: true,
        linkByEmail: true,
      })
    )
    const user = await createTestUser(db, { email })
    const res = await request('/cb', {}, { env: listed, app })
    expect(res.headers.get('location')).toContain('error=account_exists')
    const row = await db.query.users.findFirst({ where: eq(users.id, user.id) })
    expect(row?.isGlobalAdmin).toBe(false)
    expect(
      await db.query.oauthProviders.findFirst({ where: eq(oauthProviders.userId, user.id) })
    ).toBeUndefined()
  })

  it('admitUser promotes only on a kit proof', async () => {
    const email = `operator_${uniqueId().toLowerCase()}@example.test`
    const cfg = loadConfig(createTestEnv({ BOOTSTRAP_ADMIN_EMAILS: email }))
    const viaPlugin = await admitUser(
      db,
      cfg,
      { email, verified: true, admittedBy: 'idp', proof: 'plugin' },
      logger as never
    )
    expect(viaPlugin).toMatchObject({ ok: true })
    if (!viaPlugin.ok) return
    expect(viaPlugin.user.isGlobalAdmin).toBe(false)
    const viaKit = await admitUser(
      db,
      cfg,
      { email, verified: true, proof: 'kit' },
      logger as never
    )
    expect(viaKit).toMatchObject({ ok: true })
    if (!viaKit.ok) return
    expect(viaKit.user.isGlobalAdmin).toBe(true)
  })
})

describe('an IdP asserting an address whose domain it has not proved', () => {
  it('signIn refuses a new account, with the same code as an existing one', async () => {
    const tenant = await createTestTenant(db)
    const fresh = freshEmail()
    const res = await signIn({
      subject: `c|${uniqueId()}`,
      email: fresh,
      emailVerified: true,
      tenantId: tenant.id,
      role: 'member',
    })
    expect(res.location).toContain('error=account_exists')
    expect(res.cookie).not.toContain('__Host-session')
    expect(await db.query.users.findFirst({ where: eq(users.email, fresh) })).toBeUndefined()

    const existing = await createTestUser(db, { email: freshEmail() })
    const again = await signIn({
      subject: `c|${uniqueId()}`,
      email: existing.email,
      emailVerified: true,
      tenantId: tenant.id,
      role: 'member',
    })
    expect(again.location).toContain('error=account_exists')
  })

  it('upsertUser refuses a new account, with the same code as an existing one', async () => {
    const fresh = freshEmail()
    await expect(
      provision().upsertUser({ subject: `c|${uniqueId()}`, email: fresh, emailVerified: true })
    ).rejects.toMatchObject({ statusCode: 409, code: 'account_exists' })
    expect(await db.query.users.findFirst({ where: eq(users.email, fresh) })).toBeUndefined()

    const existing = await createTestUser(db, { email: freshEmail() })
    await expect(
      provision().upsertUser({
        subject: `c|${uniqueId()}`,
        email: existing.email,
        emailVerified: true,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'account_exists' })
  })

  it('a proved domain still creates and links', async () => {
    const tenant = await createTestTenant(db)
    const email = freshEmail()
    const res = await signIn({
      subject: `c|${uniqueId()}`,
      email,
      emailVerified: true,
      linkByEmail: true,
      tenantId: tenant.id,
      role: 'member',
    })
    expect(res.status).toBe(302)
    expect(res.cookie).toContain('__Host-session')
    expect(await db.query.users.findFirst({ where: eq(users.email, email) })).toBeDefined()
  })
})

describe('a suspended tenant through the identity seam', () => {
  async function suspended() {
    const tenant = await createTestTenant(db)
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, tenant.id))
    return tenant
  }

  it('provision refuses every tenant-taking method', async () => {
    const tenant = await suspended()
    const user = await createTestUser(db)
    const tenantRefused = { statusCode: 403, code: 'tenant_suspended' }
    await expect(
      provision().setMembership({ tenantId: tenant.id, userId: user.id, role: 'member' })
    ).rejects.toMatchObject(tenantRefused)
    await expect(
      provision().removeMembership({ tenantId: tenant.id, userId: user.id })
    ).rejects.toMatchObject(tenantRefused)
    await expect(
      provision().deprovision({ tenantId: tenant.id, userId: user.id })
    ).rejects.toMatchObject(tenantRefused)
    await expect(provision().listMembers({ tenantId: tenant.id })).rejects.toMatchObject(
      tenantRefused
    )
  })

  it('signIn into a suspended tenant writes nothing and mints no session', async () => {
    const tenant = await suspended()
    const email = freshEmail()
    const res = await signIn({
      subject: `c|${uniqueId()}`,
      email,
      emailVerified: true,
      linkByEmail: true,
      tenantId: tenant.id,
      role: 'member',
    })
    expect(res.location).toContain('error=no_access')
    expect(res.cookie).not.toContain('__Host-session')
    expect(await db.query.users.findFirst({ where: eq(users.email, email) })).toBeUndefined()
  })
})

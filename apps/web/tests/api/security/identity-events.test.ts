/**
 * Identity events act on the person the issuer names: a suspension ends the global-admin role the
 * issuer granted (and only that one), and the email fallback never reaches an account linked to a
 * different subject at the issuer.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { oauthProviders, tenantUsers, users } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  createTestUser,
  sessionCookieHeader,
  uniqueId,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const ISSUER = 'https://idp.test/realms/acme'
const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`

const eventsEnv = () =>
  createTestEnv({
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: 'dummy-oidc-secret',
    OIDC_MANAGED_TENANCY: 'true',
    IDENTITY_WEBHOOK_SECRET: SECRET,
  } as never)

async function sign(id: string, ts: number, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(SECRET.slice('whsec_'.length), 'base64'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`))
  return `v1,${Buffer.from(mac).toString('base64')}`
}

async function postEvent(
  env: ReturnType<typeof eventsEnv>,
  type: string,
  data: Record<string, unknown>
) {
  const id = `evt_${uniqueId()}`
  const body = JSON.stringify({ id, type, occurredAt: new Date().toISOString(), data })
  const ts = Math.floor(Date.now() / 1000)
  return request(
    '/api/identity/events',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(ts),
        'webhook-signature': await sign(id, ts, body),
      },
      body,
    },
    { env }
  )
}

async function seatedPerson(opts: { sub?: string } = {}) {
  const user = await createTestUser(db)
  if (opts.sub) {
    await db
      .insert(oauthProviders)
      .values({ userId: user.id, provider: 'oidc', providerUserId: `${ISSUER}|${opts.sub}` })
  }
  const earlier = new Date(Date.now() - 10 * 60_000)
  const orgId = `org-${uniqueId().toLowerCase()}`
  const tenant = await createTestTenant(db, { externalOrgId: orgId, idpSyncedAt: earlier })
  await db.insert(tenantUsers).values({
    tenantId: tenant.id,
    userId: user.id,
    role: 'member',
    source: 'idp',
    idpSyncedAt: earlier,
  })
  const token = await createTestSession(db, user.id, tenant.id)
  return { user, tenant, token, orgId }
}

async function membership(tenantId: string, userId: string) {
  return db.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)),
  })
}

describe('person.suspended and the global-admin role', () => {
  it('ends the role the issuer granted', async () => {
    const env = eventsEnv()
    const admin = await createTestGlobalAdmin(db)
    await db.update(users).set({ globalAdminSource: 'idp' }).where(eq(users.id, admin.id))

    const res = await postEvent(env, 'person.suspended', { personId: 'p', email: admin.email })
    expect(res.status).toBe(204)

    const row = await db.query.users.findFirst({ where: eq(users.id, admin.id) })
    expect(row).toMatchObject({ isGlobalAdmin: false, globalAdminSource: null })
    const later = await createTestSession(db, admin.id)
    const admins = await request(
      '/api/admin/users',
      { headers: sessionCookieHeader(later) },
      { env }
    )
    expect(admins.status).toBe(403)
  })

  it('leaves a manual grant in place', async () => {
    const env = eventsEnv()
    const admin = await createTestGlobalAdmin(db)
    await db.update(users).set({ globalAdminSource: 'manual' }).where(eq(users.id, admin.id))

    await postEvent(env, 'person.suspended', { personId: 'p', email: admin.email })

    const row = await db.query.users.findFirst({ where: eq(users.id, admin.id) })
    expect(row).toMatchObject({ isGlobalAdmin: true, globalAdminSource: 'manual' })
  })
})

describe('which person an event names', () => {
  it('a sub with no link does not reach an account linked to another subject by email', async () => {
    const env = eventsEnv()
    const { user, tenant, token } = await seatedPerson({ sub: `sub_a_${uniqueId()}` })
    const res = await postEvent(env, 'person.suspended', {
      personId: 'p',
      email: user.email.toUpperCase(),
      sub: `sub_b_${uniqueId()}`,
    })
    expect(res.status).toBe(204)
    const session = await request('/auth/session', { headers: sessionCookieHeader(token) }, { env })
    expect(session.status).toBe(200)
    expect(await membership(tenant.id, user.id)).toBeDefined()
  })

  it('a sub with no link still reaches, by email, an account the issuer has never seen', async () => {
    const env = eventsEnv()
    const { user, tenant, orgId } = await seatedPerson()
    const res = await postEvent(env, 'membership.removed', {
      personId: 'p',
      email: user.email,
      sub: `sub_new_${uniqueId()}`,
      orgId,
    })
    expect(res.status).toBe(204)
    expect(await membership(tenant.id, user.id)).toBeUndefined()
  })

  it('an event with no sub is matched by email, even on a linked account', async () => {
    const env = eventsEnv()
    const { user, tenant, orgId } = await seatedPerson({ sub: `sub_c_${uniqueId()}` })
    const res = await postEvent(env, 'membership.removed', {
      personId: 'p',
      email: user.email,
      orgId,
    })
    expect(res.status).toBe(204)
    expect(await membership(tenant.id, user.id)).toBeUndefined()
  })

  it('the linked sub wins over a different email', async () => {
    const env = eventsEnv()
    const sub = `sub_d_${uniqueId()}`
    const { user, tenant, orgId } = await seatedPerson({ sub })
    await postEvent(env, 'membership.removed', {
      personId: 'p',
      email: 'someone-else@example.test',
      sub,
      orgId,
    })
    expect(await membership(tenant.id, user.id)).toBeUndefined()
  })
})

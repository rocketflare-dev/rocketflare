/**
 * Who may found an organisation: not a person whose access request is pending or rejected, nobody
 * under IdP-managed tenancy (nor rename one, since the issuer's slug names the tenant it links),
 * and nobody past the ceiling of organisations one person may own.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTenantForUser } from '@/api/utils/db/tenant-helpers'
import { accessRequests, tenants, tenantUsers } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv, stubs } from '../../mocks/bindings'

const db = setupTestDatabase()
const slugId = () =>
  uniqueId()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

const managedEnv = () =>
  createTestEnv({
    OIDC_ISSUER: 'https://idp.example',
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: 'dummy-oidc-secret',
    OIDC_MANAGED_TENANCY: 'true',
  } as never)

const create = (
  cookie: Record<string, string>,
  env: ReturnType<typeof createTestEnv>,
  slug?: string
) =>
  request(
    '/api/tenants',
    { method: 'POST', headers: cookie },
    { env, json: { name: `Org ${uniqueId()}`, ...(slug ? { slug } : {}) } }
  )

async function ownedBy(userId: string) {
  return db
    .select({ tenantId: tenantUsers.tenantId })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.userId, userId), eq(tenantUsers.role, 'owner')))
}

describe('POST /api/tenants and the access request', () => {
  async function requester(status: 'pending' | 'rejected') {
    const user = await createTestUser(db)
    await db.insert(accessRequests).values({ email: user.email, userId: user.id, status })
    return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id)) }
  }

  it.each(['pending', 'rejected'] as const)(
    'a %s person cannot found an organisation',
    async status => {
      const { user, cookie } = await requester(status)
      const res = await create(cookie, createTestEnv({ SIGNUP_MODE: 'approval' }))
      expect(res.status).toBe(403)
      expect((await json<{ code: string }>(res)).code).toBe('pending_approval')
      expect(await ownedBy(user.id)).toEqual([])
    }
  )

  it('a member still founds another organisation, and a person with no request their first', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    expect((await create(cookie, createTestEnv())).status).toBe(201)

    const fresh = await createTestUser(db)
    const freshCookie = sessionCookieHeader(await createTestSession(db, fresh.id))
    expect((await create(freshCookie, createTestEnv())).status).toBe(201)
  })

  it('a global admin with no membership is not held by an access request', async () => {
    const admin = await createTestGlobalAdmin(db)
    await db
      .insert(accessRequests)
      .values({ email: admin.email, userId: admin.id, status: 'rejected' })
    const cookie = sessionCookieHeader(await createTestSession(db, admin.id))
    expect((await create(cookie, createTestEnv())).status).toBe(201)
  })
})

describe('organisations under IdP-managed tenancy', () => {
  async function owner() {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner', undefined, {
      slug: `managed-${slugId()}`,
    })
    return {
      user,
      tenant,
      cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
    }
  }

  it('POST /api/tenants is refused for everyone', async () => {
    const { user, cookie } = await owner()
    const res = await create(cookie, managedEnv(), `acme-${slugId()}`)
    expect(res.status).toBe(409)
    expect((await json<{ code: string }>(res)).code).toBe('idp_managed')
    expect(await ownedBy(user.id)).toHaveLength(1)

    const admin = await createTestGlobalAdmin(db)
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id))
    expect((await create(adminCookie, managedEnv())).status).toBe(409)
  })

  it('PATCH /api/tenant cannot change the slug; a rename and an unchanged slug still pass', async () => {
    const { tenant, cookie } = await owner()
    const env = managedEnv()
    const patch = (body: Record<string, unknown>) =>
      request('/api/tenant', { method: 'PATCH', headers: cookie }, { env, json: body })

    const refused = await patch({ slug: `acme-${slugId()}` })
    expect(refused.status).toBe(409)
    expect((await json<{ code: string }>(refused)).code).toBe('idp_managed')
    const [row] = await db.select().from(tenants).where(eq(tenants.id, tenant.id))
    expect(row?.slug).toBe(tenant.slug)

    expect((await patch({ name: 'New name' })).status).toBe(200)
    expect((await patch({ slug: tenant.slug })).status).toBe(200)
  })

  it('without managed tenancy an owner still changes the slug', async () => {
    const { cookie } = await owner()
    const slug = `renamed-${slugId()}`
    const res = await request(
      '/api/tenant',
      { method: 'PATCH', headers: cookie },
      { json: { slug } }
    )
    expect(res.status).toBe(200)
  })
})

describe('the ceiling on owned organisations', () => {
  const limited = (max: number) =>
    createTestEnv({ MAX_OWNED_TENANTS_PER_USER: String(max) } as never)

  it('refuses the next organisation once the ceiling is reached', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const env = limited(2)
    expect((await create(cookie, env)).status).toBe(201)
    const refused = await create(cookie, env)
    expect(refused.status).toBe(403)
    expect((await json<{ code: string }>(refused)).code).toBe('tenant_limit_reached')
    expect(await ownedBy(user.id)).toHaveLength(2)
  })

  it('counts only organisations the person owns', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const { tenant: other } = await createTestTenantWithUser(db, 'owner')
    await linkUserToTenant(db, user.id, other.id, 'admin')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    expect((await create(cookie, limited(1))).status).toBe(201)
  })

  it('simultaneous creations cannot pass the ceiling', async () => {
    const user = await createTestUser(db)
    await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        createTenantForUser(db, {
          name: `Org ${uniqueId()}`,
          userId: user.id,
          maxOwnedTenants: 2,
        })
      )
    )
    expect(await ownedBy(user.id)).toHaveLength(2)
  })

  it('does not apply to a global admin', async () => {
    const admin = await createTestGlobalAdmin(db)
    const cookie = sessionCookieHeader(await createTestSession(db, admin.id))
    const env = limited(1)
    expect((await create(cookie, env)).status).toBe(201)
    expect((await create(cookie, env)).status).toBe(201)
  })
})

describe('the ceiling holds wherever ownership is gained', () => {
  const limited = (max: number) =>
    createTestEnv({ MAX_OWNED_TENANTS_PER_USER: String(max) } as never)
  const refusedForLimit = async (res: Response) => {
    expect(res.status).toBe(403)
    expect((await json<{ code: string }>(res)).code).toBe('tenant_limit_reached')
  }

  /** `person` owns one organisation already and is an admin of `tenant`, whose owner is `owner`. */
  async function ownerElsewhere() {
    const { user: owner, tenant } = await createTestTenantWithUser(db, 'owner')
    const ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenant.id))
    const { user: person } = await createTestTenantWithUser(db, 'owner')
    return { owner, tenant, ownerCookie, person }
  }

  it('a promotion to owner is refused for a person already at the ceiling', async () => {
    const { tenant, ownerCookie, person } = await ownerElsewhere()
    await linkUserToTenant(db, person.id, tenant.id, 'admin')
    const res = await request(
      `/api/members/${person.id}`,
      { method: 'PATCH', headers: ownerCookie },
      { env: limited(1), json: { role: 'owner' } }
    )
    await refusedForLimit(res)
    expect(await ownedBy(person.id)).toHaveLength(1)
  })

  it('an owner invitation accepted by a person at the ceiling is refused', async () => {
    const { tenant, ownerCookie, person } = await ownerElsewhere()
    const env = limited(1)
    const sent = await request(
      '/api/invitations',
      { method: 'POST', headers: ownerCookie },
      { env, json: { email: person.email, role: 'owner' } }
    )
    expect(sent.status).toBe(201)
    const message = stubs(env).queue.messages.find(
      m => (m.body as { payload?: { to?: string } }).payload?.to === person.email.toLowerCase()
    )
    if (!message) throw new Error('no invitation email queued')
    const link = (message.body as { payload: { link: string } }).payload.link
    const token = new URL(link).pathname.split('/').pop() as string
    const cookie = sessionCookieHeader(await createTestSession(db, person.id))
    const res = await request(
      `/api/invite/${token}/accept`,
      { method: 'POST', headers: cookie },
      { env }
    )
    await refusedForLimit(res)
    expect(await ownedBy(person.id)).toHaveLength(1)
    const [row] = await db
      .select()
      .from(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, tenant.id), eq(tenantUsers.userId, person.id)))
    expect(row).toBeUndefined()
  })

  it('a person who owns nothing after stepping down may still create one', async () => {
    const { person } = await ownerElsewhere()
    const [own] = await ownedBy(person.id)
    // A second owner, so the person may step down in their own organisation.
    await linkUserToTenant(db, (await createTestUser(db)).id, own?.tenantId as string, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, person.id, own?.tenantId))
    const stepped = await request(
      `/api/members/${person.id}`,
      { method: 'PATCH', headers: cookie },
      { env: limited(1), json: { role: 'admin' } }
    )
    expect(stepped.status).toBe(200)
    expect((await create(cookie, limited(1))).status).toBe(201)
  })

  it('a deleted organisation frees the ceiling but not the day: the second delete-then-create is refused', async () => {
    const env = limited(1)
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const remove = async (tenantId: string, slug: string) => {
      const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenantId))
      const res = await request(
        '/api/tenant',
        { method: 'DELETE', headers: cookie },
        { env, json: { confirm: slug } }
      )
      expect(res.status).toBe(204)
    }
    const cookie = sessionCookieHeader(await createTestSession(db, user.id))

    await remove(tenant.id, tenant.slug)
    const created = await create(cookie, env)
    expect(created.status).toBe(201)
    const next = await json<{ id: string; slug: string }>(created)

    await remove(next.id, next.slug)
    await refusedForLimit(await create(cookie, env))
    expect(await ownedBy(user.id)).toEqual([])
  })
})

describe('the session says whether creating an organisation is allowed', () => {
  const canCreate = async (
    cookie: Record<string, string>,
    env: ReturnType<typeof createTestEnv>
  ) => {
    const res = await request('/auth/session', { headers: cookie }, { env })
    expect(res.status).toBe(200)
    return (await json<{ canCreateTenant: boolean }>(res)).canCreateTenant
  }

  it('true for a member, false under IdP-managed tenancy', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    expect(await canCreate(cookie, createTestEnv())).toBe(true)
    expect(await canCreate(cookie, managedEnv())).toBe(false)
  })

  it('false while an access request is pending or rejected, true for a global admin', async () => {
    for (const status of ['pending', 'rejected'] as const) {
      const user = await createTestUser(db)
      await db.insert(accessRequests).values({ email: user.email, userId: user.id, status })
      const cookie = sessionCookieHeader(await createTestSession(db, user.id))
      expect(await canCreate(cookie, createTestEnv({ SIGNUP_MODE: 'approval' }))).toBe(false)
    }
    const admin = await createTestGlobalAdmin(db)
    await db
      .insert(accessRequests)
      .values({ email: admin.email, userId: admin.id, status: 'rejected' })
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id))
    expect(await canCreate(adminCookie, createTestEnv())).toBe(true)
  })

  it('false in single-tenant mode', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    expect(await canCreate(cookie, createTestEnv({ TENANCY_MODE: 'single' }))).toBe(false)
  })
})

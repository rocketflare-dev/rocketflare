/**
 * Who may issue an invitation, and how long it lasts: only an owner-level actor issues an `owner`
 * invitation, a removed member's pending invitations end with their membership, and an
 * invitation never changes a membership the issuer manages.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { reconcileIdpClaims } from '@/api/services/idp-tenancy'
import { teamInvitations, tenantUsers } from '@/db/schema'
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
const newEmail = () => `invitee_${uniqueId().toLowerCase()}@example.test`
const logger = { info: () => {}, warn: () => {} }

async function tenantWith(role: 'admin' | 'owner' = 'admin') {
  const { user: owner, tenant } = await createTestTenantWithUser(db, 'owner')
  const ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenant.id))
  if (role === 'owner') return { owner, tenant, actor: owner, cookie: ownerCookie, ownerCookie }
  const actor = await createTestUser(db)
  await linkUserToTenant(db, actor.id, tenant.id, 'admin')
  const cookie = sessionCookieHeader(await createTestSession(db, actor.id, tenant.id))
  return { owner, tenant, actor, cookie, ownerCookie }
}

function invite(cookie: Record<string, string>, body: unknown, env = createTestEnv()) {
  return request('/api/invitations', { method: 'POST', headers: cookie }, { json: body, env })
}

function tokenSentTo(env: ReturnType<typeof createTestEnv>, to: string): string {
  const message = stubs(env).queue.messages.find(m => {
    const body = m.body as { type?: string; payload?: { to?: string } }
    return body.type === 'email.send' && body.payload?.to === to
  })
  const link = (message?.body as { payload?: { link?: string } } | undefined)?.payload?.link
  if (!link) throw new Error(`no invitation email queued for ${to}`)
  return new URL(link).pathname.split('/').pop() as string
}

function accept(token: string, cookie: Record<string, string>) {
  return request(`/api/invite/${token}/accept`, { method: 'POST', headers: cookie })
}

async function inviteeCookie(email: string) {
  const invitee = await createTestUser(db, { email })
  return { invitee, cookie: sessionCookieHeader(await createTestSession(db, invitee.id)) }
}

async function membership(tenantId: string, userId: string) {
  return db.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)),
  })
}

async function invitationsTo(tenantId: string, email: string) {
  return db
    .select()
    .from(teamInvitations)
    .where(and(eq(teamInvitations.tenantId, tenantId), eq(teamInvitations.email, email)))
}

describe('the owner role on an invitation', () => {
  it('an admin cannot invite an owner, and no invitation is stored', async () => {
    const { tenant, cookie } = await tenantWith('admin')
    const email = newEmail()
    const res = await invite(cookie, { email, role: 'owner' })
    expect(res.status).toBe(403)
    expect(await invitationsTo(tenant.id, email)).toEqual([])
  })

  it('an admin cannot bulk-invite an owner, and no invitation is stored', async () => {
    const { tenant, cookie } = await tenantWith('admin')
    const email = newEmail()
    const res = await request(
      '/api/invitations/bulk',
      { method: 'POST', headers: cookie },
      { json: { emails: [email], role: 'owner' } }
    )
    expect(res.status).toBe(403)
    expect(await invitationsTo(tenant.id, email)).toEqual([])
  })

  it('an admin cannot resend a stored owner invitation', async () => {
    const { tenant, cookie, ownerCookie } = await tenantWith('admin')
    const email = newEmail()
    const created = await invite(ownerCookie, { email, role: 'owner' })
    expect(created.status).toBe(201)
    const { id } = await json<{ id: string }>(created)
    await db
      .update(teamInvitations)
      .set({ lastSentAt: new Date(Date.now() - 3_600_000) })
      .where(eq(teamInvitations.tenantId, tenant.id))
    const res = await request(`/api/invitations/${id}/resend`, { method: 'POST', headers: cookie })
    expect(res.status).toBe(403)
  })

  it('an admin still invites admins and members', async () => {
    const { cookie } = await tenantWith('admin')
    expect((await invite(cookie, { email: newEmail(), role: 'admin' })).status).toBe(201)
    expect((await invite(cookie, { email: newEmail(), role: 'member' })).status).toBe(201)
  })

  it('an owner and a global admin may invite an owner', async () => {
    const { tenant, ownerCookie } = await tenantWith('owner')
    expect((await invite(ownerCookie, { email: newEmail(), role: 'owner' })).status).toBe(201)

    const admin = await createTestGlobalAdmin(db)
    await linkUserToTenant(db, admin.id, tenant.id, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, admin.id, tenant.id))
    expect((await invite(cookie, { email: newEmail(), role: 'owner' })).status).toBe(201)
  })
})

describe("a removed member's pending invitations", () => {
  it('end with the removal: the invitation can no longer be accepted', async () => {
    const { tenant, actor, cookie, ownerCookie } = await tenantWith('admin')
    const env = createTestEnv()
    const email = newEmail()
    expect((await invite(cookie, { email, role: 'admin' }, env)).status).toBe(201)
    const token = tokenSentTo(env, email)

    const removed = await request(`/api/members/${actor.id}`, {
      method: 'DELETE',
      headers: ownerCookie,
    })
    expect(removed.status).toBe(204)

    const { invitee, cookie: signedIn } = await inviteeCookie(email)
    const res = await accept(token, signedIn)
    expect(res.status).toBe(410)
    expect((await json<{ code: string }>(res)).code).toBe('invitation_revoked')
    expect(await membership(tenant.id, invitee.id)).toBeUndefined()
  })

  it('other members’ invitations are not touched', async () => {
    const { tenant, actor, ownerCookie } = await tenantWith('admin')
    const env = createTestEnv()
    const email = newEmail()
    expect((await invite(ownerCookie, { email }, env)).status).toBe(201)
    const token = tokenSentTo(env, email)
    await request(`/api/members/${actor.id}`, { method: 'DELETE', headers: ownerCookie })
    const { invitee, cookie } = await inviteeCookie(email)
    expect((await accept(token, cookie)).status).toBe(200)
    expect(await membership(tenant.id, invitee.id)).toMatchObject({ role: 'member' })
  })

  it('an inviter who loses an issuer-managed seat has their invitations end too', async () => {
    const { tenant } = await tenantWith('owner')
    const inviter = await createTestUser(db)
    await db.insert(tenantUsers).values({
      tenantId: tenant.id,
      userId: inviter.id,
      role: 'admin',
      source: 'idp',
    })
    const cookie = sessionCookieHeader(await createTestSession(db, inviter.id, tenant.id))
    const env = createTestEnv()
    const email = newEmail()
    expect((await invite(cookie, { email }, env)).status).toBe(201)
    const token = tokenSentTo(env, email)

    await reconcileIdpClaims(
      db,
      inviter,
      { orgs: [], admit: false, globalAdmin: false, issuedAt: new Date() },
      logger
    )

    const { invitee, cookie: signedIn } = await inviteeCookie(email)
    expect((await accept(token, signedIn)).status).toBe(410)
    expect(await membership(tenant.id, invitee.id)).toBeUndefined()
  })

  it('a global admin inviter keeps their invitations when removed from the tenant', async () => {
    const { tenant, ownerCookie } = await tenantWith('owner')
    const admin = await createTestGlobalAdmin(db)
    await linkUserToTenant(db, admin.id, tenant.id, 'admin')
    const cookie = sessionCookieHeader(await createTestSession(db, admin.id, tenant.id))
    const env = createTestEnv()
    const email = newEmail()
    expect((await invite(cookie, { email }, env)).status).toBe(201)
    const token = tokenSentTo(env, email)

    await request(`/api/members/${admin.id}`, { method: 'DELETE', headers: ownerCookie })

    const { invitee, cookie: signedIn } = await inviteeCookie(email)
    expect((await accept(token, signedIn)).status).toBe(200)
    expect(await membership(tenant.id, invitee.id)).toBeDefined()
  })

  it('an invitation issued from support mode survives leaving support', async () => {
    const { tenant } = await tenantWith('owner')
    const admin = await createTestGlobalAdmin(db)
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id))
    const entered = await request(`/api/admin/tenants/${tenant.id}/support/enter`, {
      method: 'POST',
      headers: adminCookie,
    })
    expect(entered.status).toBeLessThan(300)
    const env = createTestEnv()
    const email = newEmail()
    expect((await invite(adminCookie, { email }, env)).status).toBe(201)
    const token = tokenSentTo(env, email)

    const left = await request(`/api/admin/tenants/${tenant.id}/support/leave`, {
      method: 'POST',
      headers: adminCookie,
    })
    expect(left.status).toBeLessThan(300)

    const { cookie: signedIn } = await inviteeCookie(email)
    expect((await accept(token, signedIn)).status).toBe(200)
  })
})

describe('accepting an invitation over an issuer-managed membership', () => {
  async function seated(invitedRole: 'admin' | 'owner') {
    const { tenant, ownerCookie } = await tenantWith('owner')
    const env = createTestEnv()
    const email = newEmail()
    expect((await invite(ownerCookie, { email, role: invitedRole }, env)).status).toBe(201)
    const token = tokenSentTo(env, email)
    const invitee = await createTestUser(db, { email })
    await db
      .insert(tenantUsers)
      .values({ tenantId: tenant.id, userId: invitee.id, role: 'member', source: 'idp' })
    const cookie = sessionCookieHeader(await createTestSession(db, invitee.id))
    return { tenant, invitee, token, cookie }
  }

  it.each(['admin', 'owner'] as const)(
    'an %s invitation leaves the idp role as it is',
    async role => {
      const { tenant, invitee, token, cookie } = await seated(role)
      expect((await accept(token, cookie)).status).toBe(200)
      expect(await membership(tenant.id, invitee.id)).toMatchObject({
        role: 'member',
        source: 'idp',
      })
      const [row] = await invitationsTo(tenant.id, invitee.email)
      expect(row?.acceptedAt).toBeInstanceOf(Date)
    }
  )

  it('a manual member is still upgraded by an invitation to a higher role', async () => {
    const { tenant, ownerCookie } = await tenantWith('owner')
    const env = createTestEnv()
    const email = newEmail()
    expect((await invite(ownerCookie, { email, role: 'admin' }, env)).status).toBe(201)
    const token = tokenSentTo(env, email)
    const invitee = await createTestUser(db, { email })
    await linkUserToTenant(db, invitee.id, tenant.id, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, invitee.id))
    expect((await accept(token, cookie)).status).toBe(200)
    expect(await membership(tenant.id, invitee.id)).toMatchObject({ role: 'admin' })
  })
})

/**
 * Who may issue an invitation, and how long it lasts: only an owner-level actor issues an `owner`
 * invitation, a removed member's pending invitations end with their membership, and an
 * invitation never changes a membership the issuer manages.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { reconcileIdpClaims } from '@/api/services/idp-tenancy'
import { teamInvitations, tenantUsers, users } from '@/db/schema'
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

describe('an invitation carries only the authority its issuer still holds', () => {
  const changeRole = (cookie: Record<string, string>, userId: string, role: string) =>
    request(`/api/members/${userId}`, { method: 'PATCH', headers: cookie }, { json: { role } })

  /** An owner `issuer` beside the tenant's first owner, with one pending invitation per role. */
  async function ownerWithInvitations() {
    const { tenant, ownerCookie } = await tenantWith('owner')
    const issuer = await createTestUser(db)
    await linkUserToTenant(db, issuer.id, tenant.id, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, issuer.id, tenant.id))
    const env = createTestEnv()
    const sent: Record<'owner' | 'admin' | 'member', string> = {
      owner: newEmail(),
      admin: newEmail(),
      member: newEmail(),
    }
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect((await invite(cookie, { email: sent[role], role }, env)).status).toBe(201)
    }
    return { tenant, issuer, ownerCookie, env, sent }
  }

  async function revoked(tenantId: string, email: string) {
    const [row] = await invitationsTo(tenantId, email)
    return row?.revokedAt instanceof Date
  }

  it('an owner stepped down to admin keeps admin and member invitations; owner ones end', async () => {
    const { tenant, issuer, ownerCookie, env, sent } = await ownerWithInvitations()
    expect((await changeRole(ownerCookie, issuer.id, 'admin')).status).toBe(200)
    expect(await revoked(tenant.id, sent.owner)).toBe(true)
    expect(await revoked(tenant.id, sent.admin)).toBe(false)
    expect(await revoked(tenant.id, sent.member)).toBe(false)

    const { cookie } = await inviteeCookie(sent.admin)
    expect((await accept(tokenSentTo(env, sent.admin), cookie)).status).toBe(200)
    const { cookie: ownerInvitee } = await inviteeCookie(sent.owner)
    const res = await accept(tokenSentTo(env, sent.owner), ownerInvitee)
    expect(res.status).toBe(410)
    expect((await json<{ code: string }>(res)).code).toBe('invitation_revoked')
  })

  it('an owner stepped down to member has every invitation end', async () => {
    const { tenant, issuer, ownerCookie, sent } = await ownerWithInvitations()
    expect((await changeRole(ownerCookie, issuer.id, 'member')).status).toBe(200)
    for (const email of Object.values(sent)) expect(await revoked(tenant.id, email)).toBe(true)
  })

  it('a blocked issuer’s invitation is refused at accept, and the row is marked revoked', async () => {
    const { tenant, actor, cookie } = await tenantWith('admin')
    const env = createTestEnv()
    const email = newEmail()
    expect((await invite(cookie, { email, role: 'member' }, env)).status).toBe(201)
    await db.update(users).set({ blockedAt: new Date() }).where(eq(users.id, actor.id))

    const { invitee, cookie: signedIn } = await inviteeCookie(email)
    const res = await accept(tokenSentTo(env, email), signedIn)
    expect(res.status).toBe(410)
    expect((await json<{ code: string }>(res)).code).toBe('invitation_revoked')
    expect(await membership(tenant.id, invitee.id)).toBeUndefined()
    expect(await revoked(tenant.id, email)).toBe(true)
  })

  it('a demoted global admin’s invitation is refused at accept, and the row is marked revoked', async () => {
    const { tenant } = await tenantWith('owner')
    const admin = await createTestGlobalAdmin(db)
    await createTestGlobalAdmin(db) // the last global admin cannot be demoted
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id))
    await request(`/api/admin/tenants/${tenant.id}/support/enter`, {
      method: 'POST',
      headers: adminCookie,
    })
    const env = createTestEnv()
    const email = newEmail()
    expect((await invite(adminCookie, { email, role: 'owner' }, env)).status).toBe(201)
    await request(`/api/admin/tenants/${tenant.id}/support/leave`, {
      method: 'POST',
      headers: adminCookie,
    })
    await db.update(users).set({ isGlobalAdmin: false }).where(eq(users.id, admin.id))

    const { invitee, cookie: signedIn } = await inviteeCookie(email)
    const res = await accept(tokenSentTo(env, email), signedIn)
    expect(res.status).toBe(410)
    expect((await json<{ code: string }>(res)).code).toBe('invitation_revoked')
    expect(await membership(tenant.id, invitee.id)).toBeUndefined()
    expect(await revoked(tenant.id, email)).toBe(true)
  })

  it('an admin demoted to member after inviting: the invitation is refused even if it was missed', async () => {
    const { tenant, actor, cookie } = await tenantWith('admin')
    const env = createTestEnv()
    const email = newEmail()
    expect((await invite(cookie, { email, role: 'admin' }, env)).status).toBe(201)
    // A role change made outside changeMemberRole (the issuer's own claims, say).
    await db
      .update(tenantUsers)
      .set({ role: 'member' })
      .where(and(eq(tenantUsers.tenantId, tenant.id), eq(tenantUsers.userId, actor.id)))
    const { cookie: signedIn } = await inviteeCookie(email)
    expect((await accept(tokenSentTo(env, email), signedIn)).status).toBe(410)
    expect(await revoked(tenant.id, email)).toBe(true)
  })
})

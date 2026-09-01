/**
 * Invitations end to end (D9, D12): create / bulk / resend / revoke, public details, transactional
 * accept (email must match; never demotes), pending list across tenants, prune.
 */
import type { SessionResponse } from '@gmgo/shared/auth'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { requestMagicLink } from '@/api/routes/auth/magic-link'
import { createInvitation } from '@/api/services/invitations'
import { loadConfig } from '@/config'
import { notifications, teamInvitations, tenantUsers } from '@/db/schema'
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
import { createTestEnv, RecordingQueue } from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const jobs = new RecordingQueue()

async function tenantWithOwner() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  return {
    owner: user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

const newEmail = () => `inv_${uniqueId().toLowerCase()}@example.test`

describe('POST /api/invitations', () => {
  it('owner/admin create; member 403; returns invitationSchema shape', async () => {
    const { tenant, cookie, owner } = await tenantWithOwner()
    const email = newEmail()
    const res = await request(
      '/api/invitations',
      { method: 'POST', headers: cookie },
      { json: { email, role: 'admin' } }
    )
    expect(res.status).toBe(201)
    const body = await json<{
      id: string
      email: string
      role: string
      status: string
      invitedByName: string
      tenantId: string
    }>(res)
    expect(body).toMatchObject({
      email,
      role: 'admin',
      status: 'pending',
      invitedByName: owner.name,
      tenantId: tenant.id,
    })
    expect(body).not.toHaveProperty('tokenHash')

    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, tenant.id, 'member')
    const denied = await request(
      '/api/invitations',
      {
        method: 'POST',
        headers: sessionCookieHeader(await createTestSession(db, member.id, tenant.id)),
      },
      { json: { email: newEmail() } }
    )
    expect(denied.status).toBe(403)
  })

  it('409 already_invited / already_member; 400 for role support', async () => {
    const { tenant, cookie, owner } = await tenantWithOwner()
    const email = newEmail()
    await request('/api/invitations', { method: 'POST', headers: cookie }, { json: { email } })
    const dup = await request(
      '/api/invitations',
      { method: 'POST', headers: cookie },
      { json: { email } }
    )
    expect(dup.status).toBe(409)
    expect(await json(dup)).toMatchObject({ code: 'already_invited' })
    const asMember = await request(
      '/api/invitations',
      { method: 'POST', headers: cookie },
      { json: { email: owner.email } }
    )
    expect(asMember.status).toBe(409)
    expect(await json(asMember)).toMatchObject({ code: 'already_member' })
    const bad = await request(
      '/api/invitations',
      { method: 'POST', headers: cookie },
      { json: { email: newEmail(), role: 'support' } }
    )
    expect(bad.status).toBe(400)
    expect(tenant.id).toBeTruthy()
  })

  it('GET lists pending only and is tenant-scoped', async () => {
    const a = await tenantWithOwner()
    const b = await tenantWithOwner()
    const email = newEmail()
    await request('/api/invitations', { method: 'POST', headers: a.cookie }, { json: { email } })
    const listA = await json<{ items: Array<{ email: string }> }>(
      await request('/api/invitations', { headers: a.cookie })
    )
    const listB = await json<{ items: Array<{ email: string }> }>(
      await request('/api/invitations', { headers: b.cookie })
    )
    expect(listA.items.map(i => i.email)).toContain(email)
    expect(listB.items.map(i => i.email)).not.toContain(email)
  })
})

describe('bulk / resend / revoke', () => {
  it('POST /bulk reports per-address outcomes', async () => {
    const { cookie, owner } = await tenantWithOwner()
    const e1 = newEmail()
    const e2 = newEmail()
    const res = await request(
      '/api/invitations/bulk',
      { method: 'POST', headers: cookie },
      { json: { emails: [e1, e2, e1.toUpperCase(), owner.email], role: 'member' } }
    )
    expect(res.status).toBe(200)
    const { results } = await json<{
      results: Array<{ email: string; status: string; reason?: string }>
    }>(res)
    expect(
      results
        .filter(r => r.status === 'invited')
        .map(r => r.email)
        .sort()
    ).toEqual([e1, e2].sort())
    expect(results.find(r => r.email === e1 && r.status === 'skipped')?.reason).toBe('duplicate')
    expect(results.find(r => r.email === owner.email)).toMatchObject({
      status: 'skipped',
      reason: 'already_member',
    })
  })

  it('resend rotates the token (old link dies) and revoke removes it from the list', async () => {
    const { tenant, cookie, owner } = await tenantWithOwner()
    const { invitation, token } = await createInvitation(db, cfg, logger, jobs, {
      tenantId: tenant.id,
      email: newEmail(),
      role: 'member',
      inviter: owner,
    })
    expect((await request(`/api/invite/${token}`)).status).toBe(200)
    const resent = await request(`/api/invitations/${invitation.id}/resend`, {
      method: 'POST',
      headers: cookie,
    })
    expect(resent.status).toBe(200)
    expect((await request(`/api/invite/${token}`)).status).toBe(404)
    const revoked = await request(`/api/invitations/${invitation.id}`, {
      method: 'DELETE',
      headers: cookie,
    })
    expect(revoked.status).toBe(204)
    const list = await json<{ items: Array<{ id: string }> }>(
      await request('/api/invitations', { headers: cookie })
    )
    expect(list.items.map(i => i.id)).not.toContain(invitation.id)
    expect(
      (
        await request(`/api/invitations/${invitation.id}/resend`, {
          method: 'POST',
          headers: cookie,
        })
      ).status
    ).toBe(409)
    // a different tenant's owner cannot revoke it
    const other = await tenantWithOwner()
    expect(
      (
        await request(`/api/invitations/${invitation.id}`, {
          method: 'DELETE',
          headers: other.cookie,
        })
      ).status
    ).toBe(404)
  })
})

describe('public GET /api/invite/:token', () => {
  it('returns invitationDetailsSchema fields and nothing sensitive', async () => {
    const { tenant, owner } = await tenantWithOwner()
    const email = newEmail()
    const { token } = await createInvitation(db, cfg, logger, jobs, {
      tenantId: tenant.id,
      email,
      role: 'admin',
      inviter: owner,
    })
    const res = await request(`/api/invite/${token}`)
    expect(res.status).toBe(200)
    const body = await json<Record<string, unknown>>(res)
    expect(body).toMatchObject({
      email,
      role: 'admin',
      status: 'pending',
      tenant: { name: tenant.name, slug: tenant.slug },
      invitedByName: owner.name,
    })
    expect(body).not.toHaveProperty('id')
    expect(body).not.toHaveProperty('tenantId')
  })

  it('404 for an unknown token; expired shows status expired', async () => {
    expect((await request('/api/invite/nope')).status).toBe(404)
    const { tenant, owner } = await tenantWithOwner()
    const { invitation, token } = await createInvitation(db, cfg, logger, jobs, {
      tenantId: tenant.id,
      email: newEmail(),
      role: 'member',
      inviter: owner,
    })
    await db
      .update(teamInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(teamInvitations.id, invitation.id))
    expect((await json<{ status: string }>(await request(`/api/invite/${token}`))).status).toBe(
      'expired'
    )
  })
})

describe('POST /api/invite/:token/accept', () => {
  it('401 without a cookie', async () => {
    const { tenant, owner } = await tenantWithOwner()
    const { token } = await createInvitation(db, cfg, logger, jobs, {
      tenantId: tenant.id,
      email: newEmail(),
      role: 'member',
      inviter: owner,
    })
    expect((await request(`/api/invite/${token}/accept`, { method: 'POST' })).status).toBe(401)
  })

  it('accepts transactionally: membership, acceptedAt, session selects the tenant, inviter notified', async () => {
    const { tenant, owner } = await tenantWithOwner()
    const email = newEmail()
    const { invitation, token } = await createInvitation(db, cfg, logger, jobs, {
      tenantId: tenant.id,
      email,
      role: 'admin',
      inviter: owner,
    })
    const invitee = await createTestUser(db, { email })
    const cookie = sessionCookieHeader(await createTestSession(db, invitee.id))
    const res = await request(`/api/invite/${token}/accept`, { method: 'POST', headers: cookie })
    expect(res.status).toBe(200)
    const body = await json<SessionResponse>(res)
    expect(body.tenant).toMatchObject({ id: tenant.id, role: 'admin' })
    const [row] = await db
      .select()
      .from(teamInvitations)
      .where(eq(teamInvitations.id, invitation.id))
    expect(row?.acceptedAt).not.toBeNull()
    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenant.id), eq(notifications.userId, owner.id)))
    expect(notes.some(n => n.type === 'invitation_accepted')).toBe(true)
    // second accept → 410
    const again = await request(`/api/invite/${token}/accept`, { method: 'POST', headers: cookie })
    expect(again.status).toBe(410)
    expect(await json(again)).toMatchObject({ code: 'invitation_accepted' })
  })

  it('403 invitation_email_mismatch when the session email differs', async () => {
    const { tenant, owner } = await tenantWithOwner()
    const { token } = await createInvitation(db, cfg, logger, jobs, {
      tenantId: tenant.id,
      email: newEmail(),
      role: 'member',
      inviter: owner,
    })
    const stranger = await createTestUser(db)
    const res = await request(`/api/invite/${token}/accept`, {
      method: 'POST',
      headers: sessionCookieHeader(await createTestSession(db, stranger.id)),
    })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: 'invitation_email_mismatch' })
  })

  it('never demotes: an existing owner accepting a member invitation stays owner', async () => {
    const { tenant, owner } = await tenantWithOwner()
    const second = await createTestUser(db)
    await linkUserToTenant(db, second.id, tenant.id, 'owner')
    // an invitation for a member who is already an owner cannot be created via the API (409), so insert directly
    const { hashToken } = await import('@/api/utils/core/hash')
    const { randomToken } = await import('@/api/utils/core/ids')
    const token = randomToken(32)
    await db.insert(teamInvitations).values({
      tenantId: tenant.id,
      email: second.email,
      role: 'member',
      tokenHash: await hashToken(token),
      invitedByUserId: owner.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    // the partial unique index means we must not have another pending row — fine, fresh tenant
    const res = await request(`/api/invite/${token}/accept`, {
      method: 'POST',
      headers: sessionCookieHeader(await createTestSession(db, second.id, tenant.id)),
    })
    expect(res.status).toBe(200)
    const [m] = await db
      .select()
      .from(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, tenant.id), eq(tenantUsers.userId, second.id)))
    expect(m?.role).toBe('owner')
  })

  it('a NEW user under invite_only: magic link admits them, then accept joins them', async () => {
    const { tenant, owner } = await tenantWithOwner()
    const email = newEmail()
    const { token } = await createInvitation(db, cfg, logger, jobs, {
      tenantId: tenant.id,
      email,
      role: 'member',
      inviter: owner,
    })
    const { verifyUrl } = await requestMagicLink(db, cfg, logger, {
      email,
      redirectTo: `/invite/${token}`,
    })
    const login = await request(verifyUrl)
    expect(new URL(login.headers.get('location') as string, 'http://x').pathname).toBe(
      `/invite/${token}`
    )
    const sessionToken = login.headers
      .getSetCookie()
      .find(c => c.startsWith('__Host-session='))
      ?.split(';')[0]
      ?.split('=')[1] as string
    const pending = await json<{ items: Array<{ tenantId: string; tenantName: string }> }>(
      await request('/api/invitations/pending', { headers: sessionCookieHeader(sessionToken) })
    )
    expect(pending.items).toEqual([
      expect.objectContaining({ tenantId: tenant.id, tenantName: tenant.name }),
    ])
    const res = await request(`/api/invite/${token}/accept`, {
      method: 'POST',
      headers: sessionCookieHeader(sessionToken),
    })
    expect(res.status).toBe(200)
    expect((await json<SessionResponse>(res)).tenant?.id).toBe(tenant.id)
  })
})

describe('GET /api/invitations/pending', () => {
  it('lists invitations addressed to my email across tenants, even with no membership', async () => {
    const a = await tenantWithOwner()
    const b = await tenantWithOwner()
    const email = newEmail()
    await createInvitation(db, cfg, logger, jobs, {
      tenantId: a.tenant.id,
      email,
      role: 'member',
      inviter: a.owner,
    })
    await createInvitation(db, cfg, logger, jobs, {
      tenantId: b.tenant.id,
      email,
      role: 'admin',
      inviter: b.owner,
    })
    const me = await createTestUser(db, { email })
    const res = await request('/api/invitations/pending', {
      headers: sessionCookieHeader(await createTestSession(db, me.id)),
    })
    expect(res.status).toBe(200)
    const body = await json<{ items: Array<{ tenantId: string }> }>(res)
    expect(body.items.map(i => i.tenantId).sort()).toEqual([a.tenant.id, b.tenant.id].sort())
    const empty = await createTestTenant(db)
    expect(empty.id).toBeTruthy()
  })
})

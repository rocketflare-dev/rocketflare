/**
 * Invitation email is bounded: a resend waits out a cooldown, and a Postgres counter caps the mail
 * one person and one tenant may queue per UTC day. The per-person count spans tenants.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { teamInvitations } from '@/db/schema'
import {
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
const newEmail = () => `mail_${uniqueId().toLowerCase()}@example.test`

async function owned() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

const invite = (cookie: Record<string, string>, env: ReturnType<typeof createTestEnv>) =>
  request(
    '/api/invitations',
    { method: 'POST', headers: cookie },
    { env, json: { email: newEmail() } }
  )

function sentMail(env: ReturnType<typeof createTestEnv>) {
  return stubs(env).queue.messages.filter(m => (m.body as { type: string }).type === 'email.send')
}

const limited = (vars: Record<string, string>) => createTestEnv(vars as never)

async function backdate(id: string) {
  await db
    .update(teamInvitations)
    .set({ lastSentAt: new Date(Date.now() - 3_600_000) })
    .where(eq(teamInvitations.id, id))
}

describe('the resend cooldown', () => {
  it('refuses a resend inside the cooldown and keeps the link already sent', async () => {
    const { cookie } = await owned()
    const env = createTestEnv()
    const created = await invite(cookie, env)
    const { id } = await json<{ id: string }>(created)
    const before = await db.query.teamInvitations.findFirst({ where: eq(teamInvitations.id, id) })

    const res = await request(
      `/api/invitations/${id}/resend`,
      { method: 'POST', headers: cookie },
      { env }
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(sentMail(env)).toHaveLength(1)
    const after = await db.query.teamInvitations.findFirst({ where: eq(teamInvitations.id, id) })
    expect(after?.tokenHash).toBe(before?.tokenHash)
  })

  it('allows a resend once the cooldown has passed, and starts it again', async () => {
    const { cookie } = await owned()
    const env = createTestEnv()
    const { id } = await json<{ id: string }>(await invite(cookie, env))
    await backdate(id)
    const again = () =>
      request(`/api/invitations/${id}/resend`, { method: 'POST', headers: cookie }, { env })
    expect((await again()).status).toBe(200)
    expect(sentMail(env)).toHaveLength(2)
    expect((await again()).status).toBe(429)
  })

  it('simultaneous resends queue one mail', async () => {
    const { cookie } = await owned()
    const env = createTestEnv()
    const { id } = await json<{ id: string }>(await invite(cookie, env))
    await backdate(id)
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(`/api/invitations/${id}/resend`, { method: 'POST', headers: cookie }, { env })
      )
    )
    expect(results.filter(r => r.status === 200)).toHaveLength(1)
    expect(sentMail(env)).toHaveLength(2)
  })
})

describe('the daily send counters', () => {
  it('one person is stopped at their limit, across tenants', async () => {
    const env = limited({ INVITATION_EMAILS_PER_USER_PER_DAY: '2' })
    const a = await owned()
    const { tenant: other } = await createTestTenantWithUser(db, 'owner')
    await linkUserToTenant(db, a.user.id, other.id, 'admin')
    const inOther = sessionCookieHeader(await createTestSession(db, a.user.id, other.id))

    expect((await invite(a.cookie, env)).status).toBe(201)
    expect((await invite(inOther, env)).status).toBe(201)
    const refused = await invite(a.cookie, env)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(sentMail(env)).toHaveLength(2)
  })

  it('one tenant is stopped at its limit, whoever sends', async () => {
    const env = limited({ INVITATION_EMAILS_PER_TENANT_PER_DAY: '2' })
    const a = await owned()
    const colleague = await createTestUser(db)
    await linkUserToTenant(db, colleague.id, a.tenant.id, 'admin')
    const cookie = sessionCookieHeader(await createTestSession(db, colleague.id, a.tenant.id))

    expect((await invite(a.cookie, env)).status).toBe(201)
    expect((await invite(cookie, env)).status).toBe(201)
    expect((await invite(a.cookie, env)).status).toBe(429)
  })

  it('a refused invitation stores nothing and a resend counts as mail', async () => {
    const env = limited({ INVITATION_EMAILS_PER_USER_PER_DAY: '2' })
    const a = await owned()
    const email = newEmail()
    const { id } = await json<{ id: string }>(
      await request(
        '/api/invitations',
        { method: 'POST', headers: a.cookie },
        { env, json: { email } }
      )
    )
    await backdate(id)
    expect(
      (
        await request(
          `/api/invitations/${id}/resend`,
          { method: 'POST', headers: a.cookie },
          { env }
        )
      ).status
    ).toBe(200)
    await backdate(id)
    const refused = await request(
      `/api/invitations/${id}/resend`,
      {
        method: 'POST',
        headers: a.cookie,
      },
      { env }
    )
    expect(refused.status).toBe(429)

    const third = newEmail()
    expect(
      (
        await request(
          '/api/invitations',
          { method: 'POST', headers: a.cookie },
          { env, json: { email: third } }
        )
      ).status
    ).toBe(429)
    const rows = await db
      .select()
      .from(teamInvitations)
      .where(and(eq(teamInvitations.tenantId, a.tenant.id), eq(teamInvitations.email, third)))
    expect(rows).toEqual([])
  })

  it('simultaneous invitations cannot pass the limit', async () => {
    const env = limited({ INVITATION_EMAILS_PER_USER_PER_DAY: '3' })
    const a = await owned()
    const results = await Promise.all(Array.from({ length: 8 }, () => invite(a.cookie, env)))
    expect(results.filter(r => r.status === 201)).toHaveLength(3)
    expect(sentMail(env)).toHaveLength(3)
  })

  it('a bulk invite stops at the limit and reports the rest', async () => {
    const env = limited({ INVITATION_EMAILS_PER_USER_PER_DAY: '2' })
    const a = await owned()
    const emails = [newEmail(), newEmail(), newEmail(), newEmail()]
    const res = await request(
      '/api/invitations/bulk',
      { method: 'POST', headers: a.cookie },
      { env, json: { emails } }
    )
    expect(res.status).toBe(200)
    const { results } = await json<{ results: Array<{ status: string; reason?: string }> }>(res)
    expect(results.map(r => r.status)).toEqual(['invited', 'invited', 'failed', 'failed'])
    expect(results[3]?.reason).toBe('send_limit')

    const next = await request(
      '/api/invitations/bulk',
      { method: 'POST', headers: a.cookie },
      { env, json: { emails: [newEmail()] } }
    )
    expect(next.status).toBe(429)
  })
})

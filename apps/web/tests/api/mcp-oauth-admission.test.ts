/**
 * Who may connect, and what ends a connection. The consent screen offers exactly the
 * organisations where `/mcp` would admit the person (MCP on, the connect policy met, never a
 * support role) and approving re-checks it; an organisation URL (`/mcp/t/<slug>`) fixes the
 * organisation; removing or blocking a person ends their connections in the same transaction;
 * admins see and revoke their organisation's connections, a person their own. And nothing the
 * authorization server says names the product.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { setUserBlocked } from '@/api/services/admin'
import { loadConfig } from '@/config'
import { mcpGrants, users } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { KIT_NAME } from '../helpers/kit-name'
import { enableMcp, mcpPost, mcpTestEnv } from '../helpers/mcp'
import {
  authorizePath,
  browserGet,
  connectViaOAuth,
  consentPost,
  requestIdFrom,
  revokePost,
  seedOAuthClient,
  tokenPost,
  validAuthorize,
} from '../helpers/oauth'
import { request } from '../helpers/request'
import type { TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const env = mcpTestEnv()
const cfg = loadConfig(env)
const ORIGIN = new URL(cfg.APP_URL).origin
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

async function org(patch: Parameters<typeof enableMcp>[3] = {}, enabled = true) {
  const tenant = await createTestTenant(db)
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenant.id, 'owner')
  if (enabled) await enableMcp(db, tenant.id, owner.id, patch)
  return { tenant, owner }
}

async function join(
  tenantId: string,
  role: 'owner' | 'admin' | 'member' | 'support',
  userId?: string
) {
  const id = userId ?? (await createTestUser(db)).id
  await linkUserToTenant(db, id, tenantId, role)
  return id
}

/** Start a request as `cookie` and read the organisations the consent page would offer. */
async function offered(cookie: string, e: TestEnv = env, overrides = {}) {
  await seedOAuthClient(db)
  const start = await browserGet(e, authorizePath(validAuthorize(e, overrides)), cookie)
  expect(start.status, await start.clone().text()).toBe(302)
  const requestId = requestIdFrom(start.headers.get('Location'))
  const res = await request(
    `/oauth/consent/${requestId}`,
    { headers: sessionCookieHeader(cookie) },
    { env: e }
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    organisations: { id: string }[]
    organisationFixed: boolean
    singleTenant: boolean
  }
  return { requestId, ...body, ids: body.organisations.map(o => o.id) }
}

describe('which organisations are offered', () => {
  it('only those with MCP on, where the person may connect — never as support', async () => {
    const on = await org()
    const off = await org({}, false)
    const adminsOnly = await org({ connectPolicy: 'admins' })
    const supported = await org()
    const user = await createTestUser(db)
    for (const t of [on, off, adminsOnly]) await join(t.tenant.id, 'member', user.id)
    await join(supported.tenant.id, 'support', user.id)
    const cookie = await createTestSession(db, user.id, on.tenant.id)
    const { ids, requestId } = await offered(cookie)
    expect(ids).toEqual([on.tenant.id])
    // Approving one that was not offered is refused, not quietly granted.
    for (const t of [off, adminsOnly, supported]) {
      const res = await consentPost(env, cookie, {
        requestId,
        approve: true,
        tenantId: t.tenant.id,
      })
      expect(res.status, t.tenant.slug).toBe(403)
    }
  })

  it('a connect policy of chosen groups admits members of those groups only', async () => {
    const { tenant, owner } = await org()
    const { addGroupMembers, createGroup, createGroupType } = await import('@/api/services/groups')
    const type = await createGroupType(db, tenant.id, { name: 'Teams' })
    const group = await createGroup(db, tenant.id, { groupTypeId: type.id, name: 'Agents' })
    await enableMcp(db, tenant.id, owner.id, {
      connectPolicy: 'groups',
      connectGroupIds: [group.id],
    })
    const inside = await join(tenant.id, 'member')
    const outside = await join(tenant.id, 'member')
    await addGroupMembers(db, tenant.id, group.id, [inside])
    expect((await offered(await createTestSession(db, inside, tenant.id))).ids).toEqual([tenant.id])
    expect((await offered(await createTestSession(db, outside, tenant.id))).ids).toEqual([])
  })

  it('a person with no membership (an IdP-managed sign-in that maps to none) is offered nothing', async () => {
    const user = await createTestUser(db)
    const { ids, organisations } = await offered(await createTestSession(db, user.id, null))
    expect(ids).toEqual([])
    expect(organisations).toEqual([])
  })

  it('an organisation URL fixes the organisation; the token works only on that URL', async () => {
    const a = await org()
    const b = await org()
    const user = await createTestUser(db)
    await join(a.tenant.id, 'member', user.id)
    await join(b.tenant.id, 'member', user.id)
    const cookie = await createTestSession(db, user.id, a.tenant.id)
    const resource = `${ORIGIN}/mcp/t/${b.tenant.slug}`
    const fixed = await offered(cookie, env, { resource })
    expect(fixed.organisationFixed).toBe(true)
    expect(fixed.ids).toEqual([b.tenant.id])
    const wrong = await consentPost(env, cookie, {
      requestId: fixed.requestId,
      approve: true,
      tenantId: a.tenant.id,
    })
    expect(wrong.status).toBe(403)

    const c = await connectViaOAuth(env, cookie, { tenantId: b.tenant.id, resource })
    const bearer = { Authorization: `Bearer ${c.accessToken}` }
    expect((await mcpPost(env, `/mcp/t/${b.tenant.slug}`, LIST, bearer)).status).toBe(200)
    expect((await mcpPost(env, '/mcp', LIST, bearer)).status).toBe(401)
    expect((await mcpPost(env, `/mcp/t/${a.tenant.slug}`, LIST, bearer)).status).toBe(401)
  })

  it('a single-tenant deployment has no picker', async () => {
    const single = mcpTestEnv({ TENANCY_MODE: 'single' })
    const { tenant, owner } = await org()
    const cookie = await createTestSession(db, owner.id, tenant.id)
    expect((await offered(cookie, single)).singleTenant).toBe(true)
  })

  it('a blocked person cannot even start one', async () => {
    const { tenant } = await org()
    const user = await join(tenant.id, 'member')
    const cookie = await createTestSession(db, user, tenant.id)
    await db.update(users).set({ blockedAt: new Date() }).where(eq(users.id, user))
    await seedOAuthClient(db)
    const res = await browserGet(env, authorizePath(validAuthorize(env)), cookie)
    expect(res.status).toBe(403)
  })
})

describe('what ends a connection', () => {
  async function connected() {
    const { tenant, owner } = await org()
    const user = await join(tenant.id, 'member')
    const cookie = await createTestSession(db, user, tenant.id)
    const c = await connectViaOAuth(env, cookie, { tenantId: tenant.id })
    return { tenant, owner, user, ...c }
  }
  const listWith = (token: string) =>
    mcpPost(env, '/mcp', LIST, { Authorization: `Bearer ${token}` })

  it('removing the member revokes their connection in the same step', async () => {
    const c = await connected()
    const ownerCookie = await createTestSession(db, c.owner.id, c.tenant.id)
    const res = await request(
      `/api/members/${c.user}`,
      { method: 'DELETE', headers: sessionCookieHeader(ownerCookie) },
      { env }
    )
    expect(res.status).toBeLessThan(300)
    const [grant] = await db.select().from(mcpGrants).where(eq(mcpGrants.userId, c.user))
    expect(grant?.revokeReason).toBe('member_removed')
    expect((await listWith(c.accessToken)).status).toBe(401)
    const refresh = await tokenPost(env, {
      grant_type: 'refresh_token',
      refresh_token: c.refreshToken,
      client_id: c.clientId,
    })
    expect(((await refresh.json()) as { error: string }).error).toBe('invalid_grant')
  })

  it('blocking the person revokes every connection of theirs', async () => {
    const c = await connected()
    await setUserBlocked(db, { userId: c.user, blocked: true })
    const [grant] = await db.select().from(mcpGrants).where(eq(mcpGrants.userId, c.user))
    expect(grant?.revokeReason).toBe('blocked')
  })

  it('turning MCP off suspends (403) without revoking; turning it on resumes', async () => {
    const c = await connected()
    await enableMcp(db, c.tenant.id, c.owner.id, { enabled: false })
    expect((await listWith(c.accessToken)).status).toBe(403)
    const [grant] = await db.select().from(mcpGrants).where(eq(mcpGrants.userId, c.user))
    expect(grant?.revokedAt).toBeNull()
    await enableMcp(db, c.tenant.id, c.owner.id)
    expect((await listWith(c.accessToken)).status).toBe(200)
  })
})

describe('connections, as admins and people see them', () => {
  it('an admin lists and revokes the organisation’s connections; a member may not', async () => {
    const { tenant, owner } = await org()
    const user = await join(tenant.id, 'member')
    const userCookie = await createTestSession(db, user, tenant.id)
    const c = await connectViaOAuth(env, userCookie, { tenantId: tenant.id })
    const ownerCookie = await createTestSession(db, owner.id, tenant.id)
    const list = await request(
      '/api/mcp/connections',
      { headers: sessionCookieHeader(ownerCookie) },
      { env }
    )
    expect(list.status).toBe(200)
    const { items } = (await list.json()) as { items: { id: string; user: { id: string } }[] }
    expect(items.map(i => i.user.id)).toEqual([user])
    expect(
      (await request('/api/mcp/connections', { headers: sessionCookieHeader(userCookie) }, { env }))
        .status
    ).toBe(403)
    const del = await request(
      `/api/mcp/connections/${items[0]?.id}`,
      { method: 'DELETE', headers: sessionCookieHeader(ownerCookie) },
      { env }
    )
    expect(del.status).toBe(204)
    expect(
      (await mcpPost(env, '/mcp', LIST, { Authorization: `Bearer ${c.accessToken}` })).status
    ).toBe(401)
  })

  it('revoke-all ends every live connection in the organisation and no other', async () => {
    const a = await org()
    const b = await org()
    const ua = await join(a.tenant.id, 'member')
    const ub = await join(b.tenant.id, 'member')
    await connectViaOAuth(env, await createTestSession(db, ua, a.tenant.id), {
      tenantId: a.tenant.id,
    })
    const cb = await connectViaOAuth(env, await createTestSession(db, ub, b.tenant.id), {
      tenantId: b.tenant.id,
    })
    const res = await request(
      '/api/mcp/connections/revoke-all',
      {
        method: 'POST',
        headers: sessionCookieHeader(await createTestSession(db, a.owner.id, a.tenant.id)),
      },
      { env }
    )
    expect(await res.json()).toEqual({ revoked: 1 })
    expect(
      (await mcpPost(env, '/mcp', LIST, { Authorization: `Bearer ${cb.accessToken}` })).status
    ).toBe(200)
  })

  it('a person lists their own across organisations, and revokes only their own', async () => {
    const a = await org()
    const b = await org()
    const user = await createTestUser(db)
    await join(a.tenant.id, 'member', user.id)
    await join(b.tenant.id, 'member', user.id)
    const cookie = await createTestSession(db, user.id, a.tenant.id)
    await connectViaOAuth(env, cookie, { tenantId: a.tenant.id })
    await connectViaOAuth(env, cookie, { tenantId: b.tenant.id })
    const mine = await request(
      '/api/mcp-connections',
      { headers: sessionCookieHeader(cookie) },
      { env }
    )
    const { items } = (await mine.json()) as { items: { id: string; tenant: { id: string } }[] }
    expect(items.map(i => i.tenant.id).sort()).toEqual([a.tenant.id, b.tenant.id].sort())
    const stranger = await createTestSession(db, a.owner.id, a.tenant.id)
    const theirs = await request(
      `/api/mcp-connections/${items[0]?.id}`,
      { method: 'DELETE', headers: sessionCookieHeader(stranger) },
      { env }
    )
    expect(theirs.status).toBe(404)
    const own = await request(
      `/api/mcp-connections/${items[0]?.id}`,
      { method: 'DELETE', headers: sessionCookieHeader(cookie) },
      { env }
    )
    expect(own.status).toBe(204)
  })
})

describe('branding', () => {
  it('nothing the authorization server says names the product', async () => {
    const acme = mcpTestEnv({ APP_NAME: 'Acme Tools' })
    const { tenant, owner } = await org()
    const cookie = await createTestSession(db, owner.id, tenant.id)
    await seedOAuthClient(db)
    const seen: string[] = []
    const record = async (res: Response) => {
      seen.push(JSON.stringify([...res.headers.entries()]), await res.clone().text())
      return res
    }
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]) {
      await record(await request(path, {}, { env: acme }))
    }
    // The error page, a redirected error, the login bounce, the consent page's data and decision.
    await record(await browserGet(acme, authorizePath(validAuthorize(acme, { client_id: 'nope' }))))
    await record(await browserGet(acme, authorizePath(validAuthorize(acme, { scope: 'x' }))))
    await record(await browserGet(acme, authorizePath(validAuthorize(acme))))
    const start = await record(await browserGet(acme, authorizePath(validAuthorize(acme)), cookie))
    const requestId = requestIdFrom(start.headers.get('Location'))
    const details = await record(
      await request(
        `/oauth/consent/${requestId}`,
        { headers: sessionCookieHeader(cookie) },
        { env: acme }
      )
    )
    expect(await details.text()).toContain('Acme Tools')
    await record(await consentPost(acme, cookie, { requestId, approve: false }))
    await record(await browserGet(acme, `/oauth/continue?request=${requestId}`, cookie))
    // The token endpoint's answers and errors, and revoke.
    const c = await connectViaOAuth(acme, cookie, { tenantId: tenant.id })
    await record(
      await tokenPost(acme, {
        grant_type: 'refresh_token',
        refresh_token: 'mcprt_x',
        client_id: c.clientId,
      })
    )
    await record(await tokenPost(acme, { grant_type: 'password' }))
    await record(
      await tokenPost(acme, {
        grant_type: 'refresh_token',
        refresh_token: c.refreshToken,
        client_id: c.clientId,
      })
    )
    await record(await revokePost(acme, { token: c.refreshToken, client_id: c.clientId }))
    await record(await mcpPost(acme, '/mcp', LIST, { Authorization: `Bearer ${c.accessToken}` }))
    const all = seen.join('\n')
    expect(all).not.toMatch(KIT_NAME)
  })
})

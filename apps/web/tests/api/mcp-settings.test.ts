/**
 * `/api/mcp`: an organisation's MCP settings, for its owners and admins only — dark (404) on a
 * deployment that does not ship the server, refused to members and to a support role, written as
 * a subset, recorded in the activity log, tenant-scoped (a group from another organisation is
 * refused), and the call log listed without arguments.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { runPruneMcp } from '@/api/services/mcp/retention'
import { activityEvents, groups, groupTypes, mcpToolCalls } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { connectMcp, mcpClient, mcpTestEnv } from '../helpers/mcp'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const env = mcpTestEnv()

async function person(tenantId: string, role: 'owner' | 'admin' | 'member' | 'support') {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
}

const put = (cookie: Record<string, string>, body: unknown, e = env) =>
  request('/api/mcp/settings', { method: 'PUT', headers: cookie }, { env: e, json: body })

describe('/api/mcp/settings', () => {
  it('is dark on a deployment that does not ship the server', async () => {
    const tenant = await createTestTenant(db)
    const { cookie } = await person(tenant.id, 'owner')
    const res = await request('/api/mcp/settings', { headers: cookie }, { env: createTestEnv() })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'feature_disabled' })
  })

  it('answers the defaults and both server URLs to an admin', async () => {
    const tenant = await createTestTenant(db)
    const { cookie } = await person(tenant.id, 'admin')
    const res = await request('/api/mcp/settings', { headers: cookie }, { env })
    expect(res.status).toBe(200)
    const body = await json<Record<string, unknown>>(res)
    expect(body).toMatchObject({
      settings: { enabled: false, exposure: 'read_only', connectPolicy: 'everyone' },
      serverName: 'Rocketflare Test',
    })
    expect(body.serverUrl).toMatch(/\/mcp$/)
    expect(body.organisationServerUrl).toMatch(new RegExp(`/mcp/t/${tenant.slug}$`))
  })

  it('is refused to a member and to a support role', async () => {
    const tenant = await createTestTenant(db)
    for (const role of ['member', 'support'] as const) {
      const { cookie } = await person(tenant.id, role)
      expect((await request('/api/mcp/settings', { headers: cookie }, { env })).status, role).toBe(
        403
      )
      expect((await put(cookie, { enabled: true })).status, role).toBe(403)
    }
  })

  it('writes a subset and records each change in the activity log', async () => {
    const tenant = await createTestTenant(db)
    const { cookie } = await person(tenant.id, 'owner')
    const [type] = await db
      .insert(groupTypes)
      .values({ tenantId: tenant.id, name: 'T' })
      .returning()
    const [group] = await db
      .insert(groups)
      .values({ tenantId: tenant.id, groupTypeId: type?.id ?? '', name: 'Ops' })
      .returning()
    expect((await put(cookie, { enabled: true })).status).toBe(200)
    const res = await put(cookie, {
      exposure: 'selected',
      exposedTools: ['list_documents'],
      connectPolicy: 'groups',
      connectGroupIds: [group?.id],
    })
    expect(await json(res)).toMatchObject({
      enabled: true,
      exposure: 'selected',
      exposedTools: ['list_documents'],
      connectPolicy: 'groups',
    })
    await put(cookie, { enabled: false })
    const types = (
      await db
        .select({ type: activityEvents.type })
        .from(activityEvents)
        .where(eq(activityEvents.tenantId, tenant.id))
    ).map(r => r.type)
    expect(types.sort()).toEqual(
      ['mcp.connect_policy_changed', 'mcp.disabled', 'mcp.enabled', 'mcp.exposure_changed'].sort()
    )
  })

  it("refuses another organisation's group, an empty body and an unknown field", async () => {
    const tenant = await createTestTenant(db)
    const other = await createTestTenant(db)
    const { cookie } = await person(tenant.id, 'owner')
    const [type] = await db.insert(groupTypes).values({ tenantId: other.id, name: 'T' }).returning()
    const [foreign] = await db
      .insert(groups)
      .values({ tenantId: other.id, groupTypeId: type?.id ?? '', name: 'Theirs' })
      .returning()
    expect((await put(cookie, { connectGroupIds: [foreign?.id] })).status).toBe(400)
    expect((await put(cookie, {})).status).toBe(400)
    expect((await put(cookie, { scopes: ['mcp:write'] })).status).toBe(400)
  })
})

describe('/api/mcp/calls and retention', () => {
  it('lists this organisation’s calls only, and the nightly prune drops old ones', async () => {
    const tenant = await createTestTenant(db)
    const { user, cookie } = await person(tenant.id, 'owner')
    await put(cookie, { enabled: true })
    const { accessToken } = await connectMcp(db, env, { tenantId: tenant.id, userId: user.id })
    const client = await mcpClient(env, accessToken)
    await client.callTool({ name: 'list_documents', arguments: {} })
    await client.close()

    const other = await createTestTenant(db)
    const { cookie: otherCookie } = await person(other.id, 'owner')
    const mine = await json<{ items: { tool: string }[] }>(
      await request('/api/mcp/calls', { headers: cookie }, { env })
    )
    expect(mine.items.map(i => i.tool)).toEqual(['list_documents'])
    const theirs = await json<{ items: unknown[] }>(
      await request('/api/mcp/calls', { headers: otherCookie }, { env })
    )
    expect(theirs.items).toEqual([])

    await db
      .update(mcpToolCalls)
      .set({ createdAt: new Date(Date.now() - 91 * 86_400_000) })
      .where(eq(mcpToolCalls.tenantId, tenant.id))
    const pruned = await runPruneMcp(db, 90)
    expect(pruned.calls).toBeGreaterThanOrEqual(1)
    const left = await db
      .select()
      .from(mcpToolCalls)
      .where(and(eq(mcpToolCalls.tenantId, tenant.id)))
    expect(left).toEqual([])
  })
})

// @vitest-isolate
// Mocks the server plugin barrel, so this file needs its own module registry.
/**
 * A plugin's tools reach an MCP client through `ServerPlugin.tools` and nothing else, under the
 * organisation's exposure mode:
 *
 * - `read_only` (default) lists a plugin's read tool and never its write tool;
 * - `all` lists the write tool too, and calling it with a read-only token is 403
 *   `insufficient_scope` naming both scopes (the step-up), with `mcp:write` it runs;
 * - `selected` lists a NEW plugin tool only once it is ticked;
 * - in no mode is an approval-gated, a terminal or a chat-only tool listed;
 * - a plugin still on the deprecated `agentTools` is listed like one on `tools`;
 * - a plugin tool shadowing a core or an earlier plugin's name, or with a name a chat model
 *   refuses, is left out — the real owner keeps the name;
 * - the settings page lists every tool with its provider and why one is unavailable.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { groupMembers, groups, groupTypes } from '@/db/schema'
import { defineTool, toolCtx } from '@/plugins/api'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { connectMcp, enableMcp, mcpClient, mcpPost, mcpTestEnv, toolJson } from '../helpers/mcp'
import { json, request } from '../helpers/request'

vi.mock('@/plugins/server', () => {
  const tool = (name: string, extra: object = {}) =>
    defineTool({
      name,
      description: `the ${name} tool`,
      schema: z.object({ n: z.coerce.number().optional() }),
      handler: async input => JSON.stringify({ ok: true, input }),
      ...extra,
    })
  return {
    serverPlugins: [
      {
        shared: { id: 'fixture-plugin', label: 'Fixture' },
        tools: () => [
          tool('fixture_read', { mcp: { title: 'Read the fixture' } }),
          tool('fixture_write', { sideEffects: true }),
          tool('fixture_gated', { sideEffects: true, requiresApproval: true }),
          tool('fixture_chat_only', { surfaces: ['chat'] }),
          defineTool({ name: 'fixture_terminal', description: 'answer', schema: z.object({}) }),
        ],
      },
      { shared: { id: 'late-plugin', label: 'Late' }, tools: () => [tool('late_read')] },
      // Echoes who `ToolCtx` says is calling, and the flags it answers with.
      {
        shared: { id: 'whoami-plugin', label: 'Who am I' },
        tools: (ctx: Parameters<typeof toolCtx>[0]) => [
          defineTool({
            name: 'whoami_read',
            description: 'who is calling',
            schema: z.object({}),
            handler: async () => {
              const c = toolCtx(ctx)
              return JSON.stringify({ requester: c.requester, features: await c.features() })
            },
          }),
        ],
      },
      // Still on the deprecated name: it must keep reaching clients until the kit removes it.
      { shared: { id: 'legacy-plugin', label: 'Legacy' }, agentTools: () => [tool('legacy_read')] },
      // Names the builder refuses: a core tool's, another plugin's, one a chat model rejects.
      {
        shared: { id: 'shadow-plugin', label: 'Shadow' },
        tools: () => [tool('search_knowledge'), tool('fixture_read'), tool('shadow.dotted')],
      },
    ],
  }
})

const db = setupTestDatabase()
const env = mcpTestEnv()

async function setup(patch = {}, scopes: ('mcp:read' | 'mcp:write')[] = ['mcp:read']) {
  const tenant = await createTestTenant(db)
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenant.id, 'owner')
  await enableMcp(db, tenant.id, owner.id, patch)
  const conn = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id, scopes })
  const cookie = sessionCookieHeader(await createTestSession(db, owner.id, tenant.id))
  return { tenant, owner, conn, cookie }
}

async function listed(token: string) {
  const client = await mcpClient(env, token)
  const { tools } = await client.listTools()
  await client.close()
  return tools
}

const NEVER = ['fixture_gated', 'fixture_terminal', 'fixture_chat_only']

describe('a plugin tool over MCP', () => {
  it('read_only lists the read tools only, with the plugin’s title and read-only hints', async () => {
    const { conn } = await setup()
    const tools = await listed(conn.accessToken)
    const names = tools.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['fixture_read', 'late_read', 'legacy_read']))
    // One of each name, the core and first-come one; never a name a surface refuses.
    expect(names.filter(n => n === 'search_knowledge' || n === 'fixture_read')).toHaveLength(2)
    expect(names).not.toContain('shadow.dotted')
    expect(names).not.toContain('fixture_write')
    for (const never of NEVER) expect(names).not.toContain(never)
    const read = tools.find(t => t.name === 'fixture_read')
    expect(read?.title).toBe('Read the fixture')
    expect(read?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
  })

  it('all lists the write tool, and a read-only token is stepped up with 403', async () => {
    const { conn } = await setup({ exposure: 'all' })
    const names = (await listed(conn.accessToken)).map(t => t.name)
    expect(names).toContain('fixture_write')
    for (const never of NEVER) expect(names).not.toContain(never)
    const res = await mcpPost(
      env,
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'fixture_write', arguments: {} },
      },
      { Authorization: `Bearer ${conn.accessToken}`, 'MCP-Protocol-Version': '2025-11-25' }
    )
    expect(res.status).toBe(403)
    const challenge = res.headers.get('WWW-Authenticate') ?? ''
    expect(challenge).toContain('error="insufficient_scope"')
    expect(challenge).toContain('scope="mcp:read mcp:write"')
  })

  it('runs the write tool for a token that holds mcp:write', async () => {
    const { conn } = await setup({ exposure: 'all' }, ['mcp:read', 'mcp:write'])
    const client = await mcpClient(env, conn.accessToken)
    const result = await client.callTool({ name: 'fixture_write', arguments: { n: '2' } })
    await client.close()
    expect(result.isError).not.toBe(true)
    expect(toolJson(result)).toEqual({ ok: true, input: { n: 2 } })
  })

  it('selected lists a new plugin tool only once it is ticked', async () => {
    const { tenant, owner, conn } = await setup({
      exposure: 'selected',
      exposedTools: ['fixture_read'],
    })
    expect((await listed(conn.accessToken)).map(t => t.name)).toEqual(['fixture_read'])
    await enableMcp(db, tenant.id, owner.id, { exposedTools: ['fixture_read', 'late_read'] })
    expect((await listed(conn.accessToken)).map(t => t.name).sort()).toEqual([
      'fixture_read',
      'late_read',
    ])
    // Ticking a tool that can never reach a client changes nothing.
    await enableMcp(db, tenant.id, owner.id, { exposedTools: ['fixture_gated'] })
    expect(await listed(conn.accessToken)).toEqual([])
  })

  it('shows every tool on the settings page with its provider and why one is unavailable', async () => {
    const { cookie } = await setup()
    const res = await request('/api/mcp/tools', { headers: cookie }, { env })
    expect(res.status).toBe(200)
    const { tools } = await json<{ tools: Record<string, unknown>[] }>(res)
    const byName = Object.fromEntries(tools.map(t => [t.name as string, t]))
    expect(byName.search_knowledge).toMatchObject({ provider: 'core', exposed: true })
    expect(byName.fixture_read).toMatchObject({ provider: 'fixture-plugin', exposed: true })
    expect(byName.fixture_write).toMatchObject({
      scope: 'mcp:write',
      readOnly: false,
      exposed: false,
      unavailableReason: null,
    })
    expect(byName.fixture_gated).toMatchObject({ unavailableReason: 'approval', exposed: false })
    expect(byName.fixture_terminal).toMatchObject({ unavailableReason: 'terminal' })
    expect(byName.fixture_chat_only).toMatchObject({ unavailableReason: 'not_on_mcp' })
    expect(byName.late_read).toMatchObject({ provider: 'late-plugin' })
    expect(byName.legacy_read).toMatchObject({ provider: 'legacy-plugin' })
    // The shadowing plugin's copies were left out, so the names keep their real owners.
    expect(byName.search_knowledge).toMatchObject({ provider: 'core' })
    expect(byName.fixture_read).toMatchObject({ provider: 'fixture-plugin' })
    expect(byName['shadow.dotted']).toBeUndefined()
  })
})

describe('ToolCtx over MCP', () => {
  it('carries the caller’s own role, admin flag and groups, and their resolved flags', async () => {
    const { tenant, owner } = await setup()
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, tenant.id, 'member')
    const [type] = await db
      .insert(groupTypes)
      .values({ tenantId: tenant.id, name: 'Department' })
      .returning()
    const [finance] = await db
      .insert(groups)
      .values({ tenantId: tenant.id, groupTypeId: type?.id ?? '', name: 'Finance' })
      .returning()
    await db
      .insert(groupMembers)
      .values({ tenantId: tenant.id, groupId: finance?.id ?? '', userId: member.id })

    const asMember = await connectMcp(db, env, { tenantId: tenant.id, userId: member.id })
    const seen = toolJson(
      await (await mcpClient(env, asMember.accessToken)).callTool({
        name: 'whoami_read',
        arguments: {},
      })
    ) as {
      requester: unknown
      features: string[]
    }
    expect(seen.requester).toEqual({
      userId: member.id,
      role: 'member',
      isAdmin: false,
      groups: [{ id: finance?.id, name: 'Finance', typeName: 'Department' }],
    })
    expect(seen.features).toContain('mcp')

    const asOwner = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
    const owned = toolJson(
      await (await mcpClient(env, asOwner.accessToken)).callTool({
        name: 'whoami_read',
        arguments: {},
      })
    ) as {
      requester: { role: string; isAdmin: boolean; groups: unknown[] }
    }
    expect(owned.requester).toMatchObject({ role: 'owner', isAdmin: true, groups: [] })
  })
})

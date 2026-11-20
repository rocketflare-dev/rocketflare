/**
 * The MCP call limits count every call, one at a time: a JSON-RPC batch is refused in both
 * protocol eras before any call in it runs, one person's connections share a per-person bucket
 * below the organisation's, and a limiter that cannot be read fails the call as a tool error. And
 * an answer's size cap holds for its structured copy too.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { noopTracer } from '@/api/observability/tracer'
import type { Tool } from '@/api/services/ai/agent-loop'
import type { McpCaller } from '@/api/services/mcp/caller'
import {
  MCP_RESULT_MAX_CHARS,
  type McpServerContext,
  runMcpToolCall,
} from '@/api/services/mcp/server'
import { loadConfig } from '@/config'
import { mcpToolCalls } from '@/db/schema'
import { createTestTenant, createTestUser, linkUserToTenant } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import {
  connectMcp,
  enableMcp,
  mcpClient,
  mcpPost,
  mcpTestEnv,
  type TestMcpConnection,
  toolJson,
} from '../../helpers/mcp'
import type { TestEnv } from '../../mocks/bindings'
import { stubs } from '../../mocks/bindings'

const db = setupTestDatabase()

async function memberWithMcp(env: TestEnv) {
  const tenant = await createTestTenant(db)
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenant.id, 'owner')
  await enableMcp(db, tenant.id, owner.id)
  const conn = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
  return { tenant, owner, conn }
}

const call = (id: number, meta?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'list_documents', arguments: {}, ...(meta && { _meta: meta }) },
})

async function callsLogged(conn: TestMcpConnection) {
  return db.select().from(mcpToolCalls).where(eq(mcpToolCalls.grantId, conn.grant.id))
}

describe('a JSON-RPC batch on /mcp', () => {
  it('is refused in the 2025 protocol era before any call in it runs', async () => {
    const env = mcpTestEnv()
    const { conn } = await memberWithMcp(env)
    const res = await mcpPost(
      env,
      '/mcp',
      Array.from({ length: 5 }, (_, i) => call(i + 1)),
      { Authorization: `Bearer ${conn.accessToken}`, 'MCP-Protocol-Version': '2025-11-25' }
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } })
    expect(await callsLogged(conn)).toHaveLength(0)
  })

  it('is refused in the 2026 protocol era too', async () => {
    const env = mcpTestEnv()
    const { conn } = await memberWithMcp(env)
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
    }
    const res = await mcpPost(env, '/mcp', [call(1, meta), call(2, meta)], {
      Authorization: `Bearer ${conn.accessToken}`,
      'MCP-Protocol-Version': '2026-07-28',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: -32600 } })
    expect(await callsLogged(conn)).toHaveLength(0)
  })

  it('still lets a single call through', async () => {
    const env = mcpTestEnv()
    const { conn } = await memberWithMcp(env)
    const client = await mcpClient(env, conn.accessToken)
    const result = await client.callTool({ name: 'list_documents', arguments: {} })
    await client.close()
    expect(result.isError).not.toBe(true)
  })
})

describe("one person's calls", () => {
  it("share a bucket across that person's connections, below the organisation's", async () => {
    const env = mcpTestEnv({ MCP_CALLS_PER_USER_PER_MINUTE: '2' })
    const { tenant, owner, conn } = await memberWithMcp(env)
    const second = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
    const colleague = await createTestUser(db)
    await linkUserToTenant(db, colleague.id, tenant.id, 'member')
    const theirs = await connectMcp(db, env, { tenantId: tenant.id, userId: colleague.id })

    const results = []
    for (const token of [conn.accessToken, second.accessToken, second.accessToken]) {
      const client = await mcpClient(env, token)
      results.push(await client.callTool({ name: 'list_documents', arguments: {} }))
      await client.close()
    }
    expect(results.map(r => r.isError === true)).toEqual([false, false, true])
    expect(toolJson(results[2])).toMatchObject({ error: 'rate_limited' })

    const client = await mcpClient(env, theirs.accessToken)
    const colleagueCall = await client.callTool({ name: 'list_documents', arguments: {} })
    await client.close()
    expect(colleagueCall.isError).not.toBe(true)
  })
})

describe('a limiter that cannot be read', () => {
  it('fails the call closed as a logged tool error, and the tool does not run', async () => {
    const env = mcpTestEnv()
    const { conn } = await memberWithMcp(env)
    const kv = stubs(env).kv
    const get = kv.get.bind(kv)
    kv.get = async (key: string, type?: string | { type?: string }) => {
      if (key.startsWith('rl:mcp:')) throw new Error('KV unavailable')
      return get(key, type)
    }
    const client = await mcpClient(env, conn.accessToken)
    const result = await client.callTool({ name: 'list_documents', arguments: {} })
    await client.close()
    expect(result.isError).toBe(true)
    expect(toolJson(result)).toMatchObject({ error: 'tool_failed' })
    const rows = await callsLogged(conn)
    expect(rows.map(r => r.outcome)).toEqual(['error'])
  })
})

describe('an answer over the size cap', () => {
  const caller = {
    grant: { id: 'grant', clientId: 'client' },
    scopes: ['mcp:read'],
    auth: { tenantId: 't', user: { id: 'u' }, tenant: { id: 't', name: 'Org', slug: 'org' } },
  } as unknown as McpCaller
  const ctx: McpServerContext = {
    caller,
    cfg: loadConfig(mcpTestEnv()),
    db,
    kv: undefined,
    logger: { warn: () => {}, debug: () => {} } as unknown as McpServerContext['logger'],
    tracer: noopTracer,
    defer: () => {},
  }
  const shaped = (body: string): Tool =>
    ({
      name: 'shaped',
      description: 'answers a declared shape',
      schema: z.object({}),
      handler: async () => body,
      mcp: { outputSchema: z.object({ items: z.array(z.string()) }) },
    }) as unknown as Tool

  it('keeps the structured copy of an answer within the cap', async () => {
    const result = await runMcpToolCall(ctx, shaped(JSON.stringify({ items: ['a'] })), {})
    expect(result.structuredContent).toEqual({ items: ['a'] })
    expect(result.isError).not.toBe(true)
  })

  it('sends no structured copy of an answer over the cap, only the capped text', async () => {
    const body = JSON.stringify({ items: ['x'.repeat(MCP_RESULT_MAX_CHARS)] })
    const result = await runMcpToolCall(ctx, shaped(body), {})
    expect(result.structuredContent).toBeUndefined()
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text.length).toBeLessThan(MCP_RESULT_MAX_CHARS + 500)
  })
})

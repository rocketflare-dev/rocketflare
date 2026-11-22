/**
 * The MCP server at `/mcp`: the transport (both protocol eras, POST only, the Origin rule, the
 * header checks), the 401 challenge and the 403s, which organisation a token reaches, which tools
 * a client sees under each exposure mode, the step-up to `mcp:write`, the rate limits as tool
 * errors, the call log — and that nothing a client sees names the product.
 *
 * Tokens are real rows minted through the authorization server's own service functions
 * (`tests/helpers/mcp.ts`), so every check `/mcp` makes is made for real.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '@/config'
import { aiSpans, mcpGrants, mcpToolCalls, tenants, tenantUsers, users } from '@/db/schema'
import {
  createTestApiKey,
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { KIT_NAME } from '../helpers/kit-name'
import { connectMcp, enableMcp, mcpClient, mcpPost, mcpTestEnv, toolJson } from '../helpers/mcp'
import { request } from '../helpers/request'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const env = mcpTestEnv()
const cfg = loadConfig(env)

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
const LEGACY = { 'MCP-Protocol-Version': '2025-11-25' }

async function memberOf(
  tenantId: string,
  role: 'owner' | 'admin' | 'member' | 'support' = 'member'
) {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return user
}

async function tenantWithMcp(patch = {}) {
  const tenant = await createTestTenant(db)
  const owner = await memberOf(tenant.id, 'owner')
  await enableMcp(db, tenant.id, owner.id, patch)
  return { tenant, owner }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

describe('the deployment gate', () => {
  it('answers 404 when the deployment does not ship the mcp feature', async () => {
    const res = await mcpPost(createTestEnv(), '/mcp', LIST)
    expect(res.status).toBe(404)
  })
})

describe('the transport', () => {
  it('answers 405 to GET and DELETE', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await request('/mcp', { method }, { env })
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('POST')
    }
  })

  it('refuses a browser Origin that is not ours, allows ours and none', async () => {
    const foreign = await mcpPost(env, '/mcp', LIST, { Origin: 'https://evil.example' })
    expect(foreign.status).toBe(403)
    const ours = await mcpPost(env, '/mcp', LIST, { Origin: new URL(cfg.APP_URL).origin })
    expect(ours.status).toBe(401)
    expect((await mcpPost(env, '/mcp', LIST)).status).toBe(401)
  })

  it('answers CORS for any origin without credentials, exposing the challenge header', async () => {
    const res = await request(
      '/mcp',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://claude.ai',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type,mcp-protocol-version',
        },
      },
      { env }
    )
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })

  it('serves both protocol eras with one tool list', async () => {
    const { tenant, owner } = await tenantWithMcp()
    const { accessToken } = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
    const names = async (mode: 'legacy' | 'auto') => {
      const client = await mcpClient(env, accessToken, { mode })
      const { tools } = await client.listTools()
      await client.close()
      return tools.map(t => t.name).sort()
    }
    const legacy = await names('legacy')
    expect(legacy).toContain('search_knowledge')
    expect(await names('auto')).toEqual(legacy)
  })

  it('rejects a Mcp-Name header that disagrees with the body (-32020)', async () => {
    const { tenant, owner } = await tenantWithMcp()
    const { accessToken } = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
    const res = await mcpPost(
      env,
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'list_documents',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
          },
        },
      },
      {
        ...bearer(accessToken),
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'search_knowledge',
      }
    )
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('-32020')
  })

  it('refuses a subscriptions/listen stream — the list is never pushed', async () => {
    const { tenant, owner } = await tenantWithMcp()
    const { accessToken } = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
    const res = await mcpPost(
      env,
      '/mcp',
      { jsonrpc: '2.0', id: 3, method: 'subscriptions/listen', params: {} },
      {
        ...bearer(accessToken),
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'subscriptions/listen',
      }
    )
    expect(res.status).toBe(405)
  })
})

describe('the 401 challenge', () => {
  it('names the protected-resource metadata and the baseline scope', async () => {
    const res = await mcpPost(env, '/mcp', LIST, LEGACY)
    expect(res.status).toBe(401)
    const challenge = res.headers.get('WWW-Authenticate') ?? ''
    expect(challenge).toMatch(/^Bearer /)
    expect(challenge).toContain(
      `resource_metadata="${new URL(cfg.APP_URL).origin}/.well-known/oauth-protected-resource/mcp"`
    )
    expect(challenge).toContain('scope="mcp:read"')
  })

  it('refuses an API key, a CLI key and a session token as unknown tokens', async () => {
    const { tenant, owner } = await tenantWithMcp()
    const { key } = await createTestApiKey(db, tenant.id, owner.id)
    const session = await createTestSession(db, owner.id, tenant.id)
    for (const token of [key, session]) {
      const res = await mcpPost(env, '/mcp', LIST, { ...LEGACY, ...bearer(token) })
      expect(res.status).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"')
    }
    // A cookie is never a credential here either.
    const cookie = await mcpPost(env, '/mcp', LIST, { ...LEGACY, ...sessionCookieHeader(session) })
    expect(cookie.status).toBe(401)
  })

  it('refuses a revoked grant, an expired grant and an idle one', async () => {
    const { tenant, owner } = await tenantWithMcp()
    const revoked = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
    await db
      .update(mcpGrants)
      .set({ revokedAt: new Date() })
      .where(eq(mcpGrants.id, revoked.grant.id))
    const expired = await connectMcp(db, env, {
      tenantId: tenant.id,
      userId: owner.id,
      expiresAt: new Date(Date.now() - 1000),
    })
    const idle = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
    await db
      .update(mcpGrants)
      .set({ lastUsedAt: new Date(Date.now() - (cfg.MCP_GRANT_IDLE_DAYS + 1) * 86_400_000) })
      .where(eq(mcpGrants.id, idle.grant.id))
    for (const { accessToken } of [revoked, expired, idle]) {
      const res = await mcpPost(env, '/mcp', LIST, { ...LEGACY, ...bearer(accessToken) })
      expect(res.status).toBe(401)
    }
  })

  it('never answers a refresh token as an access token', async () => {
    const { tenant, owner } = await tenantWithMcp()
    const { refreshToken } = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
    const res = await mcpPost(env, '/mcp', LIST, { ...LEGACY, ...bearer(refreshToken) })
    expect(res.status).toBe(401)
  })
})

describe('which organisation a token reaches', () => {
  it('reaches only its own tenant, and a /mcp token is refused on any /mcp/t/<slug>', async () => {
    const a = await tenantWithMcp()
    const b = await tenantWithMcp()
    // The same person in both organisations.
    await linkUserToTenant(db, a.owner.id, b.tenant.id, 'member')
    const inA = await connectMcp(db, env, { tenantId: a.tenant.id, userId: a.owner.id })
    for (const path of [`/mcp/t/${b.tenant.slug}`, `/mcp/t/${a.tenant.slug}`]) {
      const res = await mcpPost(env, path, LIST, { ...LEGACY, ...bearer(inA.accessToken) })
      expect(res.status).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toContain(
        `/.well-known/oauth-protected-resource${path}`
      )
    }
    const client = await mcpClient(env, inA.accessToken)
    const listed = await client.callTool({ name: 'list_documents', arguments: {} })
    expect(listed.isError).not.toBe(true)
    await client.close()
  })

  it('serves a grant made for /mcp/t/<slug> there, and only there', async () => {
    const { tenant, owner } = await tenantWithMcp()
    const pinned = await connectMcp(db, env, {
      tenantId: tenant.id,
      userId: owner.id,
      slug: tenant.slug,
    })
    const client = await mcpClient(env, pinned.accessToken, { path: pinned.path })
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    await client.close()
    const bare = await mcpPost(env, '/mcp', LIST, { ...LEGACY, ...bearer(pinned.accessToken) })
    expect(bare.status).toBe(401)
  })
})

describe('the 403s', () => {
  it('suspends every connection while MCP is off, and serves them again when it is on', async () => {
    const { tenant, owner } = await tenantWithMcp()
    const { accessToken } = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
    await enableMcp(db, tenant.id, owner.id, { enabled: false })
    const off = await mcpPost(env, '/mcp', LIST, { ...LEGACY, ...bearer(accessToken) })
    expect(off.status).toBe(403)
    expect(await off.json()).toMatchObject({ code: 'mcp_disabled' })
    await enableMcp(db, tenant.id, owner.id)
    const on = await mcpPost(env, '/mcp', LIST, { ...LEGACY, ...bearer(accessToken) })
    expect(on.status).toBe(200)
  })

  it('refuses a removed member, a blocked person, a support role and a suspended tenant', async () => {
    const cases: [string, (t: string, u: string) => Promise<unknown>, string][] = [
      [
        'removed',
        (t, u) =>
          db.delete(tenantUsers).where(and(eq(tenantUsers.tenantId, t), eq(tenantUsers.userId, u))),
        'mcp_not_allowed',
      ],
      [
        'blocked',
        (_t, u) => db.update(users).set({ blockedAt: new Date() }).where(eq(users.id, u)),
        'blocked',
      ],
      [
        'support',
        (t, u) =>
          db
            .update(tenantUsers)
            .set({ role: 'support' })
            .where(and(eq(tenantUsers.tenantId, t), eq(tenantUsers.userId, u))),
        'mcp_not_allowed',
      ],
      [
        'suspended',
        t => db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, t)),
        'tenant_suspended',
      ],
    ]
    for (const [label, change, code] of cases) {
      const { tenant } = await tenantWithMcp()
      const person = await memberOf(tenant.id)
      const { accessToken } = await connectMcp(db, env, { tenantId: tenant.id, userId: person.id })
      await change(tenant.id, person.id)
      const res = await mcpPost(env, '/mcp', LIST, { ...LEGACY, ...bearer(accessToken) })
      expect(res.status, label).toBe(403)
      expect(await res.json(), label).toMatchObject({ code })
    }
  })

  it('applies the connect policy on every call', async () => {
    const { tenant, owner } = await tenantWithMcp()
    const member = await memberOf(tenant.id)
    const { accessToken } = await connectMcp(db, env, { tenantId: tenant.id, userId: member.id })
    await enableMcp(db, tenant.id, owner.id, { connectPolicy: 'admins' })
    const res = await mcpPost(env, '/mcp', LIST, { ...LEGACY, ...bearer(accessToken) })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'mcp_not_allowed' })
  })

  it('acts as the membership only — a global admin gets no platform reach', async () => {
    const { tenant } = await tenantWithMcp()
    const staff = await createTestUser(db, { isGlobalAdmin: true })
    await linkUserToTenant(db, staff.id, tenant.id, 'member')
    const { accessToken } = await connectMcp(db, env, { tenantId: tenant.id, userId: staff.id })
    const client = await mcpClient(env, accessToken)
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    await client.close()
  })
})

describe('exposure', () => {
  it('lists read-only tools by default and calls one', async () => {
    const { tenant, owner } = await tenantWithMcp()
    const { accessToken } = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
    const client = await mcpClient(env, accessToken)
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toEqual(
      expect.arrayContaining(['search_knowledge', 'get_document', 'list_documents'])
    )
    for (const tool of tools) expect(tool.annotations?.readOnlyHint, tool.name).toBe(true)
    // A client shows people the title, so every core tool carries one.
    const titles = Object.fromEntries(tools.map(t => [t.name, t.title]))
    expect(titles).toMatchObject({
      search_knowledge: 'Search the knowledge base',
      get_document: 'Read a document',
      list_documents: 'List documents',
    })
    const result = await client.callTool({ name: 'list_documents', arguments: {} })
    expect(toolJson(result)).toBeTruthy()
    await client.close()
  })

  it('under `selected` lists only the ticked tools, and an unticked one is unknown', async () => {
    const { tenant, owner } = await tenantWithMcp({
      exposure: 'selected',
      exposedTools: ['list_documents'],
    })
    const { accessToken } = await connectMcp(db, env, { tenantId: tenant.id, userId: owner.id })
    const client = await mcpClient(env, accessToken)
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['list_documents'])
    await expect(
      client.callTool({ name: 'search_knowledge', arguments: { query: 'x' } })
    ).rejects.toThrow(/not found/i)
    await client.close()
  })
})

describe('the call log, the limits and the span', () => {
  it('logs a call without its arguments', async () => {
    const { tenant, owner } = await tenantWithMcp()
    const { accessToken, grant } = await connectMcp(db, env, {
      tenantId: tenant.id,
      userId: owner.id,
    })
    const client = await mcpClient(env, accessToken)
    await client.callTool({ name: 'list_documents', arguments: {} })
    await client.close()
    const rows = await db.select().from(mcpToolCalls).where(eq(mcpToolCalls.grantId, grant.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tool: 'list_documents', outcome: 'ok', userId: owner.id })
    expect(Object.keys(rows[0] ?? {})).not.toContain('arguments')
    const spans = await db
      .select({ name: aiSpans.name, toolName: aiSpans.toolName })
      .from(aiSpans)
      .where(eq(aiSpans.tenantId, tenant.id))
    expect(spans.map(s => s.name)).toContain('mcp list_documents')
    expect(spans.map(s => s.toolName)).toContain('list_documents')
  })

  it('answers a tool error, not a 429, once the per-connection cap is reached', async () => {
    const capped = mcpTestEnv({ MCP_CALLS_PER_GRANT_PER_MINUTE: '2' })
    const { tenant, owner } = await tenantWithMcp()
    const { accessToken, grant } = await connectMcp(db, capped, {
      tenantId: tenant.id,
      userId: owner.id,
    })
    const client = await mcpClient(capped, accessToken)
    const results = []
    for (let i = 0; i < 3; i++) {
      results.push(await client.callTool({ name: 'list_documents', arguments: {} }))
    }
    await client.close()
    expect(results[2]?.isError).toBe(true)
    expect(toolJson(results[2])).toMatchObject({ error: 'rate_limited' })
    const outcomes = (
      await db.select().from(mcpToolCalls).where(eq(mcpToolCalls.grantId, grant.id))
    ).map(r => r.outcome)
    expect(outcomes.sort()).toEqual(['ok', 'ok', 'rate_limited'])
    expect(stubs(capped).kv).toBeTruthy()
  })

  it('caps the per-organisation calls across connections', async () => {
    const capped = mcpTestEnv({ MCP_CALLS_PER_TENANT_PER_MINUTE: '1' })
    const { tenant, owner } = await tenantWithMcp()
    const one = await connectMcp(db, capped, { tenantId: tenant.id, userId: owner.id })
    const two = await connectMcp(db, capped, { tenantId: tenant.id, userId: owner.id })
    const first = await mcpClient(capped, one.accessToken)
    expect((await first.callTool({ name: 'list_documents', arguments: {} })).isError).not.toBe(true)
    await first.close()
    const second = await mcpClient(capped, two.accessToken)
    const limited = await second.callTool({ name: 'list_documents', arguments: {} })
    await second.close()
    expect(limited.isError).toBe(true)
  })
})

describe('branding', () => {
  it('never names the product to a client', async () => {
    const acme = mcpTestEnv({ APP_NAME: 'Acme Tools' })
    const { tenant, owner } = await tenantWithMcp()
    const { accessToken } = await connectMcp(db, acme, { tenantId: tenant.id, userId: owner.id })
    const seen: string[] = []
    const record = async (res: Response) => {
      seen.push(JSON.stringify([...res.headers.entries()]), await res.text())
    }
    await record(await mcpPost(acme, '/mcp', LIST, LEGACY))
    await record(await mcpPost(acme, '/mcp', LIST, { ...LEGACY, ...bearer('mcpat_nope') }))
    await record(await request('/mcp', { method: 'GET' }, { env: acme }))
    await record(await mcpPost(acme, '/mcp', LIST, { Origin: 'https://evil.example' }))
    const init = await mcpPost(
      acme,
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      },
      { ...LEGACY, ...bearer(accessToken) }
    )
    const initText = await init.text()
    expect(initText).toContain('Acme Tools')
    seen.push(initText)
    const client = await mcpClient(acme, accessToken)
    seen.push(JSON.stringify(await client.listTools()))
    seen.push(JSON.stringify(await client.callTool({ name: 'list_documents', arguments: {} })))
    seen.push(JSON.stringify(client.getServerVersion()), client.getInstructions() ?? '')
    await client.close()
    for (const text of seen) expect(text).not.toMatch(KIT_NAME)
  })
})

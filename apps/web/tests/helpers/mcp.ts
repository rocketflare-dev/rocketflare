/**
 * MCP fixtures: a connection (grant) and its access token written through the same service
 * functions the authorization server calls, the organisation's settings, and the SDK's own client
 * driving the real Hono app. There is no test hook in `src/` — a token is a row, exactly as one the
 * consent screen minted would be, so everything `/mcp` checks is checked for real.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { McpScope, UpdateMcpSettingsRequest } from '@rocketflare/shared/mcp'
import { updateMcpSettings } from '@/api/services/mcp/settings'
import { createMcpGrant, issueMcpTokenPair, mcpResourceUrl } from '@/api/services/mcp/tokens'
import { type AppConfig, loadConfig } from '@/config'
import type { Database } from '@/db/client'
import type { McpGrantRow } from '@/db/schema'
import { createTestEnv, type TestEnv } from '../mocks/bindings'
import { request } from './request'

/** A test env whose deployment ships the MCP server. */
export function mcpTestEnv(overrides: Record<string, unknown> = {}): TestEnv {
  return createTestEnv({ FEATURES_ENABLED: 'mcp', ...overrides } as Partial<TestEnv>)
}

export const TEST_MCP_CLIENT_ID = 'https://client.example.com/oauth/metadata.json'

export interface TestMcpConnection {
  grant: McpGrantRow
  accessToken: string
  refreshToken: string
  /** The path the grant is for: `/mcp` or `/mcp/t/<slug>`. */
  path: string
}

/** A live connection for `userId` in `tenantId` — what a completed consent leaves behind. */
export async function connectMcp(
  db: Database,
  env: TestEnv,
  input: {
    tenantId: string
    userId: string
    scopes?: McpScope[]
    /** Pin the grant to `/mcp/t/<slug>` instead of `/mcp`. */
    slug?: string
    clientId?: string
    expiresAt?: Date
  }
): Promise<TestMcpConnection> {
  const cfg = loadConfig(env)
  const resource = mcpResourceUrl(cfg, input.slug)
  const grant = await createMcpGrant(db, cfg, {
    tenantId: input.tenantId,
    userId: input.userId,
    clientId: input.clientId ?? TEST_MCP_CLIENT_ID,
    scopes: input.scopes ?? ['mcp:read'],
    resource,
    activatedAt: new Date(),
    ...(input.expiresAt && { expiresAt: input.expiresAt }),
  })
  const pair = await issueMcpTokenPair(db, grant)
  return {
    grant,
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    path: new URL(resource).pathname,
  }
}

/** Turn MCP on for a tenant (plus any other settings), as an admin's PUT would. */
export async function enableMcp(
  db: Database,
  tenantId: string,
  userId: string,
  patch: UpdateMcpSettingsRequest = {}
) {
  return updateMcpSettings(db, tenantId, userId, { enabled: true, ...patch })
}

/** The SDK client over `request()` — the real app, a real JSON-RPC exchange in either era. */
export async function mcpClient(
  env: TestEnv,
  token: string,
  options: { path?: string; mode?: 'legacy' | 'auto' | { pin: string } } = {}
): Promise<Client> {
  const cfg: AppConfig = loadConfig(env)
  const url = new URL(options.path ?? '/mcp', cfg.APP_URL)
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { versionNegotiation: { mode: options.mode ?? 'legacy' } }
  )
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      const target = new URL(typeof input === 'string' ? input : input.toString())
      return request(`${target.pathname}${target.search}`, init ?? {}, { env })
    },
  })
  await client.connect(transport)
  return client
}

/** One raw JSON-RPC POST, for the transport-level cases the SDK client would never send. */
export function mcpPost(
  env: TestEnv,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    },
    { env }
  )
}

/** The text of a tool result with the untrusted-data notice line removed, parsed as JSON. */
export function toolJson<T = unknown>(result: unknown): T {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return JSON.parse(withoutNotice(content.find(c => c.type === 'text')?.text ?? '')) as T
}

/** A tool answer's text without the untrusted-data notice `/mcp` puts on its first line. */
function withoutNotice(text: string): string {
  return text.startsWith('[Data returned') ? text.slice(text.indexOf('\n') + 1) : text
}

/** What `callMcpTool` saw: whether the client was offered the tool, and what calling it answered. */
export interface McpToolCallResult {
  /** The tool was in `tools/list` for this connection. A tool that was not is never called. */
  listed: boolean
  /** Its `tools/list` entry — name, title, annotations, schemas — when listed. */
  listing: Awaited<ReturnType<Client['listTools']>>['tools'][number] | null
  /** The call answered `isError` (a tool error — a limit, a refusal, an `ApiError`). */
  isError: boolean
  /** The answer's text with the untrusted-data notice removed, or `null` when it was not listed. */
  text: string | null
  /** `text` parsed as JSON when it is JSON, else `null`. */
  json: unknown
  /** `structuredContent`, when the tool declares an `outputSchema`. */
  structured: unknown
}

/**
 * Call one tool over the REAL `/mcp` as `as` in `tenant`, the way a connected client would: the
 * organisation's MCP switch is turned on (with `exposure`, default `all`, so the tool under test is
 * reachable unless the case is about exposure), a connection with `scopes` is written as consent
 * would write it, and the SDK client lists the tools and — only if this one is listed — calls it.
 *
 * This is how a plugin proves its tool scopes over MCP exactly as it does in chat: call it as a
 * member of tenant B and assert A's rows are absent, call it as somebody outside a group and assert
 * the group's rows are absent. `listed: false` is itself an answer — an unexposed, approval-gated,
 * chat-only or flag-gated tool is unknown to the client, never an error it could probe.
 */
export async function callMcpTool(
  db: Database,
  toolName: string,
  options: {
    as: string
    tenant: string
    args?: Record<string, unknown>
    scopes?: McpScope[]
    exposure?: UpdateMcpSettingsRequest['exposure']
    exposedTools?: string[]
    env?: TestEnv
  }
): Promise<McpToolCallResult> {
  const env = options.env ?? mcpTestEnv()
  await enableMcp(db, options.tenant, options.as, {
    exposure: options.exposure ?? 'all',
    ...(options.exposedTools && { exposedTools: options.exposedTools }),
  })
  const conn = await connectMcp(db, env, {
    tenantId: options.tenant,
    userId: options.as,
    scopes: options.scopes ?? ['mcp:read', 'mcp:write'],
  })
  const client = await mcpClient(env, conn.accessToken, { path: conn.path })
  try {
    const { tools } = await client.listTools()
    const listing = tools.find(t => t.name === toolName) ?? null
    if (!listing) {
      return { listed: false, listing, isError: false, text: null, json: null, structured: null }
    }
    const result = await client.callTool({ name: toolName, arguments: options.args ?? {} })
    const content = (result.content ?? []) as { type: string; text?: string }[]
    const text = withoutNotice(content.find(c => c.type === 'text')?.text ?? '')
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    return {
      listed: true,
      listing,
      isError: result.isError === true,
      text,
      json: parsed,
      structured: result.structuredContent ?? null,
    }
  } finally {
    await client.close()
  }
}

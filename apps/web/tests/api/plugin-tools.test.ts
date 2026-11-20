// @vitest-isolate
// Mocks the server plugin barrel, so this file needs its own module registry.
/**
 * `ServerPlugin.tools` may be async and may answer per tenant — that is how a plugin
 * offers a tool only to the tenants that turned it on. A builder that throws is logged and left
 * out; the run still gets the three built-in ones and every other plugin's. `toolsFor(surface)`
 * filters the one list per surface, and the deprecated `agentTools` still contributes when `tools`
 * is absent. And `sealSecret`/`openSecret`, the one way a plugin stores a tenant's credential.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fullAccessScope } from '@/api/services/access'
import { buildAgentTools, toolsFor } from '@/api/services/agents/tools'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import { defineTool, openSecret, sealSecret } from '@/plugins/api'
import { createTestEnv } from '../mocks/bindings'

const ENABLED_TENANT = '00000000-0000-4000-8000-00000000000a'

vi.mock('@/plugins/server', () => {
  const tool = (name: string, extra: object = {}) =>
    defineTool({
      name,
      description: name,
      schema: z.object({}),
      handler: async () => '{}',
      ...extra,
    })
  return {
    serverPlugins: [
      {
        shared: { id: 'async-plugin', label: 'Async' },
        tools: async (ctx: { scope: { tenantId: string } }) =>
          ctx.scope.tenantId === ENABLED_TENANT ? [tool('async_tool')] : [],
      },
      {
        shared: { id: 'broken-plugin', label: 'Broken' },
        tools: async () => {
          throw new Error('settings table missing')
        },
      },
      { shared: { id: 'sync-plugin', label: 'Sync' }, tools: () => [tool('sync_tool')] },
      // Still on the deprecated name: contributes, because it has no `tools`.
      { shared: { id: 'legacy-plugin', label: 'Legacy' }, agentTools: () => [tool('legacy_tool')] },
      // Both names: `tools` wins, and the old builder is never called.
      {
        shared: { id: 'both-plugin', label: 'Both' },
        tools: () => [tool('new_name_tool')],
        agentTools: () => [tool('old_name_tool')],
      },
      {
        shared: { id: 'surfaces-plugin', label: 'Surfaces' },
        tools: () => [
          tool('mcp_and_agents_tool', { surfaces: ['mcp', 'agents'] }),
          tool('chat_only_tool', { surfaces: ['chat'] }),
          tool('gated_write_tool', { sideEffects: true, requiresApproval: true }),
          tool('sometimes_gated_tool', { requiresApprovalWhen: () => false }),
          defineTool({ name: 'terminal_tool', description: 'answer', schema: z.object({}) }),
        ],
      },
    ],
  }
})

const env = createTestEnv()
const cfg = loadConfig(env)
// The built-in tools only close over `db`; with `features` given, building the list never queries
// (without it, `buildAgentTools` reads the tenant's flags for `lookup_facts`).
const db = {} as Database

const ctxFor = (tenantId: string) => ({
  db,
  cfg,
  env,
  scope: fullAccessScope(tenantId),
  features: [],
})

async function toolNames(tenantId: string) {
  return (await buildAgentTools(ctxFor(tenantId))).map(t => t.name)
}

const BUILT_IN = ['search_knowledge', 'get_document', 'list_documents']
const SURFACE_FIXTURES = [
  'mcp_and_agents_tool',
  'chat_only_tool',
  'gated_write_tool',
  'sometimes_gated_tool',
  'terminal_tool',
]

describe('plugin tools', () => {
  it('awaits an async builder, and a builder that throws costs only its own tools', async () => {
    expect(await toolNames(ENABLED_TENANT)).toEqual([
      ...BUILT_IN,
      'async_tool',
      'sync_tool',
      'legacy_tool',
      'new_name_tool',
      ...SURFACE_FIXTURES,
    ])
  })

  it('lets a builder answer per tenant', async () => {
    const names = await toolNames('00000000-0000-4000-8000-00000000000b')
    expect(names).not.toContain('async_tool')
    expect(names).toContain('sync_tool')
  })

  it('still reads the deprecated agentTools, but only when tools is absent', async () => {
    const names = await toolNames(ENABLED_TENANT)
    expect(names).toContain('legacy_tool')
    expect(names).toContain('new_name_tool')
    expect(names).not.toContain('old_name_tool')
  })
})

describe('toolsFor', () => {
  const surfaceNames = async (surface: 'chat' | 'agents' | 'mcp') =>
    (await toolsFor(surface, ctxFor(ENABLED_TENANT)))
      .map(t => t.name)
      .filter(n => SURFACE_FIXTURES.includes(n) || BUILT_IN.includes(n))

  it('offers a tool only on the surfaces it names (absent = all)', async () => {
    expect(await surfaceNames('chat')).toEqual([
      ...BUILT_IN,
      'chat_only_tool',
      'gated_write_tool',
      'sometimes_gated_tool',
      'terminal_tool',
    ])
    expect(await surfaceNames('agents')).toEqual([
      ...BUILT_IN,
      'mcp_and_agents_tool',
      'gated_write_tool',
      'sometimes_gated_tool',
      'terminal_tool',
    ])
  })

  it('never offers a terminal or approval-gated tool on mcp', async () => {
    expect(await surfaceNames('mcp')).toEqual([...BUILT_IN, 'mcp_and_agents_tool'])
  })
})

describe('sealSecret / openSecret', () => {
  it('round-trips, and the sealed value is not the plaintext', async () => {
    const sealed = await sealSecret(cfg, 'tvly-secret')
    expect(sealed).not.toContain('tvly-secret')
    expect(await openSecret(cfg, sealed)).toBe('tvly-secret')
  })

  it('refuses with 503 when OAUTH_ENCRYPTION_KEY is absent', async () => {
    const bare = { ...cfg, OAUTH_ENCRYPTION_KEY: undefined }
    await expect(sealSecret(bare, 'x')).rejects.toMatchObject({
      statusCode: 503,
      code: 'encryption_key_missing',
    })
  })
})

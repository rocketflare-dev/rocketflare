// @vitest-isolate
// Mocks the server plugin barrel, so this file needs its own module registry.
/**
 * `ServerPlugin.agentTools` (D31) may be async and may answer per tenant — that is how a plugin
 * offers a tool only to the tenants that turned it on. A builder that throws is logged and left
 * out; the run still gets the kit's three and every other plugin's. And `sealSecret`/`openSecret`,
 * the one way a plugin stores a tenant's credential.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fullAccessScope } from '@/api/services/access'
import { buildAgentTools } from '@/api/services/agents/tools'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import { defineTool, openSecret, sealSecret } from '@/plugins/api'
import { createTestEnv } from '../mocks/bindings'

const ENABLED_TENANT = '00000000-0000-4000-8000-00000000000a'

vi.mock('@/plugins/server', () => {
  const tool = (name: string) =>
    defineTool({ name, description: name, schema: z.object({}), handler: async () => '{}' })
  return {
    serverPlugins: [
      {
        shared: { id: 'async-plugin', label: 'Async' },
        agentTools: async (ctx: { scope: { tenantId: string } }) =>
          ctx.scope.tenantId === ENABLED_TENANT ? [tool('async_tool')] : [],
      },
      {
        shared: { id: 'broken-plugin', label: 'Broken' },
        agentTools: async () => {
          throw new Error('settings table missing')
        },
      },
      { shared: { id: 'sync-plugin', label: 'Sync' }, agentTools: () => [tool('sync_tool')] },
    ],
  }
})

const env = createTestEnv()
const cfg = loadConfig(env)
// The kit's tools only close over `db`; building the list never queries.
const db = {} as Database

async function toolNames(tenantId: string) {
  const tools = await buildAgentTools({ db, cfg, env, scope: fullAccessScope(tenantId) })
  return tools.map(t => t.name)
}

describe('plugin agentTools', () => {
  it('awaits an async builder, and a builder that throws costs only its own tools', async () => {
    expect(await toolNames(ENABLED_TENANT)).toEqual([
      'search_knowledge',
      'get_document',
      'list_documents',
      'async_tool',
      'sync_tool',
    ])
  })

  it('lets a builder answer per tenant', async () => {
    const names = await toolNames('00000000-0000-4000-8000-00000000000b')
    expect(names).not.toContain('async_tool')
    expect(names).toContain('sync_tool')
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

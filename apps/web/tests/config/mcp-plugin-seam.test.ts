/**
 * The plugin half of the MCP seam, statically and at runtime: a plugin's tool names are unique
 * across core and every plugin and are ones every surface accepts; a plugin never mounts on the
 * paths the MCP server and its authorization server own; and the kit's name never reaches a client
 * through a tool's text. `pnpm plugin check` reads the source (`scripts/lib/plugin-lib.mjs`), the
 * tool builder enforces the names again on what was actually built. These pin the runtime half and
 * the script's copies of the rules to this app's TypeScript originals; what `pnpm plugin check`
 * reads out of a plugin's source is the kit's tooling, `tests/kit-only/plugin-check-mcp.test.ts`.
 */
import { KNOWLEDGE_TOOLS } from '@rocketflare/shared/ai/embeddings'
import { MCP_TOOL_NAME_PATTERN } from '@rocketflare/shared/mcp'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { admittedPluginTools, CORE_TOOL_NAMES } from '@/api/services/agents/tools'
import type { Tool } from '@/api/services/ai/agent-loop'
import { isReservedPath } from '@/api/utils/routes/api-prefixes'
import {
  isReservedPluginPath,
  CORE_TOOL_NAMES as LIB_CORE_TOOL_NAMES,
  TOOL_NAME_RE,
} from '../../../../scripts/lib/plugin-lib.mjs'

const tool = (name: string): Tool => ({
  name,
  description: `the ${name} tool`,
  schema: z.object({}),
  handler: async () => '{}',
})

describe('the script keeps the same rules as the host', () => {
  it('one tool-name pattern, one list of core tool names, one set of reserved paths', () => {
    expect(TOOL_NAME_RE.source).toBe(MCP_TOOL_NAME_PATTERN.source)
    expect([...LIB_CORE_TOOL_NAMES].sort()).toEqual(Object.values(KNOWLEDGE_TOOLS).sort())
    expect([...CORE_TOOL_NAMES].sort()).toEqual(Object.values(KNOWLEDGE_TOOLS).sort())
    for (const p of [
      '/mcp',
      '/mcp/t/acme',
      '/MCP',
      '/oauth',
      '/oauth/token',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
      '/api/mcp',
      '/mcpx',
      '/oauthy',
      '/.well-known/security.txt',
    ]) {
      expect(isReservedPluginPath(p), p).toBe(isReservedPath(p))
    }
  })

  it('accepts what every surface accepts and nothing else', () => {
    for (const ok of ['list_example_notes', 'a', 'x-y_9', 'A'.repeat(64)])
      expect(TOOL_NAME_RE.test(ok), ok).toBe(true)
    // A dot is MCP-legal and refused by the chat models' APIs; so is anything past 64.
    for (const bad of ['', 'a.b', 'has space', 'a,b', 'ünï', 'A'.repeat(65)])
      expect(TOOL_NAME_RE.test(bad), bad).toBe(false)
  })
})

describe('admittedPluginTools — the runtime half', () => {
  it('keeps the first of a name, never a core name, never a name a surface refuses', () => {
    const dropped: string[] = []
    const kept = admittedPluginTools(
      [
        { pluginId: 'alpha', tools: [tool('alpha_read'), tool('search_knowledge'), tool('a.b')] },
        { pluginId: 'beta', tools: [tool('alpha_read'), tool('lookup_facts'), tool('beta_read')] },
      ],
      (pluginId, name, problem) => dropped.push(`${pluginId}:${name}:${problem}`)
    )
    expect(kept.map(t => t.name)).toEqual(['alpha_read', 'beta_read'])
    expect(dropped).toEqual([
      expect.stringMatching(/^alpha:search_knowledge:.*core tool/),
      expect.stringMatching(/^alpha:a\.b:.*not 1–64/),
      expect.stringMatching(/^beta:alpha_read:.*'alpha'/),
      // Reserved even for a tenant without the facts flag, which is offered no lookup_facts.
      expect.stringMatching(/^beta:lookup_facts:.*core tool/),
    ])
  })
})

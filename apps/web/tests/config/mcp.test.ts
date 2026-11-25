/**
 * The MCP server's pure rules: which paths core reserves from plugins, who may connect under each
 * policy, which tools each exposure mode lets a client see, and the answer cap.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Tool } from '@/api/services/ai/agent-loop'
import { capResult, mcpInstructions, untrustedNotice } from '@/api/services/mcp/server'
import { exposedOverMcp, mayConnect } from '@/api/services/mcp/settings'
import { mcpResourceMetadataUrl, mcpResourceUrl } from '@/api/services/mcp/tokens'
import { assertNoReservedPluginPaths, isReservedPath } from '@/api/utils/routes/api-prefixes'
import { loadConfig } from '@/config'
import { KIT_NAME } from '../helpers/kit-name'
import { createTestEnv } from '../mocks/bindings'

const cfg = loadConfig(createTestEnv({ APP_NAME: 'Acme Tools' } as never))

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  description: name,
  schema: z.object({}),
  handler: async () => '{}',
  ...extra,
})

describe('reserved paths', () => {
  it('reserves the MCP server, the authorization server and the OAuth documents', () => {
    for (const path of [
      '/mcp',
      '/mcp/t/acme',
      '/oauth',
      '/oauth/token',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/openid-configuration',
      '/MCP',
    ]) {
      expect(isReservedPath(path), path).toBe(true)
    }
    for (const path of ['/api/mcp', '/mcpx', '/api/oauth', '/cubejs-api']) {
      expect(isReservedPath(path), path).toBe(false)
    }
  })

  it('refuses a plugin claiming one as a mount, a prefix or a public mount, by name', () => {
    const plugin = (extra: object) => ({ shared: { id: 'greedy' }, ...extra })
    expect(() =>
      assertNoReservedPluginPaths([plugin({ apiPrefixes: ['/cubejs-api', '/mcp'] })])
    ).toThrow(/greedy.*\/mcp/)
    expect(() => assertNoReservedPluginPaths([plugin({ mounts: [['/oauth/x', {}]] })])).toThrow(
      /greedy/
    )
    expect(() =>
      assertNoReservedPluginPaths([plugin({ publicMounts: [['/.well-known/oauth-x', {}]] })])
    ).toThrow(/greedy/)
    expect(() =>
      assertNoReservedPluginPaths([plugin({ mounts: [['/api/greedy', {}]], apiPrefixes: ['/x'] })])
    ).not.toThrow()
  })
})

describe('who may connect', () => {
  const policy = (
    connectPolicy: 'everyone' | 'admins' | 'groups',
    connectGroupIds: string[] = []
  ) => ({
    connectPolicy,
    connectGroupIds,
  })
  it('never a support role, always an owner or admin', () => {
    for (const p of [policy('everyone'), policy('admins'), policy('groups', ['g'])]) {
      expect(mayConnect(p, 'support', ['g'])).toBe(false)
      expect(mayConnect(p, 'owner', [])).toBe(true)
      expect(mayConnect(p, 'admin', [])).toBe(true)
    }
  })
  it('a member under each policy', () => {
    expect(mayConnect(policy('everyone'), 'member', [])).toBe(true)
    expect(mayConnect(policy('admins'), 'member', ['g'])).toBe(false)
    expect(mayConnect(policy('groups', ['g']), 'member', ['g'])).toBe(true)
    expect(mayConnect(policy('groups', ['g']), 'member', ['h'])).toBe(false)
  })
})

describe('exposure', () => {
  const read = tool('read_it')
  const write = tool('write_it', { sideEffects: true })
  const readScopedWrite = tool('sneaky', { sideEffects: true, mcp: { scope: 'mcp:read' } })
  const gated = tool('gated', { requiresApproval: true })
  const terminal: Tool = { name: 'answer', description: 'answer', schema: z.object({}) }
  const settings = (exposure: 'read_only' | 'all' | 'selected', exposedTools: string[] = []) => ({
    exposure,
    exposedTools,
  })

  it('read_only: reads only — a sideEffects tool is never read-only, whatever its scope says', () => {
    expect(exposedOverMcp(read, settings('read_only'))).toBe(true)
    expect(exposedOverMcp(write, settings('read_only'))).toBe(false)
    expect(exposedOverMcp(readScopedWrite, settings('read_only'))).toBe(false)
  })
  it('all: every tool that can reach a client', () => {
    expect(exposedOverMcp(write, settings('all'))).toBe(true)
    expect(exposedOverMcp(gated, settings('all'))).toBe(false)
    expect(exposedOverMcp(terminal, settings('all'))).toBe(false)
  })
  it('selected: the ticked ones only', () => {
    expect(exposedOverMcp(write, settings('selected', ['write_it']))).toBe(true)
    expect(exposedOverMcp(read, settings('selected', ['write_it']))).toBe(false)
    expect(exposedOverMcp(gated, settings('selected', ['gated']))).toBe(false)
  })
})

describe('what a client is told', () => {
  it('names the deployment and the organisation, never the product', () => {
    const text = [
      mcpInstructions(cfg, 'Northwind'),
      untrustedNotice('Northwind', 'search_knowledge'),
    ].join(' ')
    expect(text).toContain('Acme Tools')
    expect(text).toContain('Northwind')
    expect(text).not.toMatch(KIT_NAME)
  })
  it('caps an answer and says how much was left out', () => {
    expect(capResult('abc', 10)).toBe('abc')
    const capped = capResult('x'.repeat(25), 10)
    expect(capped.startsWith('x'.repeat(10))).toBe(true)
    expect(capped).toContain('15 more characters')
  })
  it('builds the resource and metadata URLs from APP_URL', () => {
    const origin = new URL(cfg.APP_URL).origin
    expect(mcpResourceUrl(cfg)).toBe(`${origin}/mcp`)
    expect(mcpResourceUrl(cfg, 'acme')).toBe(`${origin}/mcp/t/acme`)
    expect(mcpResourceMetadataUrl(`${origin}/mcp/t/acme`)).toBe(
      `${origin}/.well-known/oauth-protected-resource/mcp/t/acme`
    )
  })
})

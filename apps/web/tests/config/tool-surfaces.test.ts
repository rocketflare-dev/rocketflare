/**
 * The pure half of the tool seam: which surface a tool is offered on, and what an MCP client is
 * told about it — the scope a call needs and the annotations it lists, defaulted from the tool.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  mcpToolProfile,
  mcpUnavailableReason,
  offeredOn,
  toolSurfaces,
} from '@/api/services/agents/tools/surfaces'
import type { Tool } from '@/api/services/ai/agent-loop'

const tool = (extra: Partial<Tool> = {}): Tool => ({
  name: 'a_tool',
  description: 'a tool',
  schema: z.object({}),
  handler: async () => '{}',
  ...extra,
})

describe('toolSurfaces / offeredOn', () => {
  it('defaults to every surface', () => {
    expect(toolSurfaces(tool())).toEqual(['chat', 'agents', 'mcp'])
    for (const s of ['chat', 'agents', 'mcp'] as const) expect(offeredOn(tool(), s)).toBe(true)
  })

  it('honours the surfaces a tool names', () => {
    const t = tool({ surfaces: ['mcp'] })
    expect(offeredOn(t, 'chat')).toBe(false)
    expect(offeredOn(t, 'agents')).toBe(false)
    expect(offeredOn(t, 'mcp')).toBe(true)
  })

  it('keeps terminal and approval-gated tools off mcp, and only off mcp', () => {
    const terminal = tool({ handler: undefined })
    const gated = tool({ requiresApproval: true })
    const sometimes = tool({ requiresApprovalWhen: () => false })
    for (const t of [terminal, gated, sometimes]) {
      expect(offeredOn(t, 'mcp')).toBe(false)
      expect(offeredOn(t, 'agents')).toBe(true)
    }
    expect(mcpUnavailableReason(terminal)).toBe('terminal')
    expect(mcpUnavailableReason(gated)).toBe('approval')
    expect(mcpUnavailableReason(sometimes)).toBe('approval')
    expect(mcpUnavailableReason(tool({ surfaces: ['chat'] }))).toBe('not_on_mcp')
    expect(mcpUnavailableReason(tool())).toBeNull()
  })

  it('treats requiresApproval: false as no gate', () => {
    expect(offeredOn(tool({ requiresApproval: false }), 'mcp')).toBe(true)
  })
})

describe('mcpToolProfile', () => {
  it('a read needs mcp:read and reads as read-only, idempotent, closed-world', () => {
    expect(mcpToolProfile(tool())).toEqual({
      scope: 'mcp:read',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    })
  })

  it('a side effect needs mcp:write and reads as destructive; idempotent only when durable', () => {
    expect(mcpToolProfile(tool({ sideEffects: true }))).toEqual({
      scope: 'mcp:write',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    })
    expect(
      mcpToolProfile(tool({ sideEffects: true, durable: true })).annotations.idempotentHint
    ).toBe(true)
  })

  it('lets the mcp block override the scope, single annotations and the title', () => {
    const profile = mcpToolProfile(
      tool({
        sideEffects: true,
        mcp: {
          scope: 'mcp:read',
          title: 'Fetch a page',
          annotations: { openWorldHint: true, destructiveHint: false },
        },
      })
    )
    expect(profile).toEqual({
      scope: 'mcp:read',
      title: 'Fetch a page',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    })
  })

  it('a read tool can ask for mcp:write', () => {
    expect(mcpToolProfile(tool({ mcp: { scope: 'mcp:write' } })).scope).toBe('mcp:write')
  })
})

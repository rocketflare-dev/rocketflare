// @vitest-isolate
/**
 * A chat turn has no way to park for a person's answer, so a tool that declares an approval gate
 * (`requiresApproval` or `requiresApprovalWhen`) is not offered to the model and cannot run there.
 * Isolated because it replaces the provider seam and the tool list.
 */
import { conversationSchema } from '@rocketflare/shared/ai/chat'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Tool } from '@/api/services/ai/agent-loop'
import { aguiFrames, FakeChatClient } from '../../helpers/ai'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const handlers = vi.hoisted(() => ({
  always: vi.fn(async () => 'written'),
  conditional: vi.fn(async () => 'written'),
  open: vi.fn(async () => 'read'),
}))
const state: { client: FakeChatClient | null } = { client: null }

vi.mock('@/api/services/agents/tools', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/agents/tools')>()
  const schema = z.object({ value: z.string() })
  const extra: Tool<{ value: string }>[] = [
    {
      name: 'gated_write',
      description: 'A write a person must approve',
      schema,
      handler: handlers.always,
      requiresApproval: true,
    },
    {
      name: 'conditionally_gated_write',
      description: 'A write a person must approve for some inputs',
      schema,
      handler: handlers.conditional,
      requiresApprovalWhen: () => false,
    },
    { name: 'open_read', description: 'A read', schema, handler: handlers.open },
  ]
  return {
    ...actual,
    buildAgentTools: async (ctx: Parameters<typeof actual.buildAgentTools>[0]) => [
      ...(await actual.buildAgentTools(ctx)),
      ...(extra as Tool[]),
    ],
  }
})

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => ({
      client: state.client,
      provider: 'anthropic_compatible',
      model: 'fake-model',
      source: 'tenant',
      maxOutputTokens: 2048,
    })),
  }
})

const db = setupTestDatabase()

afterEach(() => {
  state.client = null
  vi.clearAllMocks()
})

async function adminChat() {
  const env = createTestEnv()
  const { user, tenant } = await createTestTenantWithUser(db, 'admin')
  const headers = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  const created = await request('/api/chat/conversations', { method: 'POST', headers }, { env })
  expect(created.status).toBe(201)
  const conversation = conversationSchema.parse(await json(created))
  return { env, headers, conversation }
}

async function send(ctx: Awaited<ReturnType<typeof adminChat>>) {
  const res = await request(
    `/api/chat/conversations/${ctx.conversation.id}/messages`,
    { method: 'POST', headers: ctx.headers },
    { env: ctx.env, json: { content: 'hello' } }
  )
  expect(res.status).toBe(200)
  return aguiFrames(res)
}

describe('approval-gated tools in chat', () => {
  it('offers the model no tool that declares an approval gate, and keeps the others', async () => {
    state.client = new FakeChatClient([{ text: 'Hello.' }], 'anthropic_compatible')
    await send(await adminChat())
    const offered = (state.client.calls[0]?.tools ?? []).map(t => t.name)
    expect(offered).toContain('open_read')
    expect(offered).toContain('search_knowledge')
    expect(offered).not.toContain('gated_write')
    expect(offered).not.toContain('conditionally_gated_write')
  })

  it('never runs the handler of a gated tool the model names anyway', async () => {
    state.client = new FakeChatClient(
      [
        {
          toolUses: [
            { id: 'c1', name: 'gated_write', input: { value: 'x' } },
            { id: 'c2', name: 'conditionally_gated_write', input: { value: 'x' } },
            { id: 'c3', name: 'open_read', input: { value: 'x' } },
          ],
        },
        { text: 'Done.' },
      ],
      'anthropic_compatible'
    )
    const frames = await send(await adminChat())
    expect(handlers.always).not.toHaveBeenCalled()
    expect(handlers.conditional).not.toHaveBeenCalled()
    expect(handlers.open).toHaveBeenCalledOnce()
    const results = frames.filter(f => f.type === 'TOOL_CALL_RESULT')
    expect(results).toHaveLength(3)
  })
})

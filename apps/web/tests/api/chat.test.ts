// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the provider seam), so this file needs its own module registry.
/**
 * `/api/chat` (D17) against a scripted `FakeChatClient`: create conversation (frozen provider/
 * model), POST message streams the **AG-UI** sequence (`RUN_STARTED → CUSTOM kit.chat.ids →
 * STATE_SNAPSHOT → TEXT_MESSAGE_* → CUSTOM kit.usage → RUN_FINISHED`), persists both messages + an
 * `ai_usage` row + auto-title; history is sent on the next turn; not configured → 503
 * `ai_not_configured` BEFORE the stream; a provider failure → `RUN_ERROR` and no `RUN_FINISHED`; a
 * cancelled run emits neither and persists nothing; another user's conversation → 404 (admins
 * too); list is mine only + paginated; delete cascades; 401 anon.
 *
 * Transport conformance is asserted here too, because it is the surface an external AG-UI client
 * depends on: `data:`-only frames with **no `event:` line** by default, and length-prefixed
 * protobuf when the client negotiates it.
 */
import { decode as decodeProto } from '@ag-ui/proto'
import { chatRunResultSchema, KIT_CUSTOM_EVENTS } from '@rocketflare/shared/ai/agui'
import { conversationSchema, conversationWithMessagesSchema } from '@rocketflare/shared/ai/chat'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiError, AiNotConfiguredError } from '@/api/services/ai/errors'
import type { ChatParams } from '@/api/services/ai/types'
import { aiUsage, conversations, messages } from '@/db/schema'
import {
  aguiFrames,
  aguiTypes,
  customEvent,
  FakeChatClient,
  type FakeScript,
  splitSseFrames,
} from '../helpers/ai'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

/** What the mocked `resolveChat` hands out; tests reassign per case. */
const state: { client: FakeChatClient | null; error: Error | null } = { client: null, error: null }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      if (state.error) throw state.error
      if (!state.client) throw new AiNotConfiguredError('chat')
      return {
        client: state.client,
        provider: 'anthropic_compatible',
        model: 'fake-model',
        source: 'tenant',
        maxOutputTokens: 2048,
      }
    }),
  }
})

const db = setupTestDatabase()

function script(s: FakeScript) {
  state.error = null
  state.client = new FakeChatClient(s, 'anthropic_compatible')
  return state.client
}

async function actor(role: 'owner' | 'admin' | 'member' = 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function createConversation(cookie: Record<string, string>, title?: string) {
  const res = await request(
    '/api/chat/conversations',
    { method: 'POST', headers: cookie },
    { json: title ? { title } : {} }
  )
  expect(res.status).toBe(201)
  return conversationSchema.parse(await json(res))
}

const send = (cookie: Record<string, string>, id: string, content: string) =>
  request(
    `/api/chat/conversations/${id}/messages`,
    { method: 'POST', headers: cookie },
    { json: { content } }
  )

beforeEach(() => {
  state.client = null
  state.error = null
})

describe('POST /api/chat/conversations', () => {
  it('creates with the resolved provider/model; 503 ai_not_configured when nothing resolves', async () => {
    const a = await actor()
    script([{ text: 'x' }])
    const conv = await createConversation(a.cookie)
    expect(conv).toMatchObject({
      tenantId: a.tenant.id,
      userId: a.user.id,
      title: 'New conversation',
      provider: 'anthropic_compatible',
      model: 'fake-model',
      lastMessageAt: null,
    })

    state.client = null
    const res = await request(
      '/api/chat/conversations',
      { method: 'POST', headers: a.cookie },
      { json: {} }
    )
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({
      error: expect.any(String),
      statusCode: 503,
      code: 'ai_not_configured',
    })
    expect(
      (await request('/api/chat/conversations', { method: 'POST' }, { json: {} })).status
    ).toBe(401)
  })
})

describe('POST /api/chat/conversations/:id/messages (AG-UI stream)', () => {
  it('streams the frame sequence, persists both messages + usage + title, and replays history on the next turn', async () => {
    const a = await actor()
    const client = script([
      {
        text: 'Hello Ada, how can I help?',
        usage: { inputTokens: 21, outputTokens: 8, cacheReadTokens: 3 },
      },
      { text: 'Sure.', usage: { inputTokens: 40, outputTokens: 2 } },
    ])
    const conv = await createConversation(a.cookie)
    const res = await send(
      a.cookie,
      conv.id,
      'Hi there, I need a hand with something rather long so the title gets trimmed nicely'
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const body = await res.text()
    // Spec AG-UI SSE is `data:`-only — the type lives inside the JSON.
    expect(splitSseFrames(body).every(f => f.event === null)).toBe(true)
    const frames = splitSseFrames(body).map(f => JSON.parse(f.data))
    const types = frames.map(f => f.type)
    expect(types[0]).toBe('RUN_STARTED')
    expect(types[1]).toBe('CUSTOM')
    expect(types[2]).toBe('STATE_SNAPSHOT')
    expect(types.filter(t => t === 'TEXT_MESSAGE_CONTENT').length).toBeGreaterThan(1)
    expect(types.filter(t => t === 'TEXT_MESSAGE_START')).toHaveLength(1)
    expect(types.filter(t => t === 'TEXT_MESSAGE_END')).toHaveLength(1)
    expect(types.at(-1)).toBe('RUN_FINISHED')
    expect(types).not.toContain('RUN_ERROR')

    const ids = customEvent(frames, KIT_CUSTOM_EVENTS.chatIds) as Record<string, string>
    expect(ids).toMatchObject({
      conversationId: conv.id,
      model: 'fake-model',
      provider: 'anthropic_compatible',
    })
    const assistantId = ids.assistantMessageId as string
    const text = frames
      .filter(f => f.type === 'TEXT_MESSAGE_CONTENT')
      .map(f => f.delta)
      .join('')
    expect(text).toBe('Hello Ada, how can I help?')
    expect(customEvent(frames, KIT_CUSTOM_EVENTS.usage)).toEqual({
      usage: { inputTokens: 21, outputTokens: 8, cacheReadTokens: 3 },
    })
    // The terminal event restates the persisted row for a client that reads only it.
    expect(chatRunResultSchema.parse(frames.at(-1).result)).toMatchObject({
      conversationId: conv.id,
      messageId: assistantId,
      usage: { inputTokens: 21, outputTokens: 8, cacheReadTokens: 3 },
    })

    // The system prompt came from the `chat` registry entry with variables interpolated.
    const params: ChatParams | undefined = client.calls[0]
    expect(String(params?.system)).toContain(`helping ${a.user.name} at ${a.tenant.name}`)
    // Tools are on by default now (`CHAT_KNOWLEDGE_TOOLS`); `chat-tools.test.ts` covers them.
    expect(params?.tools?.map(t => t.name)).toEqual([
      'search_knowledge',
      'get_document',
      'list_documents',
    ])
    expect(params?.maxTokens).toBe(2048)

    // Persisted: user + assistant rows, usage on the assistant row, ai_usage ledger, title, lastMessageAt.
    const detail = conversationWithMessagesSchema.parse(
      await json(await request(`/api/chat/conversations/${conv.id}`, { headers: a.cookie }))
    )
    expect(detail.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(detail.messages[1]).toMatchObject({
      id: assistantId,
      content: 'Hello Ada, how can I help?',
      usage: { inputTokens: 21, outputTokens: 8, cacheReadTokens: 3 },
      toolCalls: null,
    })
    expect(detail.title).toBe('Hi there, I need a hand with something rather long so the ti')
    expect(detail.title.length).toBeLessThanOrEqual(60)
    expect(detail.lastMessageAt).toBeInstanceOf(Date)
    const ledger = await db.select().from(aiUsage).where(eq(aiUsage.tenantId, a.tenant.id))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      userId: a.user.id,
      feature: 'chat',
      provider: 'anthropic_compatible',
      model: 'fake-model',
      inputTokens: 21,
      outputTokens: 8,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      costMicrocents: null,
    })

    // Second turn carries the history and does not retitle.
    const res2 = await send(a.cookie, conv.id, 'Can you elaborate?')
    const frames2 = await aguiFrames(res2)
    expect(frames2.at(-1)?.type).toBe('RUN_FINISHED')
    expect(client.calls[1]?.messages.map(m => [m.role, m.content])).toEqual([
      [
        'user',
        'Hi there, I need a hand with something rather long so the title gets trimmed nicely',
      ],
      ['assistant', 'Hello Ada, how can I help?'],
      ['user', 'Can you elaborate?'],
    ])
    const [row] = await db.select().from(conversations).where(eq(conversations.id, conv.id))
    expect(row?.title).toBe('Hi there, I need a hand with something rather long so the ti')
    expect(
      await db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conv.id), eq(messages.tenantId, a.tenant.id)))
    ).toHaveLength(4)
  })

  it('not configured → 503 ai_not_configured JSON before any stream; the user message is NOT persisted', async () => {
    const a = await actor()
    script([{ text: 'x' }])
    const conv = await createConversation(a.cookie)
    state.client = null
    const res = await send(a.cookie, conv.id, 'hello?')
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await json(res)).toMatchObject({
      error: expect.any(String),
      statusCode: 503,
      code: 'ai_not_configured',
    })
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, conv.id))
    ).toHaveLength(0)
  })

  it('a provider failure mid-stream → RUN_ERROR with a code, no RUN_FINISHED, user message kept', async () => {
    const a = await actor()
    script([{ error: new AiError('rate_limit', 'anthropic_compatible', 'slow down', 429) }])
    const conv = await createConversation(a.cookie)
    const frames = await aguiFrames(await send(a.cookie, conv.id, 'hi'))
    expect(aguiTypes(frames)).toEqual(['RUN_STARTED', 'CUSTOM', 'STATE_SNAPSHOT', 'RUN_ERROR'])
    const err = frames.at(-1)
    expect(err?.type === 'RUN_ERROR' && err).toMatchObject({
      code: 'rate_limit',
      message: expect.stringMatching(/rate-limited/),
    })
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.id))
    expect(rows.map(r => r.role)).toEqual(['user'])
    expect(await db.select().from(aiUsage).where(eq(aiUsage.tenantId, a.tenant.id))).toHaveLength(0)
  })

  it('serves protobuf when the client negotiates it, and falls back to SSE otherwise', async () => {
    const a = await actor()
    script([{ text: 'Hi', usage: { inputTokens: 1, outputTokens: 1 } }])
    const conv = await createConversation(a.cookie)

    const proto = await request(
      `/api/chat/conversations/${conv.id}/messages`,
      {
        method: 'POST',
        headers: { ...a.cookie, Accept: 'application/vnd.ag-ui.event+proto' },
      },
      { json: { content: 'hello' } }
    )
    expect(proto.headers.get('content-type')).toContain('application/vnd.ag-ui.event+proto')
    // Length-prefixed frames: a 4-byte big-endian length, then that many protobuf bytes.
    const bytes = new Uint8Array(await proto.arrayBuffer())
    const view = new DataView(bytes.buffer)
    const decoded: string[] = []
    for (let at = 0; at < bytes.length; ) {
      const length = view.getUint32(at, false)
      decoded.push((decodeProto(bytes.slice(at + 4, at + 4 + length)) as { type: string }).type)
      at += 4 + length
    }
    expect(decoded[0]).toBe('RUN_STARTED')
    expect(decoded.at(-1)).toBe('RUN_FINISHED')

    // A garbage Accept is not an error: SSE is the fallback.
    script([{ text: 'Hi' }])
    const garbage = await request(
      `/api/chat/conversations/${conv.id}/messages`,
      { method: 'POST', headers: { ...a.cookie, Accept: 'application/nonsense' } },
      { json: { content: 'again' } }
    )
    expect(garbage.headers.get('content-type')).toContain('text/event-stream')
    expect(aguiTypes(await aguiFrames(garbage)).at(-1)).toBe('RUN_FINISHED')
  })

  it('a cancelled run emits no terminal event and persists nothing', async () => {
    const a = await actor()
    // Long enough that the reply is still streaming when the reader goes away.
    script([{ text: Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ') }])
    const conv = await createConversation(a.cookie)
    const res = await send(a.cookie, conv.id, 'go on')
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    const first = await reader.read()
    await reader.cancel()
    expect(new TextDecoder().decode(first.value)).toContain('RUN_STARTED')
    // The stream body runs on after the Response is returned; let it notice and unwind.
    await new Promise(resolve => setTimeout(resolve, 250))
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.id))
    expect(rows.map(r => r.role)).toEqual(['user'])
    expect(await db.select().from(aiUsage).where(eq(aiUsage.tenantId, a.tenant.id))).toHaveLength(0)
  })

  it('validates the body (400) and rejects a non-UUID id (404)', async () => {
    const a = await actor()
    script([{ text: 'x' }])
    const conv = await createConversation(a.cookie)
    expect((await send(a.cookie, conv.id, '')).status).toBe(400)
    expect((await send(a.cookie, 'nope', 'hi')).status).toBe(404)
  })
})

describe('ownership, listing, deletion', () => {
  it("another user's conversation is 404 for members AND admins of the same tenant; other tenant too", async () => {
    const a = await actor()
    script([{ text: 'x' }])
    const conv = await createConversation(a.cookie, 'Private')
    const admin = await createTestUser(db)
    await linkUserToTenant(db, admin.id, a.tenant.id, 'admin')
    const ac = sessionCookieHeader(await createTestSession(db, admin.id, a.tenant.id))
    for (const cookie of [ac, (await actor()).cookie]) {
      expect(
        (await request(`/api/chat/conversations/${conv.id}`, { headers: cookie })).status
      ).toBe(404)
      expect((await send(cookie, conv.id, 'hi')).status).toBe(404)
      expect(
        (await request(`/api/chat/conversations/${conv.id}`, { method: 'DELETE', headers: cookie }))
          .status
      ).toBe(404)
    }
    const list = await json<{ items: Array<{ id: string }> }>(
      await request('/api/chat/conversations', { headers: ac })
    )
    expect(list.items.map(i => i.id)).not.toContain(conv.id)
    expect((await request(`/api/chat/conversations/${conv.id}`)).status).toBe(401)
  })

  it('lists mine, most recent first, paginated; delete cascades messages', async () => {
    const a = await actor()
    script([{ text: 'reply' }])
    const c1 = await createConversation(a.cookie, 'First')
    const c2 = await createConversation(a.cookie, 'Second')
    await aguiFrames(await send(a.cookie, c1.id, 'bump'))
    const page = await json<{
      items: Array<{ id: string; title: string }>
      pagination: { total: number; pageSize: number }
    }>(await request('/api/chat/conversations?pageSize=1', { headers: a.cookie }))
    expect(page.pagination).toMatchObject({ total: 2, pageSize: 1 })
    expect(page.items.map(i => i.id)).toEqual([c1.id])
    const page2 = await json<{ items: Array<{ id: string }> }>(
      await request('/api/chat/conversations?pageSize=1&page=2', { headers: a.cookie })
    )
    expect(page2.items.map(i => i.id)).toEqual([c2.id])

    expect(
      (await request(`/api/chat/conversations/${c1.id}`, { method: 'DELETE', headers: a.cookie }))
        .status
    ).toBe(204)
    expect((await request(`/api/chat/conversations/${c1.id}`, { headers: a.cookie })).status).toBe(
      404
    )
    expect(await db.select().from(messages).where(eq(messages.conversationId, c1.id))).toHaveLength(
      0
    )
  })
})

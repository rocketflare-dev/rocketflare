// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the provider seam), so this file needs its own module registry.
/**
 * Chat with the knowledge tools (D18). The one that matters is the FIRST test: the tools are built
 * from the STREAM's database client, not the request's. The request's client is closed in
 * `waitUntil` the moment the Response is returned — before the stream body runs — so building them
 * from it makes every `search_knowledge` fail after the first frame, as an error frame,
 * intermittently, only where `waitUntil` really runs. Asserting that a tool call inside the stream
 * comes back with real rows is what pins it.
 *
 * Also here: the tool loop's turn cap is the chat cap and not `AGENT_MAX_TURNS`, the AG-UI tool
 * sequence reaches the client, `messages.toolCalls` is persisted, `CHAT_KNOWLEDGE_TOOLS=false`
 * sends no tools at all, and the Workers AI notice.
 */
import { KIT_CUSTOM_EVENTS } from '@rocketflare/shared/ai/agui'
import { CHAT_MAX_TOOL_TURNS, conversationSchema } from '@rocketflare/shared/ai/chat'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_KNOWLEDGE_TOOL } from '@/api/services/agents/tools'
import { AiNotConfiguredError } from '@/api/services/ai/errors'
import { ingestText } from '@/api/services/ai/ingest'
import { loadConfig } from '@/config'
import { messages } from '@/db/schema'
import { aguiFrames, aguiTypes, customEvent, FakeChatClient, type FakeScript } from '../helpers/ai'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const state: {
  client: FakeChatClient | null
  provider: 'anthropic_compatible' | 'workers_ai'
} = { client: null, provider: 'anthropic_compatible' }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      if (!state.client) throw new AiNotConfiguredError('chat')
      return {
        client: state.client,
        provider: state.provider,
        model: 'fake-model',
        source: 'tenant',
        maxOutputTokens: 2048,
      }
    }),
  }
})

const db = setupTestDatabase()

const VOLCANO =
  'A volcano is a rupture in the crust of a planet. Volcano eruptions eject lava and ash.'

/** Deterministic embeddings: the word "volcano" lands on one axis, everything else far away. */
function embeddingEnv(overrides: Record<string, unknown> = {}): TestEnv {
  const env = createTestEnv(overrides)
  const ai = stubs(env).ai
  if (ai) {
    ai.respond = (_model, inputs) => {
      const texts = Array.isArray(inputs.text) ? (inputs.text as string[]) : [String(inputs.text)]
      return {
        shape: [texts.length, 1024],
        data: texts.map(text => {
          const v = new Array<number>(1024).fill(0)
          v[text.toLowerCase().includes('volcano') ? 0 : 900] = 1
          return v
        }),
      }
    }
  }
  return env
}

function script(s: FakeScript) {
  state.client = new FakeChatClient(s, state.provider)
  return state.client
}

async function actor() {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function conversation(cookie: Record<string, string>, env: TestEnv) {
  const res = await request('/api/chat/conversations', { method: 'POST', headers: cookie }, { env })
  expect(res.status).toBe(201)
  return conversationSchema.parse(await json(res))
}

const send = (cookie: Record<string, string>, env: TestEnv, id: string, content: string) =>
  request(
    `/api/chat/conversations/${id}/messages`,
    { method: 'POST', headers: cookie },
    { env, json: { content } }
  )

beforeEach(() => {
  state.client = null
  state.provider = 'anthropic_compatible'
})

describe('chat with the knowledge tools', () => {
  it('runs a tool call inside the stream against the stream’s own database client', async () => {
    const a = await actor()
    const env = embeddingEnv()
    await ingestText(db, loadConfig(env), env, {
      tenantId: a.tenant.id,
      userId: a.user.id,
      title: 'Volcanoes',
      text: VOLCANO,
    })
    const client = script([
      { toolUses: [{ id: 'call_1', name: SEARCH_KNOWLEDGE_TOOL, input: { query: 'volcano' } }] },
      { text: 'Volcanoes erupt.', usage: { inputTokens: 30, outputTokens: 4 } },
    ])
    const conv = await conversation(a.cookie, env)
    const frames = await aguiFrames(await send(a.cookie, env, conv.id, 'Tell me about volcanoes'))

    expect(aguiTypes(frames)).toEqual([
      'RUN_STARTED',
      'CUSTOM',
      'STATE_SNAPSHOT',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      // `CUSTOM kit.document` follows the result it was derived from (D18).
      'CUSTOM',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'CUSTOM',
      'RUN_FINISHED',
    ])
    const start = frames.find(f => f.type === 'TOOL_CALL_START')
    expect(start?.type === 'TOOL_CALL_START' && start).toMatchObject({
      toolCallId: 'call_1',
      toolCallName: SEARCH_KNOWLEDGE_TOOL,
      parentMessageId: expect.any(String),
    })
    const args = frames.find(f => f.type === 'TOOL_CALL_ARGS')
    expect(JSON.parse(args?.type === 'TOOL_CALL_ARGS' ? args.delta : '{}')).toEqual({
      query: 'volcano',
    })

    // The result is the tool's own JSON, and it contains REAL rows — the proof the tools are
    // bound to a live client rather than the request's, which is already closed by now.
    const result = frames.find(f => f.type === 'TOOL_CALL_RESULT')
    const payload = JSON.parse(result?.type === 'TOOL_CALL_RESULT' ? result.content : '{}')
    expect(payload.error).toBeUndefined()
    expect(payload.documents?.[0]).toMatchObject({ title: 'Volcanoes' })
    expect(payload.documents[0].passages[0].text).toContain('volcano')

    // …and the same document comes back as a kit CUSTOM card, so the UI never has to parse the
    // tool's internal JSON — which `search-knowledge.ts` retunes whenever its budget changes.
    const card = customEvent(frames, KIT_CUSTOM_EVENTS.document)
    expect(card).toMatchObject({
      card: {
        id: payload.documents[0].documentId,
        title: 'Volcanoes',
        // A search result knows the title and the passage count and NOTHING else — it does not
        // guess a type or a size, because a wrong "Text" badge on a PDF is worse than no badge.
        typeLabel: null,
        contentType: null,
        sizeBytes: null,
        status: 'indexed',
        href: `/documents/${payload.documents[0].documentId}`,
      },
    })

    // The tool definitions and the chat turn cap reached the model. The kit's three lead and an
    // installed plugin's tools (D31) follow, so this is a prefix rather than the whole list.
    expect(client.calls[0]?.tools?.map(t => t.name).slice(0, 3)).toEqual([
      SEARCH_KNOWLEDGE_TOOL,
      'get_document',
      'list_documents',
    ])
    expect(client.calls[0]?.toolChoice).toEqual({ type: 'auto' })

    // The tool call is persisted on the assistant row (the column already existed; now it fills).
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.id))
    const assistant = rows.find(r => r.role === 'assistant')
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      id: 'call_1',
      name: SEARCH_KNOWLEDGE_TOOL,
      isError: false,
    })
  })

  it('caps the tool loop at the chat cap, not AGENT_MAX_TURNS', async () => {
    const a = await actor()
    const env = embeddingEnv({ AGENT_MAX_TURNS: '30' })
    // Never stops calling tools: the loop ends only because the cap does.
    const client = script(() => ({
      toolUses: [{ name: 'list_documents', input: {} }],
    }))
    const conv = await conversation(a.cookie, env)
    await aguiFrames(await send(a.cookie, env, conv.id, 'go'))
    expect(loadConfig(env).AGENT_MAX_TURNS).toBe(30)
    expect(client.calls).toHaveLength(CHAT_MAX_TOOL_TURNS)
  })

  it('sends no tools at all when CHAT_KNOWLEDGE_TOOLS is off', async () => {
    const a = await actor()
    const env = embeddingEnv({ CHAT_KNOWLEDGE_TOOLS: 'false' })
    const client = script([{ text: 'Hi' }])
    const conv = await conversation(a.cookie, env)
    const frames = await aguiFrames(await send(a.cookie, env, conv.id, 'hello'))
    expect(client.calls[0]?.tools).toBeUndefined()
    const snapshot = frames.find(f => f.type === 'STATE_SNAPSHOT')
    expect(snapshot?.type === 'STATE_SNAPSHOT' && snapshot.snapshot.tools).toEqual([])
    expect(aguiTypes(frames)).not.toContain('TOOL_CALL_START')
  })

  it('warns once that Workers AI cannot stream token by token with tools on', async () => {
    const a = await actor()
    state.provider = 'workers_ai'
    const env = embeddingEnv()
    script([{ text: 'Hi' }])
    const conv = await conversation(a.cookie, env)
    const frames = await aguiFrames(await send(a.cookie, env, conv.id, 'hello'))
    expect(customEvent(frames, KIT_CUSTOM_EVENTS.notice)).toEqual({
      code: 'workers_ai_no_token_streaming',
    })

    // Not raised when there are no tools to slow down.
    const quiet = embeddingEnv({ CHAT_KNOWLEDGE_TOOLS: 'false' })
    script([{ text: 'Hi' }])
    const conv2 = await conversation(a.cookie, quiet)
    const frames2 = await aguiFrames(await send(a.cookie, quiet, conv2.id, 'hello'))
    expect(customEvent(frames2, KIT_CUSTOM_EVENTS.notice)).toBeUndefined()
  })
})

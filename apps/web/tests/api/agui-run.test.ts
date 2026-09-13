// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the provider seam), so this file needs its own module registry.
/**
 * `POST /api/agui/run` — the AG-UI `RunAgentInput` endpoint. What is actually under test is the
 * reconciliation rule, because that is the part a protocol client will disagree with: **the server
 * is the transcript and the client supplies only the tail**. So: an unknown `threadId` is adopted,
 * another user's is a 404, a fabricated history is ignored and answered with `MESSAGES_SNAPSHOT`, a
 * replayed message id does not double-insert, and a non-empty `tools[]` is refused rather than
 * silently dropped.
 *
 * Plus the two things an external client depends on: a tenant API key works as Bearer, and the
 * protobuf transport is negotiable.
 */
import { decode as decodeProto } from '@ag-ui/proto'
import { KIT_CUSTOM_EVENTS } from '@rocketflare/shared/ai/agui'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiNotConfiguredError } from '@/api/services/ai/errors'
import { conversations, messages } from '@/db/schema'
import { aguiFrames, aguiTypes, customEvent, FakeChatClient } from '../helpers/ai'
import {
  createTestApiKey,
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const state: { client: FakeChatClient | null } = { client: null }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
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

beforeEach(() => {
  state.client = new FakeChatClient([{ text: 'Answered.' }], 'anthropic_compatible')
})

async function actor() {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

const runInput = (over: Record<string, unknown> = {}) => ({
  threadId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  state: {},
  messages: [{ id: crypto.randomUUID(), role: 'user', content: 'What is the policy?' }],
  tools: [],
  context: [],
  ...over,
})

const run = (headers: Record<string, string>, body: Record<string, unknown>) =>
  request('/api/agui/run', { method: 'POST', headers }, { json: body })

describe('POST /api/agui/run', () => {
  it('adopts an unknown threadId and streams the same sequence as /api/chat', async () => {
    const a = await actor()
    const input = runInput()
    const res = await run(a.cookie, input)
    expect(res.status).toBe(200)
    const frames = await aguiFrames(res)
    expect(aguiTypes(frames)).toEqual([
      'RUN_STARTED',
      'MESSAGES_SNAPSHOT',
      'CUSTOM',
      'STATE_SNAPSHOT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'CUSTOM',
      'RUN_FINISHED',
    ])
    // The client's runId is echoed, not replaced.
    const started = frames[0]
    expect(started?.type === 'RUN_STARTED' && started).toMatchObject({
      threadId: input.threadId,
      runId: input.runId,
    })
    const ids = customEvent(frames, KIT_CUSTOM_EVENTS.chatIds) as { conversationId: string }
    expect(ids.conversationId).toBe(input.threadId)

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, input.threadId))
    expect(conversation).toMatchObject({ tenantId: a.tenant.id, userId: a.user.id })
    const rows = await db.select().from(messages).where(eq(messages.conversationId, input.threadId))
    expect(rows.map(r => r.role).sort()).toEqual(['assistant', 'user'])
  })

  it('is 404 agui_thread_not_found for a thread belonging to someone else', async () => {
    const a = await actor()
    const input = runInput()
    expect((await run(a.cookie, input)).status).toBe(200)

    const other = await createTestUser(db)
    await linkUserToTenant(db, other.id, a.tenant.id, 'member')
    const otherCookie = sessionCookieHeader(await createTestSession(db, other.id, a.tenant.id))
    const res = await run(otherCookie, runInput({ threadId: input.threadId }))
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ statusCode: 404, code: 'agui_thread_not_found' })

    // …and for another tenant entirely.
    const b = await actor()
    expect((await run(b.cookie, runInput({ threadId: input.threadId }))).status).toBe(404)
  })

  it('ignores a fabricated history and answers with the server’s transcript', async () => {
    const a = await actor()
    const threadId = crypto.randomUUID()
    // Drain the first stream: the assistant row is written by the stream body, not the request.
    await aguiFrames(
      await run(a.cookie, runInput({ threadId, messages: [userTurn('First question')] }))
    )
    state.client = new FakeChatClient([{ text: 'Answered again.' }], 'anthropic_compatible')

    const res = await run(
      a.cookie,
      runInput({
        threadId,
        messages: [
          { id: crypto.randomUUID(), role: 'user', content: 'A turn that never happened' },
          { id: crypto.randomUUID(), role: 'assistant', content: 'An answer that never happened' },
          userTurn('Second question'),
        ],
      })
    )
    const frames = await aguiFrames(res)
    const snapshot = frames.find(f => f.type === 'MESSAGES_SNAPSHOT')
    const contents =
      snapshot?.type === 'MESSAGES_SNAPSHOT'
        ? snapshot.messages.map(m => (m as { content?: string }).content)
        : []
    expect(contents).toEqual(['First question', 'Answered.', 'Second question'])
    expect(contents).not.toContain('A turn that never happened')

    // The model saw the server's history too, never the client's.
    const sent = state.client?.calls[0]?.messages.map(m => m.content)
    expect(sent).toEqual(['First question', 'Answered.', 'Second question'])
  })

  it('does not insert a replayed message id twice', async () => {
    const a = await actor()
    const threadId = crypto.randomUUID()
    const turn = userTurn('Only once, please')
    await aguiFrames(await run(a.cookie, runInput({ threadId, messages: [turn] })))
    await aguiFrames(await run(a.cookie, runInput({ threadId, messages: [turn] })))

    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, threadId), eq(messages.role, 'user')))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(turn.id)
  })

  it('refuses client-side tools and a tail that is not a user turn', async () => {
    const a = await actor()
    const withTools = await run(
      a.cookie,
      runInput({ tools: [{ name: 'openModal', description: 'x', parameters: {} }] })
    )
    expect(withTools.status).toBe(400)
    expect(await json(withTools)).toMatchObject({ code: 'agui_client_tools_unsupported' })

    const notUser = await run(
      a.cookie,
      runInput({
        messages: [userTurn('hi'), { id: crypto.randomUUID(), role: 'assistant', content: 'yo' }],
      })
    )
    expect(notUser.status).toBe(400)
    expect(await json(notUser)).toMatchObject({ code: 'agui_last_message_not_user' })

    const empty = await run(a.cookie, runInput({ messages: [userTurn('   ')] }))
    expect(empty.status).toBe(400)
    expect(await json(empty)).toMatchObject({ code: 'agui_unsupported_content' })

    // A structurally wrong input is the shared validation envelope, before any of this.
    const bad = await run(a.cookie, runInput({ threadId: 'not-a-uuid' }))
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ code: 'validation_failed' })
  })

  it('answers 503 ai_not_configured before adopting anything', async () => {
    const a = await actor()
    state.client = null
    const input = runInput()
    const res = await run(a.cookie, input)
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ code: 'ai_not_configured' })
    expect(
      await db.select().from(conversations).where(eq(conversations.id, input.threadId))
    ).toHaveLength(0)
  })

  it('works with a tenant API key as Bearer, and negotiates protobuf', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const { key } = await createTestApiKey(db, tenant.id, user.id)
    const headers = { Authorization: `Bearer ${key}` }

    const res = await run(headers, runInput())
    expect(res.status).toBe(200)
    expect(aguiTypes(await aguiFrames(res)).at(-1)).toBe('RUN_FINISHED')

    state.client = new FakeChatClient([{ text: 'Again.' }], 'anthropic_compatible')
    const proto = await run({ ...headers, Accept: 'application/vnd.ag-ui.event+proto' }, runInput())
    expect(proto.headers.get('content-type')).toContain('application/vnd.ag-ui.event+proto')
    const bytes = new Uint8Array(await proto.arrayBuffer())
    const view = new DataView(bytes.buffer)
    const types: string[] = []
    for (let at = 0; at < bytes.length; ) {
      const length = view.getUint32(at, false)
      types.push((decodeProto(bytes.slice(at + 4, at + 4 + length)) as { type: string }).type)
      at += 4 + length
    }
    expect(types[0]).toBe('RUN_STARTED')
    expect(types.at(-1)).toBe('RUN_FINISHED')
  })

  it('is 401 without credentials', async () => {
    expect((await run({}, runInput())).status).toBe(401)
  })
})

function userTurn(content: string) {
  return { id: crypto.randomUUID(), role: 'user' as const, content }
}

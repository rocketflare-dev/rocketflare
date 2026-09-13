// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the provider seam), so this file needs its own module registry.
/**
 * Chat history compaction (D17): the `chat.compact` job folds the messages that no longer fit a
 * conversation's character budget into `conversations.summary`, and the next turn replays that
 * summary instead of the messages.
 *
 * The handler is a plain function, so it is called directly (`.claude/rules/testing.md`). What is
 * worth pinning: the rolling fold (the previous summary goes IN), the watermark, the
 * compare-and-set that makes two concurrent runs safe, the min-chars floor that stops a model call
 * per turn, and that a tenant with no provider degrades to "forgets" rather than a failing job.
 */
import { KIT_CUSTOM_EVENTS } from '@rocketflare/shared/ai/agui'
import { CHAT_COMPACTION_MIN_CHARS } from '@rocketflare/shared/ai/chat'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleChatCompact } from '@/api/queues/handlers/chat-compact'
import type { JobContext } from '@/api/queues/jobs'
import { AiNotConfiguredError } from '@/api/services/ai/errors'
import { loadConfig } from '@/config'
import { conversations, messages } from '@/db/schema'
import { aguiFrames, customEvent, FakeChatClient } from '../helpers/ai'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { request } from '../helpers/request'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

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

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as JobContext['logger']
}

/** Long enough that a handful of them blow any small budget. */
const LONG = 'x'.repeat(1_200)

beforeEach(() => {
  state.client = null
})

function summariser(summary: string) {
  state.client = new FakeChatClient(
    [{ toolUses: [{ name: 'submit_summary', input: { summary } }] }],
    'anthropic_compatible'
  )
  return state.client
}

async function thread(count: number, content = LONG) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const [conversation] = await db
    .insert(conversations)
    .values({
      tenantId: tenant.id,
      userId: user.id,
      provider: 'anthropic_compatible',
      model: 'fake-model',
    })
    .returning()
  if (!conversation) throw new Error('no conversation')
  const rows = await db
    .insert(messages)
    .values(
      // Distinct timestamps: a real thread inserts one message per turn, and `createdAt` is what
      // orders the transcript. A bulk insert would tie them and fall back to random uuids.
      Array.from({ length: count }, (_, i) => ({
        conversationId: conversation.id,
        tenantId: tenant.id,
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `${i}: ${content}`,
        createdAt: new Date(Date.now() - (count - i) * 60_000),
      }))
    )
    .returning()
  return {
    user,
    tenant,
    conversation,
    rows,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

function jobContext(env: TestEnv): JobContext {
  return { env, config: loadConfig(env), logger: fakeLogger(), db }
}

const compactJob = (tenantId: string, conversationId: string) =>
  ({
    id: crypto.randomUUID(),
    type: 'chat.compact' as const,
    enqueuedAt: new Date().toISOString(),
    payload: { tenantId, conversationId },
  }) as never

const reload = async (id: string) =>
  db.query.conversations.findFirst({ where: eq(conversations.id, id) })

describe('the chat.compact job', () => {
  it('summarises the messages outside the budget and records the watermark', async () => {
    const t = await thread(8)
    const env = createTestEnv({ CHAT_HISTORY_MAX_CHARS: '2500' })
    summariser('User asked about volcanoes; assistant explained eruptions.')
    await handleChatCompact(compactJob(t.tenant.id, t.conversation.id), jobContext(env))

    const after = await reload(t.conversation.id)
    expect(after?.summary).toBe('User asked about volcanoes; assistant explained eruptions.')
    // 2 messages fit the 2 500-char budget, so the watermark is the 6th of 8.
    expect(after?.summarisedThroughId).toBe(t.rows[5]?.id)
  })

  it('folds the previous summary in rather than replacing it blind', async () => {
    const t = await thread(8)
    const env = createTestEnv({ CHAT_HISTORY_MAX_CHARS: '2500' })
    await db
      .update(conversations)
      .set({ summary: 'Earlier: user is migrating from Postgres 14.' })
      .where(eq(conversations.id, t.conversation.id))

    const client = summariser('User is migrating from Postgres 14 and asked about volcanoes.')
    await handleChatCompact(compactJob(t.tenant.id, t.conversation.id), jobContext(env))

    // The existing summary was given to the model as material, not thrown away.
    const sent = String(client.calls[0]?.messages[0]?.content)
    expect(sent).toContain('Earlier: user is migrating from Postgres 14.')
    expect((await reload(t.conversation.id))?.summary).toContain('Postgres 14')
  })

  it('does not spend a model call on a sentence', async () => {
    // The window slides a message or two per turn, so this runs often; the floor is what stops it
    // being more expensive than the problem.
    const t = await thread(6, 'x'.repeat(200))
    const env = createTestEnv({ CHAT_HISTORY_MAX_CHARS: '1000' })
    const client = summariser('unused')
    await handleChatCompact(compactJob(t.tenant.id, t.conversation.id), jobContext(env))
    expect(client.calls).toHaveLength(0)
    expect((await reload(t.conversation.id))?.summary).toBeNull()
    // Sanity: the pending material really was under the floor.
    expect(CHAT_COMPACTION_MIN_CHARS).toBeGreaterThan(200 * 3)
  })

  it('is a no-op once the watermark already covers the dropped messages', async () => {
    const t = await thread(8)
    const env = createTestEnv({ CHAT_HISTORY_MAX_CHARS: '2500' })
    summariser('first pass')
    await handleChatCompact(compactJob(t.tenant.id, t.conversation.id), jobContext(env))

    const client = summariser('second pass')
    await handleChatCompact(compactJob(t.tenant.id, t.conversation.id), jobContext(env))
    expect(client.calls).toHaveLength(0)
    expect((await reload(t.conversation.id))?.summary).toBe('first pass')
  })

  it('lets the run that moved the watermark first win, without a lost update', async () => {
    const t = await thread(8)
    const env = createTestEnv({ CHAT_HISTORY_MAX_CHARS: '2500' })
    // Both runs read the same state before either writes — the interleave two queue deliveries
    // for one conversation actually produce. The compare-and-set is what makes that safe.
    state.client = new FakeChatClient(
      (_params, index) => ({
        toolUses: [{ name: 'submit_summary', input: { summary: `run ${index}` } }],
      }),
      'anthropic_compatible'
    )
    const loggers = [fakeLogger(), fakeLogger()]
    await Promise.all(
      loggers.map(logger =>
        handleChatCompact(compactJob(t.tenant.id, t.conversation.id), {
          ...jobContext(env),
          logger,
        })
      )
    )

    const after = await reload(t.conversation.id)
    // One summary, not a blend of two, and the watermark is consistent with it.
    expect(['run 0', 'run 1']).toContain(after?.summary)
    expect(after?.summarisedThroughId).toBe(t.rows[5]?.id)
    const discarded = loggers.filter(logger =>
      (logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(call =>
        String(call[1]).includes('another run compacted first')
      )
    )
    expect(discarded).toHaveLength(1)
  })

  it('skips quietly when the tenant has no chat provider', async () => {
    const t = await thread(8)
    const env = createTestEnv({ CHAT_HISTORY_MAX_CHARS: '2500' })
    state.client = null
    // Returns rather than throwing: a thread that forgets still works, and a retry cannot help.
    await expect(
      handleChatCompact(compactJob(t.tenant.id, t.conversation.id), jobContext(env))
    ).resolves.toBeUndefined()
    expect((await reload(t.conversation.id))?.summary).toBeNull()
  })

  it('ignores a conversation that was deleted between enqueue and delivery', async () => {
    const t = await thread(2)
    await db.delete(conversations).where(eq(conversations.id, t.conversation.id))
    await expect(
      handleChatCompact(compactJob(t.tenant.id, t.conversation.id), jobContext(createTestEnv()))
    ).resolves.toBeUndefined()
  })
})

describe('a chat turn over the budget', () => {
  it('trims the prefix, enqueues compaction and says which it did', async () => {
    const t = await thread(8)
    const env = createTestEnv({ CHAT_HISTORY_MAX_CHARS: '2500', CHAT_KNOWLEDGE_TOOLS: 'false' })
    const client = new FakeChatClient([{ text: 'Answered.' }], 'anthropic_compatible')
    state.client = client

    const frames = await aguiFrames(
      await request(
        `/api/chat/conversations/${t.conversation.id}/messages`,
        { method: 'POST', headers: t.cookie },
        { env, json: { content: 'and now?' } }
      )
    )
    // No summary exists yet, so this turn answers without the prefix — and admits it.
    expect(customEvent(frames, KIT_CUSTOM_EVENTS.notice)).toEqual({ code: 'history_truncated' })
    expect(client.calls[0]?.messages.length).toBeLessThan(9)
    expect(stubs(env).queue?.messages.map(m => (m.body as { type: string }).type)).toContain(
      'chat.compact'
    )
  })

  it('replays the summary as the system prompt’s volatile half, and says so', async () => {
    const t = await thread(8)
    const env = createTestEnv({ CHAT_HISTORY_MAX_CHARS: '2500', CHAT_KNOWLEDGE_TOOLS: 'false' })
    await db
      .update(conversations)
      .set({ summary: 'User is migrating from Postgres 14.', summarisedThroughId: t.rows[5]?.id })
      .where(eq(conversations.id, t.conversation.id))

    const client = new FakeChatClient([{ text: 'Answered.' }], 'anthropic_compatible')
    state.client = client
    const frames = await aguiFrames(
      await request(
        `/api/chat/conversations/${t.conversation.id}/messages`,
        { method: 'POST', headers: t.cookie },
        { env, json: { content: 'and now?' } }
      )
    )
    expect(customEvent(frames, KIT_CUSTOM_EVENTS.notice)).toEqual({ code: 'history_summarised' })
    const system = client.calls[0]?.system
    expect(typeof system === 'object' && system.volatile).toContain(
      'User is migrating from Postgres 14.'
    )
    // The cacheable half is untouched by the summary.
    expect(typeof system === 'object' && system.stable).toContain('assistant built into')
  })

  it('says nothing when the thread fits', async () => {
    const t = await thread(2, 'short')
    const env = createTestEnv({ CHAT_KNOWLEDGE_TOOLS: 'false' })
    state.client = new FakeChatClient([{ text: 'Answered.' }], 'anthropic_compatible')
    const frames = await aguiFrames(
      await request(
        `/api/chat/conversations/${t.conversation.id}/messages`,
        { method: 'POST', headers: t.cookie },
        { env, json: { content: 'hello' } }
      )
    )
    expect(customEvent(frames, KIT_CUSTOM_EVENTS.notice)).toBeUndefined()
    expect(stubs(env).queue?.messages).toHaveLength(0)
  })
})

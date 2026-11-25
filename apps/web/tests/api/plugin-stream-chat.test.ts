// @vitest-isolate
// Mocks the server plugin barrel to install a fixture plugin, so it needs its own module registry.
/**
 * `streamChat` — a plugin route's scoped chat turn. Driven through the REAL app, the real resolve
 * seam and the real Workers AI adapter, with the platform model scripted by `scriptPlatformChat`
 * from `@testkit/integration` (the same helper a plugin's own test uses), so nothing in core is
 * mocked but the barrel that installs the fixture.
 *
 * Pinned: the 503 is an envelope before any frame; a tool call round-trips (built from the
 * stream's own client, its result fed back to the model); a plugin CUSTOM event reaches the wire
 * before `RUN_FINISHED`; a name outside `<id>.` — or under `kit.` — is refused with `RUN_ERROR`
 * `invalid_custom_event`, from `onFinish` and from inside a tool alike; usage lands under the
 * plugin's feature label; and a prompt or label outside the plugin's namespace never opens a stream.
 */

import {
  aguiFrames,
  aguiTypes,
  createTestEnv,
  createTestSession,
  createTestTenantWithUser,
  customEvents,
  request,
  scriptPlatformChat,
  sessionCookieHeader,
  setupTestDatabase,
} from '@testkit/integration'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { aiUsage } from '@/db/schema'
import { customEventNameIssue, usageFeatureIssue } from '@/plugins/api'

vi.mock('@/plugins/server', async importOriginal => {
  const actual = await importOriginal<typeof import('@/plugins/server')>()
  const { z } = await import('zod')
  const { sql } = await import('drizzle-orm')
  const api = await import('@/plugins/api')
  const router = api.createRouter()
  router.post('/ask', async c => {
    const mode = c.req.query('mode') ?? 'ok'
    const body = (await c.req.json()) as {
      message: string
      history?: { role: 'user' | 'assistant'; content: string }[]
    }
    return api.streamChat(c, {
      promptKey: mode === 'foreign-prompt' ? 'chat' : 'chat-fixture-ask',
      feature: mode === 'bad-feature' ? 'guide:ask' : 'chat-fixture:ask',
      system: 'The person is on the Settings screen.',
      variables: { topic: 'widgets' },
      message: body.message,
      history: body.history,
      maxTurns: 4,
      tools: ctx => [
        api.defineTool({
          name: 'lookup_widget',
          description: 'Look a widget up',
          schema: z.object({ name: z.string() }),
          handler: async input => {
            // The stream's own client: the request's is closed by the time this runs.
            const [row] = api.rows<{ one: number }>(await ctx.db.execute(sql`select 1 as one`))
            if (mode === 'tool-refused') await ctx.emit('elsewhere.progress', {})
            else await ctx.emit('chat-fixture.progress', { looked: input.name })
            return JSON.stringify({ widget: input.name, tenantId: ctx.tenantId, one: row?.one })
          },
        }),
      ],
      onFinish: async (result, { emit }) => {
        if (mode === 'refused') await emit('other.answer', { text: result.text })
        else if (mode === 'kit') await emit('kit.usage', {})
        else await emit('chat-fixture.answer', { text: result.text, citations: ['/a'] })
      },
    })
  })
  const fixture = {
    shared: { id: 'chat-fixture', label: 'Chat fixture', promptKeys: ['chat-fixture-ask'] },
    prompts: {
      'chat-fixture-ask': {
        key: 'chat-fixture-ask',
        title: 'Fixture',
        description: 'Fixture prompt',
        variables: ['appName', 'topic'],
        defaultText: 'You answer questions about {{topic}} in {{appName}}.',
      },
    },
    mounts: [['/api/chat-fixture', router]],
  }
  const plugins = [...actual.serverPlugins, fixture]
  return { ...actual, SERVER_PLUGINS: plugins, serverPlugins: plugins }
})

const db = setupTestDatabase()

async function actor() {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

type Env = ReturnType<typeof createTestEnv>

const ask = (
  cookie: Record<string, string>,
  env: Env,
  json: unknown = { message: 'What is a widget?' },
  mode = 'ok'
) =>
  request(`/api/chat-fixture/ask?mode=${mode}`, { method: 'POST', headers: cookie }, { env, json })

const toolThenAnswer = [
  { toolCalls: [{ id: 'call_1', name: 'lookup_widget', input: { name: 'sprocket' } }] },
  { text: 'A sprocket is a widget.', usage: { inputTokens: 30, outputTokens: 7 } },
]

describe('streamChat — before the stream', () => {
  it('answers the 503 ai_not_configured envelope when no chat provider resolves', async () => {
    const a = await actor()
    const res = await ask(a.cookie, createTestEnv({ AI: undefined }))
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ statusCode: 503, code: 'ai_not_configured' })
  })

  it('refuses a prompt the plugin did not register, and a feature label outside its id', async () => {
    const a = await actor()
    const env = createTestEnv()
    const calls = scriptPlatformChat(env, [{ text: 'never' }])
    for (const mode of ['foreign-prompt', 'bad-feature']) {
      const res = await ask(a.cookie, env, undefined, mode)
      expect(res.status).toBe(500)
      expect(res.headers.get('content-type')).toContain('application/json')
    }
    expect(calls).toHaveLength(0)
  })
})

describe('streamChat — the stream', () => {
  it('round-trips a tool call, emits the plugin events in order and finishes', async () => {
    const a = await actor()
    const env = createTestEnv()
    const calls = scriptPlatformChat(env, toolThenAnswer)
    const res = await ask(a.cookie, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = await aguiFrames(res)
    const types = aguiTypes(events)
    expect(types[0]).toBe('RUN_STARTED')
    expect(types.at(-1)).toBe('RUN_FINISHED')
    expect(types).toContain('TOOL_CALL_START')
    expect(types).toContain('TOOL_CALL_RESULT')
    expect(types).not.toContain('RUN_ERROR')

    const result = events.find(e => e.type === 'TOOL_CALL_RESULT')
    expect(JSON.parse((result as { content: string }).content)).toEqual({
      widget: 'sprocket',
      tenantId: a.tenant.id,
      one: 1,
    })
    // The model saw the tool's result on its second call, and only the plugin's tool was offered.
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(calls[1]?.messages)).toContain('sprocket')
    expect(JSON.stringify(calls[0]?.tools)).toContain('lookup_widget')
    expect(JSON.stringify(calls[0]?.tools)).not.toContain('search_knowledge')
    // The plugin's prompt, interpolated, with the volatile context after it.
    const system = JSON.stringify(calls[0]?.messages[0])
    expect(system).toContain('You answer questions about widgets in')
    expect(system).toContain('The person is on the Settings screen.')

    const custom = customEvents(events)
    expect(custom.map(e => e.name)).toEqual([
      'chat-fixture.progress',
      'chat-fixture.answer',
      'kit.usage',
    ])
    expect(custom[1]?.value).toEqual({ text: 'A sprocket is a widget.', citations: ['/a'] })
    const text = events.flatMap(e => (e.type === 'TEXT_MESSAGE_CONTENT' ? [e.delta] : [])).join('')
    expect(text).toContain('A sprocket is a widget.')
  })

  it('records usage under the plugin feature label', async () => {
    const a = await actor()
    const env = createTestEnv()
    scriptPlatformChat(env, toolThenAnswer)
    await aguiFrames(await ask(a.cookie, env))
    const rows = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.tenantId, a.tenant.id), eq(aiUsage.feature, 'chat-fixture:ask')))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'workers_ai',
      userId: a.user.id,
      inputTokens: 40,
      outputTokens: 12,
    })
  })

  it.each([
    ['refused', 'other.answer'],
    ['kit', 'kit.usage'],
    ['tool-refused', 'elsewhere.progress'],
  ])('refuses a CUSTOM name outside the plugin namespace (%s)', async (mode, name) => {
    const a = await actor()
    const env = createTestEnv()
    scriptPlatformChat(env, toolThenAnswer)
    const events = await aguiFrames(await ask(a.cookie, env, undefined, mode))
    const types = aguiTypes(events)
    expect(types.at(-1)).toBe('RUN_ERROR')
    expect(types).not.toContain('RUN_FINISHED')
    expect(events.at(-1)).toMatchObject({ code: 'invalid_custom_event' })
    // Nothing under the refused name reached the wire — and `kit.usage` was not forged.
    expect(customEvents(events).filter(e => e.name === name)).toHaveLength(0)
  })

  it('trims a long history newest-first and says so', async () => {
    const a = await actor()
    const env = createTestEnv({ CHAT_HISTORY_MAX_CHARS: '50' })
    const calls = scriptPlatformChat(env, [{ text: 'ok' }])
    const history = [
      { role: 'user' as const, content: `OLDEST ${'x'.repeat(60)}` },
      { role: 'assistant' as const, content: 'old answer' },
      { role: 'user' as const, content: 'recent q' },
      { role: 'assistant' as const, content: 'newest answer' },
    ]
    const events = await aguiFrames(await ask(a.cookie, env, { message: 'next', history }))
    expect(customEvents(events)).toContainEqual({
      name: 'kit.notice',
      value: { code: 'history_truncated' },
    })
    const sent = JSON.stringify(calls[0]?.messages)
    expect(sent).toContain('newest answer')
    expect(sent).toContain('recent q')
    expect(sent).not.toContain('OLDEST')
    // The window opens on a user turn, so the orphaned assistant answer goes too.
    expect(sent).not.toContain('old answer')
  })
})

describe('the namespace rules', () => {
  it('customEventNameIssue', () => {
    expect(customEventNameIssue('guide', 'guide.answer')).toBeNull()
    expect(customEventNameIssue('guide', 'guide.')).not.toBeNull()
    expect(customEventNameIssue('guide', 'guidebook.answer')).not.toBeNull()
    expect(customEventNameIssue('guide', 'kit.usage')).not.toBeNull()
    expect(customEventNameIssue('kit', 'kit.usage')).not.toBeNull()
  })

  it('usageFeatureIssue', () => {
    expect(usageFeatureIssue('guide', 'guide')).toBeNull()
    expect(usageFeatureIssue('guide', 'guide:ask')).toBeNull()
    expect(usageFeatureIssue('guide', 'guide.rerank')).toBeNull()
    expect(usageFeatureIssue('guide', 'guide-chat')).not.toBeNull()
    expect(usageFeatureIssue('guide', 'chat')).not.toBeNull()
  })
})

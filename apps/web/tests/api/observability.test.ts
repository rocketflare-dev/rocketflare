/**
 * Tracing seam (D16), no database, injected fetch: `tracerFor` is the no-op without both keys;
 * the Langfuse tracer batches trace/generation/span events in memory and POSTs ONCE on `flush()`
 * with basic auth to `/api/public/ingestion`; `withAgentTrace` + `traceChatClient` emit a trace
 * with one generation per call (usage in Langfuse's cache-aware `usageDetails`); failures are
 * swallowed; the tracer middleware puts a tracer on every request and flushes after the handler.
 */
import { describe, expect, it } from 'vitest'
import { createLangfuseTracer, toUsageDetails } from '@/api/observability/langfuse-fetch'
import { noopTracer } from '@/api/observability/tracer'
import { traceChatClient, tracerFor, withAgentTrace } from '@/api/observability/tracing'
import { loadConfig } from '@/config'
import { FakeChatClient } from '../helpers/ai'
import { createTestEnv } from '../mocks/bindings'

interface Posted {
  url: string
  auth: string | null
  body: { batch: Array<{ type: string; body: Record<string, unknown> }> }
}

function recordingFetch(status = 200) {
  const posts: Posted[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    posts.push({
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)),
    })
    return new Response(JSON.stringify({ successes: [], errors: [] }), { status })
  }
  return { fetchImpl, posts }
}

describe('tracerFor', () => {
  it('is the no-op without both keys and a Langfuse tracer with them', () => {
    expect(
      tracerFor(loadConfig(createTestEnv({ LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '' })))
    ).toBe(noopTracer)
    expect(
      tracerFor(
        loadConfig(createTestEnv({ LANGFUSE_PUBLIC_KEY: 'pk-lf-x', LANGFUSE_SECRET_KEY: '' }))
      )
    ).toBe(noopTracer)
    const on = tracerFor(
      loadConfig(createTestEnv({ LANGFUSE_PUBLIC_KEY: 'pk-lf-x', LANGFUSE_SECRET_KEY: 'sk-lf-y' }))
    )
    expect(on.enabled).toBe(true)
    expect(on).not.toBe(noopTracer)
  })
})

describe('Langfuse fetch tracer', () => {
  it('batches events and posts once on flush with basic auth; a second flush with nothing queued sends nothing', async () => {
    const { fetchImpl, posts } = recordingFetch()
    const tracer = createLangfuseTracer({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lf.test/',
      environment: 'test',
      fetch: fetchImpl,
    })
    const trace = tracer.startTrace({
      name: 'chat',
      tenantId: 't1',
      userId: 'u1',
      sessionId: 'conv1',
      tags: ['chat'],
      input: 'hi',
    })
    trace.generation({
      name: 'anthropic.messages',
      model: 'claude-x',
      provider: 'anthropic',
      input: { messages: [] },
      output: [{ type: 'text', text: 'yo' }],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1 },
      startTime: new Date('2026-01-01T00:00:00Z'),
      endTime: new Date('2026-01-01T00:00:01Z'),
    })
    trace.span({ name: 'persist', startTime: new Date(), endTime: new Date() })
    trace.end({ output: 'yo' })
    expect(posts).toHaveLength(0)

    await tracer.flush()
    expect(posts).toHaveLength(1)
    const post = posts[0]
    expect(post?.url).toBe('https://lf.test/api/public/ingestion')
    expect(post?.auth).toBe(`Basic ${btoa('pk:sk')}`)
    const types = post?.body.batch.map(e => e.type)
    expect(types).toEqual(['trace-create', 'generation-create', 'span-create', 'trace-create'])
    const [first, gen, , last] = post?.body.batch ?? []
    expect(first?.body).toMatchObject({
      id: trace.id,
      name: 'chat',
      environment: 'test',
      userId: 'u1',
      sessionId: 'conv1',
      tags: ['chat'],
      input: 'hi',
      metadata: { tenantId: 't1' },
    })
    expect(gen?.body).toMatchObject({
      traceId: trace.id,
      model: 'claude-x',
      modelParameters: { provider: 'anthropic' },
      usageDetails: { input: 10, output: 5, cache_read: 4, cache_creation: 1, total: 20 },
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:01.000Z',
      level: 'DEFAULT',
    })
    expect(last?.body).toMatchObject({ id: trace.id, output: 'yo' })

    await tracer.flush()
    expect(posts).toHaveLength(1)
  })

  it('swallows transport and non-OK failures', async () => {
    const failing = createLangfuseTracer({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lf.test',
      fetch: async () => {
        throw new Error('boom')
      },
    })
    failing.startTrace({ name: 'x' })
    await expect(failing.flush()).resolves.toBeUndefined()
    const { fetchImpl } = recordingFetch(500)
    const nonOk = createLangfuseTracer({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lf.test',
      fetch: fetchImpl,
    })
    nonOk.startTrace({ name: 'x' })
    await expect(nonOk.flush()).resolves.toBeUndefined()
  })

  it('toUsageDetails sums cache tokens into total and omits absent cache fields', () => {
    expect(toUsageDetails({ inputTokens: 1, outputTokens: 2 })).toEqual({
      input: 1,
      output: 2,
      total: 3,
    })
    expect(toUsageDetails(undefined)).toBeUndefined()
  })
})

describe('withAgentTrace + traceChatClient', () => {
  it('one trace, one generation per call, output recorded, error recorded and rethrown', async () => {
    const { fetchImpl, posts } = recordingFetch()
    const tracer = createLangfuseTracer({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://lf.test',
      fetch: fetchImpl,
    })
    const fake = new FakeChatClient([
      { text: 'one two', usage: { inputTokens: 3, outputTokens: 2 } },
      { text: 'again' },
    ])
    const out = await withAgentTrace(
      'chat',
      { tracer, tenantId: 't', userId: 'u', input: 'q' },
      async trace => {
        const client = traceChatClient(fake, trace, { provider: 'anthropic' }, tracer)
        const a = await client.complete({
          model: 'm',
          maxTokens: 5,
          messages: [{ role: 'user', content: 'q' }],
        })
        let streamed = ''
        for await (const d of client.stream({ model: 'm', maxTokens: 5, messages: [] })) {
          if (d.type === 'text') streamed += d.text
        }
        return `${a.content[0]?.type === 'text' ? a.content[0].text : ''}|${streamed}`
      }
    )
    expect(out).toBe('one two|again')
    await tracer.flush()
    const batch = posts[0]?.body.batch ?? []
    expect(batch.map(e => e.type)).toEqual([
      'trace-create',
      'generation-create',
      'generation-create',
      'trace-create',
    ])
    expect(batch[1]?.body).toMatchObject({
      name: 'anthropic.messages',
      model: 'm',
      usageDetails: { input: 3, output: 2, total: 5 },
      output: [{ type: 'text', text: 'one two' }],
    })
    expect(batch[3]?.body).toMatchObject({ output: 'one two|again' })

    const failing = new FakeChatClient([{ error: new Error('nope') }])
    await expect(
      withAgentTrace('chat', { tracer }, trace =>
        traceChatClient(failing, trace, { provider: 'anthropic' }, tracer).complete({
          model: 'm',
          maxTokens: 1,
          messages: [],
        })
      )
    ).rejects.toThrow('nope')
    await tracer.flush()
    const second = posts[1]?.body.batch ?? []
    expect(second[1]?.body).toMatchObject({ level: 'ERROR', statusMessage: 'nope' })
    expect(second[2]?.body).toMatchObject({ metadata: { error: 'nope' } })
  })

  it('returns the raw client when the tracer is disabled', () => {
    const fake = new FakeChatClient([])
    expect(
      traceChatClient(
        fake,
        noopTracer.startTrace({ name: 'x' }),
        { provider: 'anthropic' },
        noopTracer
      )
    ).toBe(fake)
  })
})

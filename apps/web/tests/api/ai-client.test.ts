/**
 * `services/ai/client.ts` (D17) with an INJECTED fetch (no globals mocked): OpenAI-compatible
 * SSE parsing incl. tool-call deltas and usage; error normalisation 401→auth, 429→rate_limit,
 * 404→invalid_request; the Anthropic path through the real SDK against a fake SSE body (bearer
 * `authToken` for compatible vendors, explicit `thinking: disabled`, `reconcileThinking`);
 * embeddings over OpenAI-shaped `/embeddings` and the Workers AI binding; Workers AI CHAT over the
 * binding (non-streamed `{ response, tool_calls, usage }`, an SSE `ReadableStream`, the forced-tool
 * instruction that stands in for `tool_choice`, and the non-streamed replay when tools are present).
 */
import { describe, expect, it } from 'vitest'
import {
  createChatClient,
  createEmbeddingsClient,
  extractJsonObject,
  type FetchLike,
  forcedToolInstruction,
  reconcileThinking,
  recoverForcedToolCall,
  workersAiChatInputs,
} from '@/api/services/ai/client'
import { AiError, describeAiError, normalizeAiError, redactSecrets } from '@/api/services/ai/errors'
import { type ChatDelta, textOf } from '@/api/services/ai/types'
import { sseResponse } from '../helpers/ai'
import { RecordingAi } from '../mocks/bindings'

interface Captured {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** A fetch that records the request and answers with `respond()`. */
function fakeFetch(respond: (req: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const impl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const captured: Captured = {
      url: String(input instanceof Request ? input.url : input),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    }
    calls.push(captured)
    return respond(captured)
  }
  return { fetch: impl, calls }
}

async function collect(iter: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = []
  for await (const d of iter) out.push(d)
  return out
}

const openAiChunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: 'x', model: 'fake-1', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`

describe('OpenAI-compatible chat client', () => {
  it('streams text deltas, assembles tool calls from argument fragments, and reports usage', async () => {
    const { fetch, calls } = fakeFetch(() =>
      sseResponse([
        openAiChunk({ role: 'assistant', content: 'Hel' }),
        openAiChunk({ content: 'lo' }),
        openAiChunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":' },
            },
          ],
        }),
        openAiChunk({ tool_calls: [{ index: 0, function: { arguments: '"cats"}' } }] }),
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } })}\n\n`,
        'data: [DONE]\n\n',
      ])
    )
    const client = createChatClient({
      provider: 'openai_compatible',
      apiKey: 'k',
      baseUrl: 'http://mock/v1/',
      fetch,
    })
    const deltas = await collect(
      client.stream({
        model: 'fake-1',
        maxTokens: 50,
        system: { stable: 'SYS', volatile: 'now' },
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'search', description: 'd', inputSchema: { type: 'object' } }],
        toolChoice: { type: 'auto' },
      })
    )
    expect(deltas.map(d => d.type)).toEqual(['text', 'text', 'tool_use', 'usage', 'end'])
    expect(deltas[2]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'search',
      input: { q: 'cats' },
    })
    const end = deltas.at(-1)
    expect(end?.type === 'end' && end.result).toMatchObject({
      stopReason: 'tool_use',
      model: 'fake-1',
      usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 4 },
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', name: 'search' },
      ],
    })
    expect(calls[0]?.url).toBe('http://mock/v1/chat/completions')
    expect(calls[0]?.headers.authorization).toBe('Bearer k')
    expect(calls[0]?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 50,
      messages: [
        { role: 'system', content: 'SYS\n\nnow' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'search' } }],
      tool_choice: 'auto',
    })
  })

  it('complete() round-trips tool_result turns as role=tool messages', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            model: 'fake-1',
            choices: [
              { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
    const client = createChatClient({ provider: 'openai', apiKey: 'k', fetch })
    const result = await client.complete({
      model: 'fake-1',
      maxTokens: 10,
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'c1', name: 'search', input: { q: 'x' } }],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'found' }] },
      ],
    })
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 1 },
      model: 'fake-1',
    })
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(calls[0]?.body.messages).toEqual([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'found' },
    ])
  })

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [404, 'invalid_request'],
    [400, 'invalid_request'],
    [503, 'unavailable'],
  ] as const)('HTTP %i → AiError code %s, body never leaks a key', async (status, code) => {
    const { fetch } = fakeFetch(
      () => new Response(`{"error":"bad key sk-abcdefghijklmnopqrstuvwxyz012345"}`, { status })
    )
    const client = createChatClient({
      provider: 'openai_compatible',
      apiKey: 'sk-secret',
      baseUrl: 'http://mock/v1',
      fetch,
    })
    const err = await client
      .complete({ model: 'm', maxTokens: 1, messages: [{ role: 'user', content: 'x' }] })
      .catch(e => e)
    expect(err).toBeInstanceOf(AiError)
    expect(err.code).toBe(code)
    expect(err.status).toBe(status)
    expect(err.message).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(describeAiError(err)).toMatch(/provider/i)
  })

  it('requires a key and a base URL up front', () => {
    expect(() => createChatClient({ provider: 'openai_compatible', apiKey: 'k' })).toThrow(AiError)
    expect(() => createChatClient({ provider: 'openai', apiKey: '' })).toThrow(AiError)
    expect(() => createChatClient({ provider: 'workers_ai', apiKey: 'k' })).toThrow(
      /AI binding is not configured/
    )
  })
})

/** An Anthropic Messages SSE body for one text reply. */
function anthropicStream(text: string, toolUse?: { id: string; name: string; json: string }) {
  const ev = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const chunks = [
    ev('message_start', {
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 0,
        },
      },
    }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, 3) } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(3) } }),
    ev('content_block_stop', { index: 0 }),
  ]
  if (toolUse) {
    chunks.push(
      ev('content_block_start', {
        index: 1,
        content_block: { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} },
      }),
      ev('content_block_delta', {
        index: 1,
        delta: { type: 'input_json_delta', partial_json: toolUse.json },
      }),
      ev('content_block_stop', { index: 1 })
    )
  }
  chunks.push(
    ev('message_delta', {
      delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 9 },
    }),
    ev('message_stop', {})
  )
  return chunks
}

describe('Anthropic chat client (real SDK, fake transport)', () => {
  it('anthropic_compatible sends Authorization: Bearer to the base URL, thinking disabled explicitly, cache breakpoints on', async () => {
    const { fetch, calls } = fakeFetch(() =>
      sseResponse(anthropicStream('Hi there', { id: 'tu_1', name: 'search', json: '{"q":"x"}' }))
    )
    const client = createChatClient({
      provider: 'anthropic_compatible',
      apiKey: 'fw-token',
      baseUrl: 'https://compat.test/inference',
      fetch,
    })
    const deltas = await collect(
      client.stream({
        model: 'accounts/x/models/y',
        maxTokens: 64,
        system: 'SYS',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          { name: 'search', description: 'd', inputSchema: { type: 'object', properties: {} } },
        ],
      })
    )
    expect(deltas.map(d => d.type)).toEqual(['text', 'text', 'tool_use', 'usage', 'end'])
    expect(deltas[2]).toEqual({ type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } })
    const end = deltas.at(-1)
    expect(end?.type === 'end' && end.result).toMatchObject({
      model: 'claude-x',
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 9, cacheReadTokens: 5, cacheWriteTokens: 0 },
      content: [
        { type: 'text', text: 'Hi there' },
        { type: 'tool_use', id: 'tu_1' },
      ],
    })
    const req = calls[0]
    expect(req?.url).toBe('https://compat.test/inference/v1/messages')
    expect(req?.headers.authorization).toBe('Bearer fw-token')
    expect(req?.headers['x-api-key']).toBeUndefined()
    expect(req?.body).toMatchObject({
      model: 'accounts/x/models/y',
      max_tokens: 64,
      stream: true,
      thinking: { type: 'disabled' },
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
        },
      ],
      tools: [{ name: 'search' }],
    })
  })

  it('anthropic sends x-api-key and maps 401/429/overloaded to codes', async () => {
    let status = 401
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid x-api-key' },
          }),
          { status }
        )
    )
    const client = createChatClient({ provider: 'anthropic', apiKey: 'sk-ant-secret', fetch })
    const params = {
      model: 'claude-x',
      maxTokens: 5,
      messages: [{ role: 'user' as const, content: 'x' }],
      cache: false,
    }
    let err = await client.complete(params).catch(e => e)
    expect(err).toBeInstanceOf(AiError)
    expect(err.code).toBe('auth')
    expect(calls[0]?.headers['x-api-key']).toBe('sk-ant-secret')
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    status = 529
    err = await client.complete(params).catch(e => e)
    expect(err.code).toBe('rate_limit')
  })

  it('reconcileThinking drops thinking on a forced tool choice and lifts max_tokens under a budget', () => {
    const forced = reconcileThinking({
      thinking: { type: 'enabled', budget_tokens: 2000 },
      tool_choice: { type: 'tool', name: 'x' },
      max_tokens: 100,
    })
    expect(forced).not.toHaveProperty('thinking')
    const lifted = reconcileThinking({
      thinking: { type: 'enabled', budget_tokens: 2000 },
      max_tokens: 100,
    })
    expect(lifted.max_tokens).toBe(2512)
    const fine = reconcileThinking({
      thinking: { type: 'enabled', budget_tokens: 2000 },
      max_tokens: 8000,
    })
    expect(fine.max_tokens).toBe(8000)
    expect(reconcileThinking({ thinking: { type: 'disabled' }, max_tokens: 5 })).toEqual({
      thinking: { type: 'disabled' },
      max_tokens: 5,
    })
  })
})

describe('embeddings clients', () => {
  it('OpenAI-shaped /embeddings with dimensions=1024, order restored by index', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [2] },
              { index: 0, embedding: [1] },
            ],
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
    const client = createEmbeddingsClient({
      provider: 'openai_compatible',
      model: 'emb',
      apiKey: 'k',
      baseUrl: 'http://mock/v1',
      fetch,
    })
    expect(await client.embed(['a', 'b'])).toEqual([[1], [2]])
    expect(await client.embed([])).toEqual([])
    expect(calls[0]?.url).toBe('http://mock/v1/embeddings')
    expect(calls[0]?.body).toEqual({ model: 'emb', input: ['a', 'b'], dimensions: 1024 })
    expect(client.dimension).toBe(1024)
  })

  it('workers_ai runs the binding and returns 1024-dim vectors; absent binding is an AiError', async () => {
    const ai = new RecordingAi()
    const client = createEmbeddingsClient({ provider: 'workers_ai', model: '@cf/baai/bge-m3', ai })
    const vectors = await client.embed(['hello', 'world'])
    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toHaveLength(1024)
    expect(ai.runs).toEqual([{ model: '@cf/baai/bge-m3', inputs: { text: ['hello', 'world'] } }])
    expect(() => createEmbeddingsClient({ provider: 'workers_ai', model: 'm' })).toThrow(AiError)
  })
})

describe('error helpers', () => {
  it('redactSecrets scrubs headers, bearer tokens, sk-/AKIA prefixes and long tokens', () => {
    const text =
      'Authorization: Bearer abc.def x-api-key=sk-ant-0123456789 AKIA0123456789AB and 0123456789abcdef0123456789abcdef'
    const out = redactSecrets(text)
    expect(out).not.toMatch(/abc\.def|sk-ant|AKIA0|0123456789abcdef0123456789abcdef/)
    expect(out).toContain('[redacted]')
  })

  it('normalizeAiError passes AiError through and classifies transport failures', () => {
    const own = new AiError('auth', 'openai', 'x')
    expect(normalizeAiError(own, 'anthropic')).toBe(own)
    expect(normalizeAiError(new TypeError('fetch failed'), 'openai').code).toBe('unavailable')
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(normalizeAiError(abort, 'openai').code).toBe('unavailable')
    expect(
      normalizeAiError(
        Object.assign(new Error('Your credit balance is too low'), { status: 400 }),
        'anthropic'
      ).code
    ).toBe('auth')
    expect(normalizeAiError(new Error('weird'), 'openai').code).toBe('unknown')
  })
})

describe('Workers AI chat client', () => {
  const tool = {
    name: 'submit_summary',
    description: 'Submit the summary',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
  }
  const messages = [{ role: 'user' as const, content: 'Summarise: hello world' }]

  it('retries on the flattened schema when the model rejects the tool transcript (5006)', async () => {
    const ai = new RecordingAi()
    // The real rejection from `@cf/meta/llama-3.3-70b-instruct-fp8-fast` when a transcript carries
    // OpenAI tool extras: the model's schema declares `content` as a plain string.
    let attempt = 0
    const inner = ai.run.bind(ai)
    ai.run = async (model: string, inputs: Record<string, unknown>) => {
      attempt += 1
      if (attempt === 1) {
        throw new Error(
          "5006: Error: oneOf at '/' not met, 0 matches: required properties at '/' are 'prompt', Type mismatch of '/messages/1/content', 'array' not in 'string'"
        )
      }
      return inner(model, inputs)
    }
    ai.respond = () => ({ response: 'Answered from the flattened transcript.' })

    const client = createChatClient({ provider: 'workers_ai', ai })
    const result = await client.complete({
      model: 'm',
      system: 'You research.',
      maxTokens: 64,
      messages: [
        { role: 'user', content: 'Research this' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 't1', content: 'hits', isError: false }],
        },
      ],
      tools: [tool],
    })
    expect(textOf(result.content)).toBe('Answered from the flattened transcript.')

    // The retry carries only string content in system/user/assistant roles — no tool extras.
    expect(ai.runs).toHaveLength(1) // only the flattened call reached the recorder
    const inputs = ai.runs[0]?.inputs as { messages: Array<Record<string, unknown>> }
    for (const message of inputs.messages) {
      expect(typeof message.content).toBe('string')
      expect(message.tool_calls).toBeUndefined()
      expect(message.role).not.toBe('tool')
    }
    expect(JSON.stringify(inputs.messages)).toMatch(/Called: search/)
    expect(JSON.stringify(inputs.messages)).toMatch(/Tool result/)
  })

  it('stops waiting on a call that never answers (env.AI.run cannot be aborted)', async () => {
    const ai = new RecordingAi()
    // A binding call that never settles is the shape that used to hold a Workflow step for its
    // full 10-minute timeout and read to a person as "the agent is stuck".
    ai.run = () => new Promise(() => {})
    const client = createChatClient({ provider: 'workers_ai', ai, timeoutMs: 20 })
    const err = await client
      .complete({ model: 'm', system: 's', messages, maxTokens: 16 })
      .catch(e => e)
    expect(err).toBeInstanceOf(AiError)
    expect((err as AiError).code).toBe('unavailable') // retryable: the run's step retries, then fails
    expect((err as AiError).message).toMatch(/did not answer/)
  })

  it('gives up immediately when the caller has already aborted', async () => {
    const ai = new RecordingAi()
    ai.run = () => new Promise(() => {})
    const client = createChatClient({ provider: 'workers_ai', ai, timeoutMs: 60_000 })
    const err = await client
      .complete({
        model: 'm',
        system: 's',
        messages,
        maxTokens: 16,
        signal: AbortSignal.abort(),
      })
      .catch(e => e)
    expect((err as AiError).code).toBe('unavailable')
    expect((err as AiError).message).toMatch(/cancelled/)
  })

  it('completes over env.AI.run with OpenAI-shaped messages/tools and no tool_choice; a forced tool is a system instruction', async () => {
    const ai = new RecordingAi()
    ai.respond = () => ({
      response: '',
      tool_calls: [{ name: 'submit_summary', arguments: { summary: 'hi' } }], // legacy shape
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    })
    const client = createChatClient({ provider: 'workers_ai', ai })
    const result = await client.complete({
      model: '@cf/mistralai/mistral-small-3.1-24b-instruct',
      system: 'You summarise.',
      messages,
      maxTokens: 64,
      tools: [tool],
      toolChoice: { type: 'tool', name: 'submit_summary' },
    })
    expect(result.stopReason).toBe('tool_use')
    expect(result.content).toEqual([
      {
        type: 'tool_use',
        id: expect.any(String),
        name: 'submit_summary',
        input: { summary: 'hi' },
      },
    ])
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 })

    const [run] = ai.runs
    expect(run?.model).toBe('@cf/mistralai/mistral-small-3.1-24b-instruct')
    const inputs = run?.inputs as {
      messages: Array<{ role: string; content: string }>
      tools: unknown[]
      stream: boolean
      max_tokens: number
      tool_choice?: unknown
    }
    expect(inputs.stream).toBe(false)
    expect(inputs.max_tokens).toBe(64)
    expect(inputs.tool_choice).toBeUndefined()
    expect(inputs.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'submit_summary',
          description: 'Submit the summary',
          parameters: tool.inputSchema,
        },
      },
    ])
    expect(inputs.messages[0]?.role).toBe('system')
    expect(inputs.messages[0]?.content).toContain('You summarise.')
    expect(inputs.messages[0]?.content).toContain('calling the "submit_summary" tool')
    expect(inputs.messages[1]).toEqual({ role: 'user', content: 'Summarise: hello world' })
  })

  it('accepts OpenAI-shaped tool_calls (string arguments) and a plain-text answer', async () => {
    const ai = new RecordingAi()
    ai.respond = () => ({
      response: 'Sure.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'submit_summary', arguments: '{"summary":"x"}' },
        },
      ],
    })
    const client = createChatClient({ provider: 'workers_ai', ai })
    const result = await client.complete({ model: 'm', messages, maxTokens: 8, tools: [tool] })
    expect(result.content).toEqual([
      { type: 'text', text: 'Sure.' },
      { type: 'tool_use', id: 'call_1', name: 'submit_summary', input: { summary: 'x' } },
    ])
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })

    ai.respond = () => ({
      response: 'Just text',
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    })
    const plain = await client.complete({ model: 'm', messages, maxTokens: 8 })
    expect(plain).toMatchObject({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'Just text' }],
    })
  })

  it('streams SSE frames from the binding as text deltas, then usage and end', async () => {
    const ai = new RecordingAi()
    ai.respond = () =>
      sseResponse([
        'data: {"response":"Hel"}\n\n',
        'data: {"response":"lo"}\n\n',
        'data: {"response":"","usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
        'data: [DONE]\n\n',
      ]).body
    const client = createChatClient({ provider: 'workers_ai', ai })
    const deltas = await collect(client.stream({ model: 'm', messages, maxTokens: 8 }))
    expect(ai.runs[0]?.inputs).toMatchObject({ stream: true })
    expect(deltas).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
      {
        type: 'end',
        result: {
          content: [{ type: 'text', text: 'Hello' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 4, outputTokens: 2 },
          model: 'm',
        },
      },
    ])
  })

  it('with tools, stream() runs ONE non-streamed call and replays it (tool calls in a stream are undocumented)', async () => {
    const ai = new RecordingAi()
    ai.respond = () => ({
      response: 'Calling.',
      tool_calls: [{ name: 'submit_summary', arguments: { summary: 's' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    const client = createChatClient({ provider: 'workers_ai', ai })
    const deltas = await collect(
      client.stream({
        model: 'm',
        messages,
        maxTokens: 8,
        tools: [tool],
        toolChoice: { type: 'any' },
      })
    )
    expect(ai.runs[0]?.inputs).toMatchObject({ stream: false })
    expect(deltas.map(d => d.type)).toEqual(['text', 'tool_use', 'usage', 'end'])
    expect(deltas[1]).toMatchObject({
      type: 'tool_use',
      name: 'submit_summary',
      input: { summary: 's' },
    })
    expect((deltas[3] as { result: { stopReason: string } }).result.stopReason).toBe('tool_use')
  })

  it('a forced tool answered as a JSON object in prose is recovered as that tool call (Mistral on short inputs)', async () => {
    const ai = new RecordingAi()
    ai.respond = () => ({
      response:
        'Here you go:\n```json\n{\n  "summary": "Short.",\n  "keyPoints": ["Short."]\n}\n```',
      usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 },
    })
    const client = createChatClient({ provider: 'workers_ai', ai })
    const forced = await client.complete({
      model: 'm',
      messages,
      maxTokens: 64,
      tools: [tool],
      toolChoice: { type: 'tool', name: 'submit_summary' },
    })
    expect(forced.stopReason).toBe('tool_use')
    expect(forced.content).toEqual([
      {
        type: 'tool_use',
        id: expect.any(String),
        name: 'submit_summary',
        input: { summary: 'Short.', keyPoints: ['Short.'] },
      },
    ])
    // `any` with exactly one tool is the same; with tool_choice auto the prose stays prose.
    const any = await client.complete({
      model: 'm',
      messages,
      maxTokens: 64,
      tools: [tool],
      toolChoice: { type: 'any' },
    })
    expect(any.content[0]?.type).toBe('tool_use')
    const auto = await client.complete({
      model: 'm',
      messages,
      maxTokens: 64,
      tools: [tool],
      toolChoice: { type: 'auto' },
    })
    expect(auto.content).toEqual([{ type: 'text', text: expect.stringContaining('```json') }])
  })

  it('recoverForcedToolCall unwraps { name, arguments }, ignores non-JSON prose and a real tool call', () => {
    const base = {
      model: 'm',
      messages,
      maxTokens: 8,
      tools: [tool],
      toolChoice: { type: 'tool' as const, name: 'submit_summary' },
    }
    const prose = (text: string) => ({
      content: [{ type: 'text' as const, text }],
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'm',
    })
    expect(
      recoverForcedToolCall(
        base,
        prose('{"name":"submit_summary","arguments":{"summary":"s","keyPoints":[]}}')
      ).content[0]
    ).toMatchObject({ type: 'tool_use', input: { summary: 's', keyPoints: [] } })
    expect(recoverForcedToolCall(base, prose('I cannot summarise that.')).content[0]?.type).toBe(
      'text'
    )
    const real = {
      ...prose(''),
      content: [{ type: 'tool_use' as const, id: 'c1', name: 'submit_summary', input: { a: 1 } }],
    }
    expect(recoverForcedToolCall(base, real)).toBe(real)
    expect(extractJsonObject('[1,2]')).toBeUndefined()
    expect(extractJsonObject('x {"a": {"b": 1}} y')).toEqual({ a: { b: 1 } })
  })

  it('forced-tool instruction only for tool/any; tools omitted under toolChoice none', () => {
    const base = { model: 'm', messages, maxTokens: 8, tools: [tool] }
    expect(forcedToolInstruction({ ...base, toolChoice: { type: 'tool', name: 'x' } })).toContain(
      '"x"'
    )
    expect(forcedToolInstruction({ ...base, toolChoice: { type: 'any' } })).toContain(
      'one of the available tools'
    )
    expect(forcedToolInstruction({ ...base, toolChoice: { type: 'auto' } })).toBeUndefined()
    expect(
      forcedToolInstruction({ ...base, tools: [], toolChoice: { type: 'any' } })
    ).toBeUndefined()
    expect(
      workersAiChatInputs({ ...base, toolChoice: { type: 'none' } }, false).tools
    ).toBeUndefined()
  })

  it('no binding → AiError; a thrown binding error is normalised (unknown, no status) and never leaks a key-shaped string', async () => {
    expect(() => createChatClient({ provider: 'workers_ai' })).toThrow(AiError)
    const ai = new RecordingAi()
    ai.respond = () => {
      throw new Error('AiError: 3040 inference failed sk-ant-0123456789abcdef')
    }
    const client = createChatClient({ provider: 'workers_ai', ai })
    const err = await client.complete({ model: 'm', messages, maxTokens: 8 }).catch(e => e)
    expect(err).toBeInstanceOf(AiError)
    expect((err as AiError).provider).toBe('workers_ai')
    expect((err as AiError).code).toBe('unknown')
    expect((err as AiError).message).not.toContain('sk-ant-0123456789abcdef')
  })
})

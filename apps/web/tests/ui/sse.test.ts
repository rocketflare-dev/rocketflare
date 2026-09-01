/**
 * `lib/sse.ts` + `lib/chatStream.ts` (D17): frame parsing (multi-line data, comments, `\r\n`),
 * reassembly of frames split across chunks, schema rejection of unknown frames, abort handling,
 * and the pre-stream 503 → `AiNotConfiguredError` mapping.
 */
import type { ChatStreamEvent } from '@rocketflare/shared/ai/chat'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiNotConfiguredError, isAiNotConfigured, sendChatMessage } from '@/ui/lib/chatStream'
import { parseSseFrame, readSse, SseFrameBuffer } from '@/ui/lib/sse'
import { errorResponse } from './helpers/renderWithProviders'
import { encodeSseFrame, hangingSseResponse, sseResponse, streamResponse } from './helpers/sse'

const IDS = {
  conversation: '12121212-1212-4121-8121-121212121212',
  message: '34343434-3434-4343-8343-343434343434',
  userMessage: '56565656-5656-4565-8565-565656565656',
}

const start: ChatStreamEvent = {
  type: 'message.start',
  conversationId: IDS.conversation,
  messageId: IDS.message,
  userMessageId: IDS.userMessage,
  model: 'claude-sonnet-4-5',
  provider: 'anthropic',
}
const delta = (text: string): ChatStreamEvent => ({ type: 'text.delta', delta: text })
const usage: ChatStreamEvent = { type: 'usage', usage: { inputTokens: 12, outputTokens: 5 } }
const end: ChatStreamEvent = { type: 'message.end', messageId: IDS.message }

describe('parseSseFrame', () => {
  it('reads event/data/id, joins multi-line data and skips comments', () => {
    const frame = parseSseFrame(': keep-alive\nevent: text.delta\nid: 7\ndata: {"a":\ndata:  1}')
    expect(frame).toEqual({ event: 'text.delta', id: '7', data: '{"a":\n 1}' })
  })

  it('defaults the event name and returns null without data', () => {
    expect(parseSseFrame('data: x')).toEqual({ event: 'message', data: 'x', id: undefined })
    expect(parseSseFrame('event: ping')).toBeNull()
  })
})

describe('SseFrameBuffer', () => {
  it('reassembles frames split mid-line across chunks and normalises CRLF', () => {
    const buffer = new SseFrameBuffer()
    const text = `${encodeSseFrame(delta('Hel'))}${encodeSseFrame(delta('lo'))}`.replace(
      /\n/g,
      '\r\n'
    )
    // Cut inside the first frame's `data:` JSON and inside the second frame's `event:` line
    const cuts = [text.slice(0, 30), text.slice(30, 52), text.slice(52)]
    const frames = cuts.flatMap(chunk => buffer.push(chunk))
    expect(frames.map(f => f.event)).toEqual(['text.delta', 'text.delta'])
    expect(frames.map(f => JSON.parse(f.data).delta)).toEqual(['Hel', 'lo'])
    expect(buffer.flush()).toEqual([])
  })

  it('flushes a trailing frame that had no blank-line terminator', () => {
    const buffer = new SseFrameBuffer()
    expect(buffer.push('event: message.end\ndata: {"type":"message.end"}')).toEqual([])
    expect(buffer.flush()).toHaveLength(1)
  })
})

describe('readSse', () => {
  it('validates every frame with chatStreamEventSchema and drops the rest', async () => {
    const events: ChatStreamEvent[] = []
    const invalid: string[] = []
    const response = streamResponse([
      encodeSseFrame(start),
      'event: text.delta\ndata: not json\n\n',
      'event: future.thing\ndata: {"type":"future.thing"}\n\n',
      encodeSseFrame(delta('Hi')),
      encodeSseFrame(end),
    ])
    await readSse(response, e => events.push(e), {
      onInvalid: (_f, reason) => invalid.push(reason),
    })
    expect(events.map(e => e.type)).toEqual(['message.start', 'text.delta', 'message.end'])
    expect(invalid).toHaveLength(2)
  })

  it('handles a frame split across two network chunks', async () => {
    const whole = encodeSseFrame(delta('split me'))
    const events: ChatStreamEvent[] = []
    await readSse(streamResponse([whole.slice(0, 20), whole.slice(20)]), e => events.push(e))
    expect(events).toEqual([delta('split me')])
  })

  it('resolves quietly when the signal aborts mid-stream', async () => {
    const hanging = hangingSseResponse([start, delta('partial')])
    const controller = new AbortController()
    const events: ChatStreamEvent[] = []
    const reading = readSse(
      hanging.response,
      e => {
        events.push(e)
        if (e.type === 'text.delta') controller.abort()
      },
      { signal: controller.signal }
    )
    await expect(reading).resolves.toBeUndefined()
    expect(events.map(e => e.type)).toEqual(['message.start', 'text.delta'])
  })
})

describe('sendChatMessage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs with the session cookie + X-Requested-With and accumulates the reply', async () => {
    const fetchMock = vi.fn(async () => sseResponse([start, delta('Hel'), delta('lo'), usage, end]))
    vi.stubGlobal('fetch', fetchMock)
    const seen: string[] = []
    const result = await sendChatMessage({
      conversationId: IDS.conversation,
      content: 'Hi there',
      onEvent: e => seen.push(e.type),
    })
    expect(result).toMatchObject({
      text: 'Hello',
      messageId: IDS.message,
      userMessageId: IDS.userMessage,
      model: 'claude-sonnet-4-5',
      usage: { inputTokens: 12, outputTokens: 5 },
      completed: true,
      aborted: false,
    })
    expect(seen).toEqual(['message.start', 'text.delta', 'text.delta', 'usage', 'message.end'])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/chat/conversations/${IDS.conversation}/messages`)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.headers).toMatchObject({ 'X-Requested-With': 'fetch' })
    expect(JSON.parse(String(init.body))).toEqual({ content: 'Hi there' })
  })

  it('surfaces a pre-stream 503 ai_not_configured as a typed error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse(503, 'No chat provider', 'ai_not_configured'))
    )
    const attempt = sendChatMessage({
      conversationId: IDS.conversation,
      content: 'Hi',
      onEvent: () => {},
    })
    await expect(attempt).rejects.toBeInstanceOf(AiNotConfiguredError)
    await attempt.catch(error => expect(isAiNotConfigured(error)).toBe(true))
  })

  it('records an error frame without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([start, { type: 'error', message: 'Rate limited', code: 'rate_limit' }])
      )
    )
    const result = await sendChatMessage({
      conversationId: IDS.conversation,
      content: 'Hi',
      onEvent: () => {},
    })
    expect(result.completed).toBe(false)
    expect(result.error).toEqual({ message: 'Rate limited', code: 'rate_limit' })
  })
})

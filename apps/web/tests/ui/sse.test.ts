/**
 * `lib/sse.ts` + `lib/aguiStream.ts`: frame parsing (multi-line data, comments, `\r\n`),
 * reassembly of frames split across chunks, rejection of frames the parser does not accept, abort
 * handling, and the pre-stream 503 → `AiNotConfiguredError` mapping.
 *
 * `readSse` is transport only — the schema arrives as `parse`, which is what keeps `@ag-ui/core`
 * out of the eager shell — so the frame-level tests use a trivial parser and only the
 * `runChatTurn` tests exercise the real one.
 */
import {
  AguiEventType,
  KIT_CUSTOM_EVENTS,
  type KitAguiEvent,
  kitAguiEventSchema,
} from '@rocketflare/shared/ai/agui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiNotConfiguredError, isAiNotConfigured, runChatTurn } from '@/ui/lib/aguiStream'
import { parseSseFrame, readSse, SseFrameBuffer, type SseFrameParser } from '@/ui/lib/sse'
import { errorResponse } from './helpers/renderWithProviders'
import {
  aguiRun,
  encodeSseFrame,
  hangingSseResponse,
  sseResponse,
  streamResponse,
} from './helpers/sse'

const IDS = {
  conversation: '12121212-1212-4121-8121-121212121212',
  message: '34343434-3434-4343-8343-343434343434',
  userMessage: '56565656-5656-4565-8565-565656565656',
}

const delta = (text: string): KitAguiEvent => ({
  type: AguiEventType.TEXT_MESSAGE_CONTENT,
  messageId: IDS.message,
  delta: text,
})

const run = (over: Partial<Parameters<typeof aguiRun>[0]> = {}) =>
  aguiRun({
    conversationId: IDS.conversation,
    userMessageId: IDS.userMessage,
    assistantMessageId: IDS.message,
    text: ['Hel', 'lo'],
    ...over,
  })

/** The real parser, as `aguiStream` uses it. */
const parseAgui: SseFrameParser<KitAguiEvent> = json => {
  const parsed = kitAguiEventSchema.safeParse(json)
  return parsed.success
    ? { ok: true, event: parsed.data }
    : { ok: false, reason: parsed.error.issues[0]?.message ?? 'unknown frame' }
}

describe('parseSseFrame', () => {
  it('reads event/data/id, joins multi-line data and skips comments', () => {
    const frame = parseSseFrame(': keep-alive\nevent: legacy\nid: 7\ndata: {"a":\ndata:  1}')
    expect(frame).toEqual({ event: 'legacy', id: '7', data: '{"a":\n 1}' })
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
    // Cut inside the first frame's `data:` JSON and inside the second frame's body
    const cuts = [text.slice(0, 30), text.slice(30, 100), text.slice(100)]
    const frames = cuts.flatMap(chunk => buffer.push(chunk))
    expect(frames.map(f => JSON.parse(f.data).delta)).toEqual(['Hel', 'lo'])
    expect(buffer.flush()).toEqual([])
  })

  it('flushes a trailing frame that had no blank-line terminator', () => {
    const buffer = new SseFrameBuffer()
    expect(buffer.push('data: {"type":"RUN_FINISHED"}')).toEqual([])
    expect(buffer.flush()).toHaveLength(1)
  })
})

describe('readSse', () => {
  it('validates every frame with the caller’s parser and drops the rest', async () => {
    const events: KitAguiEvent[] = []
    const invalid: string[] = []
    const response = streamResponse([
      'data: not json\n\n',
      'data: {"type":"STATE_DELTA","delta":[]}\n\n',
      encodeSseFrame(delta('Hi')),
      encodeSseFrame({
        type: AguiEventType.RUN_FINISHED,
        threadId: IDS.conversation,
        runId: 'run-1',
      }),
    ])
    await readSse(response, parseAgui, e => events.push(e), {
      onInvalid: (_f, reason) => invalid.push(reason),
    })
    expect(events.map(e => e.type)).toEqual(['TEXT_MESSAGE_CONTENT', 'RUN_FINISHED'])
    expect(invalid).toHaveLength(2)
  })

  it('handles a frame split across two network chunks', async () => {
    const whole = encodeSseFrame(delta('split me'))
    const events: KitAguiEvent[] = []
    await readSse(streamResponse([whole.slice(0, 20), whole.slice(20)]), parseAgui, e =>
      events.push(e)
    )
    expect(events).toEqual([delta('split me')])
  })

  it('resolves quietly when the signal aborts mid-stream', async () => {
    const hanging = hangingSseResponse(run({ text: [], unterminated: true }))
    const controller = new AbortController()
    const events: KitAguiEvent[] = []
    const reading = readSse(
      hanging.response,
      parseAgui,
      e => {
        events.push(e)
        if (e.type === AguiEventType.STATE_SNAPSHOT) controller.abort()
      },
      { signal: controller.signal }
    )
    await expect(reading).resolves.toBeUndefined()
    expect(events.map(e => e.type)).toEqual(['RUN_STARTED', 'CUSTOM', 'STATE_SNAPSHOT'])
  })
})

describe('runChatTurn', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs with the session cookie + X-Requested-With and accumulates the reply', async () => {
    const fetchMock = vi.fn(async () => sseResponse(run()))
    vi.stubGlobal('fetch', fetchMock)
    const seen: string[] = []
    const result = await runChatTurn({
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
    expect(seen).toEqual([
      'RUN_STARTED',
      'CUSTOM',
      'STATE_SNAPSHOT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'CUSTOM',
      'RUN_FINISHED',
    ])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/chat/conversations/${IDS.conversation}/messages`)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.headers).toMatchObject({ 'X-Requested-With': 'fetch' })
    expect(JSON.parse(String(init.body))).toEqual({ content: 'Hi there' })
  })

  it('accumulates text across the message ids of several model turns', async () => {
    const second = '78787878-7878-4787-8787-787878787878'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          ...run({ text: ['First turn.\n\n'], unterminated: true }),
          { type: AguiEventType.TEXT_MESSAGE_START, messageId: second, role: 'assistant' },
          { type: AguiEventType.TEXT_MESSAGE_CONTENT, messageId: second, delta: 'Second turn.' },
          { type: AguiEventType.TEXT_MESSAGE_END, messageId: second },
          {
            type: AguiEventType.RUN_FINISHED,
            threadId: IDS.conversation,
            runId: 'run-1',
            result: {
              conversationId: IDS.conversation,
              messageId: IDS.message,
              usage: { inputTokens: 1, outputTokens: 2 },
              stopReason: 'end_turn',
            },
          },
        ])
      )
    )
    const result = await runChatTurn({
      conversationId: IDS.conversation,
      content: 'Hi',
      onEvent: () => {},
    })
    expect(result.text).toBe('First turn.\n\nSecond turn.')
    // The persisted row's id, not the last text segment's.
    expect(result.messageId).toBe(IDS.message)
  })

  it('reads a kit notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          ...run({ unterminated: true }),
          {
            type: AguiEventType.CUSTOM,
            name: KIT_CUSTOM_EVENTS.notice,
            value: { code: 'workers_ai_no_token_streaming' },
          },
        ])
      )
    )
    const result = await runChatTurn({
      conversationId: IDS.conversation,
      content: 'Hi',
      onEvent: () => {},
    })
    expect(result.notice).toBe('workers_ai_no_token_streaming')
    // No RUN_FINISHED and no RUN_ERROR: the protocol's "the client went away".
    expect(result.completed).toBe(false)
    expect(result.error).toBeUndefined()
  })

  it('surfaces a pre-stream 503 ai_not_configured as a typed error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse(503, 'No chat provider', 'ai_not_configured'))
    )
    const attempt = runChatTurn({
      conversationId: IDS.conversation,
      content: 'Hi',
      onEvent: () => {},
    })
    await expect(attempt).rejects.toBeInstanceOf(AiNotConfiguredError)
    await attempt.catch(error => expect(isAiNotConfigured(error)).toBe(true))
  })

  it('records a RUN_ERROR without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          ...run({ text: [], unterminated: true }),
          { type: AguiEventType.RUN_ERROR, message: 'Rate limited', code: 'rate_limit' },
        ])
      )
    )
    const result = await runChatTurn({
      conversationId: IDS.conversation,
      content: 'Hi',
      onEvent: () => {},
    })
    expect(result.completed).toBe(false)
    expect(result.error).toEqual({ message: 'Rate limited', code: 'rate_limit' })
  })
})

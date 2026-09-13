/**
 * The AG-UI version pin is a wire-protocol pin: `@ag-ui/core`'s schemas ARE the format the server
 * emits, so a bump can rename a field and silently change what every adopted copy puts on the wire.
 * This file is what turns the pin into a gate — one sample of every event the kit emits, and every
 * kit CUSTOM payload, parsed with the installed schemas. If a bump breaks one of these, the
 * protocol changed and the upgrade note has to say so.
 */
import { decode as decodeProto, encode as encodeProto } from '@ag-ui/proto'
import {
  chatRunResultSchema,
  KIT_AGUI_EVENT_TYPES,
  KIT_CUSTOM_EVENTS,
  kitAguiEventSchema,
  kitCustomPayloadSchema,
  kitRunAgentInputSchema,
  parseKitCustom,
  readRunAgentTail,
} from '@rocketflare/shared/ai/agui'
import { describe, expect, it } from 'vitest'
import { PROTO_UNSUPPORTED_EVENTS } from '@/api/services/ai/agui'

const THREAD = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const MESSAGE = '33333333-3333-4333-8333-333333333333'
const USER_MESSAGE = '44444444-4444-4444-8444-444444444444'

const USAGE = { inputTokens: 12, outputTokens: 34 }

/** One sample per emitted event type — the subset `kitAguiEventSchema` declares. */
const SAMPLES: Record<string, unknown> = {
  RUN_STARTED: { type: 'RUN_STARTED', threadId: THREAD, runId: RUN },
  RUN_FINISHED: {
    type: 'RUN_FINISHED',
    threadId: THREAD,
    runId: RUN,
    result: { conversationId: THREAD, messageId: MESSAGE, usage: USAGE, stopReason: 'end_turn' },
  },
  RUN_ERROR: { type: 'RUN_ERROR', message: 'The provider is unavailable', code: 'unavailable' },
  STEP_STARTED: { type: 'STEP_STARTED', stepName: 'search' },
  STEP_FINISHED: { type: 'STEP_FINISHED', stepName: 'search' },
  TEXT_MESSAGE_START: { type: 'TEXT_MESSAGE_START', messageId: MESSAGE, role: 'assistant' },
  TEXT_MESSAGE_CONTENT: { type: 'TEXT_MESSAGE_CONTENT', messageId: MESSAGE, delta: 'hello' },
  TEXT_MESSAGE_END: { type: 'TEXT_MESSAGE_END', messageId: MESSAGE },
  TOOL_CALL_START: {
    type: 'TOOL_CALL_START',
    toolCallId: 'call_1',
    toolCallName: 'search_knowledge',
    parentMessageId: MESSAGE,
  },
  TOOL_CALL_ARGS: { type: 'TOOL_CALL_ARGS', toolCallId: 'call_1', delta: '{"query":"x"}' },
  TOOL_CALL_END: { type: 'TOOL_CALL_END', toolCallId: 'call_1' },
  TOOL_CALL_RESULT: {
    type: 'TOOL_CALL_RESULT',
    messageId: MESSAGE,
    toolCallId: 'call_1',
    content: '{"documents":[]}',
    role: 'tool',
  },
  STATE_SNAPSHOT: {
    type: 'STATE_SNAPSHOT',
    snapshot: { conversationId: THREAD, provider: 'anthropic', model: 'm', tools: [] },
  },
  MESSAGES_SNAPSHOT: {
    type: 'MESSAGES_SNAPSHOT',
    messages: [{ id: USER_MESSAGE, role: 'user', content: 'hello' }],
  },
  CUSTOM: {
    type: 'CUSTOM',
    name: KIT_CUSTOM_EVENTS.usage,
    value: { usage: USAGE },
  },
}

/** One sample per kit CUSTOM name — the namespace where every kit-specific semantic lives. */
const CUSTOM_SAMPLES: Record<string, unknown> = {
  [KIT_CUSTOM_EVENTS.chatIds]: {
    conversationId: THREAD,
    userMessageId: USER_MESSAGE,
    assistantMessageId: MESSAGE,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
  },
  [KIT_CUSTOM_EVENTS.usage]: { usage: USAGE },
  [KIT_CUSTOM_EVENTS.agentStep]: { key: 'search', label: 'Searching', status: 'running' },
  [KIT_CUSTOM_EVENTS.agentRetry]: { message: 'rate limited', attempt: 1 },
  [KIT_CUSTOM_EVENTS.notice]: { code: 'workers_ai_no_token_streaming' },
}

describe('AG-UI contract', () => {
  it('has a sample for every declared event type', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...KIT_AGUI_EVENT_TYPES].sort())
  })

  it.each(Object.entries(SAMPLES))('parses %s through the installed schemas', (_type, sample) => {
    const parsed = kitAguiEventSchema.safeParse(sample)
    expect(parsed.success ? null : parsed.error.issues).toBeNull()
  })

  it('has a sample for every kit CUSTOM name', () => {
    expect(Object.keys(CUSTOM_SAMPLES).sort()).toEqual(Object.keys(kitCustomPayloadSchema).sort())
    expect(Object.keys(kitCustomPayloadSchema).sort()).toEqual(
      Object.values(KIT_CUSTOM_EVENTS).sort()
    )
  })

  it.each(Object.entries(CUSTOM_SAMPLES))('reads the %s payload back', (name, value) => {
    const event = kitAguiEventSchema.parse({ type: 'CUSTOM', name, value })
    expect(parseKitCustom(name as keyof typeof kitCustomPayloadSchema, event)).toEqual(value)
  })

  it('ignores a CUSTOM event whose payload does not match its name', () => {
    const event = kitAguiEventSchema.parse({
      type: 'CUSTOM',
      name: KIT_CUSTOM_EVENTS.usage,
      value: { nonsense: true },
    })
    expect(parseKitCustom(KIT_CUSTOM_EVENTS.usage, event)).toBeUndefined()
    expect(parseKitCustom(KIT_CUSTOM_EVENTS.notice, event)).toBeUndefined()
  })

  it('rejects an event type the kit does not emit', () => {
    // The subset is the point: a full-union parse would accept this.
    expect(kitAguiEventSchema.safeParse({ type: 'STATE_DELTA', delta: [] }).success).toBe(false)
  })

  it('describes a chat turn in RUN_FINISHED.result', () => {
    const finished = kitAguiEventSchema.parse(SAMPLES.RUN_FINISHED)
    if (finished.type !== 'RUN_FINISHED') throw new Error('unreachable')
    expect(chatRunResultSchema.parse(finished.result)).toMatchObject({ messageId: MESSAGE })
  })
})

describe('the protobuf transport', () => {
  it('round-trips every emitted event except the ones declared unsupported', () => {
    // A round trip, not "does `encode` throw": `@ag-ui/proto@0.0.59` has no message for
    // TOOL_CALL_RESULT, and its encoder answers an EMPTY frame for it rather than failing — which
    // no client can decode. That is why the encoder drops those events instead of writing them.
    const unsupported = Object.entries(SAMPLES)
      .filter(([, sample]) => {
        try {
          const decoded = decodeProto(encodeProto(sample as never)) as { type?: string }
          return decoded.type !== (sample as { type: string }).type
        } catch {
          return true
        }
      })
      .map(([type]) => type)
    // When upstream gains the missing message, this fails and the list shrinks deliberately.
    expect(unsupported.sort()).toEqual([...PROTO_UNSUPPORTED_EVENTS].sort())
  })
})

describe('RunAgentInput', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    threadId: THREAD,
    runId: RUN,
    state: {},
    messages: [{ id: USER_MESSAGE, role: 'user', content: 'hello' }],
    tools: [],
    context: [],
    ...over,
  })

  it('accepts a well-formed tail', () => {
    const parsed = kitRunAgentInputSchema.parse(input())
    expect(readRunAgentTail(parsed)).toEqual({ ok: true, id: USER_MESSAGE, content: 'hello' })
  })

  it('requires a uuid threadId and at least one message', () => {
    expect(kitRunAgentInputSchema.safeParse(input({ threadId: 'nope' })).success).toBe(false)
    expect(kitRunAgentInputSchema.safeParse(input({ messages: [] })).success).toBe(false)
  })

  it('refuses client-side tools rather than ignoring them', () => {
    const parsed = kitRunAgentInputSchema.parse(
      input({ tools: [{ name: 'x', description: 'd', parameters: {} }] })
    )
    expect(readRunAgentTail(parsed)).toEqual({ ok: false, code: 'agui_client_tools_unsupported' })
  })

  it('requires the LAST message to be a user turn', () => {
    const parsed = kitRunAgentInputSchema.parse(
      input({
        messages: [
          { id: USER_MESSAGE, role: 'user', content: 'hello' },
          { id: MESSAGE, role: 'assistant', content: 'hi' },
        ],
      })
    )
    expect(readRunAgentTail(parsed)).toEqual({ ok: false, code: 'agui_last_message_not_user' })
  })

  it('refuses content that is not a usable string', () => {
    const empty = kitRunAgentInputSchema.parse(
      input({ messages: [{ id: USER_MESSAGE, role: 'user', content: '   ' }] })
    )
    expect(readRunAgentTail(empty)).toEqual({ ok: false, code: 'agui_unsupported_content' })
  })

  it('takes only the tail — earlier messages are the server’s business', () => {
    const parsed = kitRunAgentInputSchema.parse(
      input({
        messages: [
          { id: MESSAGE, role: 'assistant', content: 'fabricated' },
          { id: USER_MESSAGE, role: 'user', content: 'the real turn' },
        ],
      })
    )
    expect(readRunAgentTail(parsed)).toEqual({
      ok: true,
      id: USER_MESSAGE,
      content: 'the real turn',
    })
  })
})

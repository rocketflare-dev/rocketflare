/**
 * The runtime's own timeline rows (`services/agents/recording.ts`), no database:
 *   - every model call through the recording client is ONE `tool.start`/`tool.end` pair marked
 *     `kind: 'model'`, the end written even when the call throws or a stream is abandoned;
 *   - a forced answer is recorded as its shape, never its text;
 *   - a tool loop with no `onEvent` of its own records through the journal's sink (terminal tool
 *     skipped), and one WITH `onEvent` owns its rows — the sink is never called.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { attemptKeys } from '@/api/services/agents/keys'
import {
  answerShape,
  loopEventSink,
  RECORDED_INPUT_CHARS,
  recordingChatClient,
} from '@/api/services/agents/recording'
import type { AgentEvent } from '@/api/services/agents/registry'
import {
  runToolLoop,
  type Tool,
  type ToolLoopEvent,
  type ToolLoopJournal,
} from '@/api/services/ai/agent-loop'
import { AiError } from '@/api/services/ai/errors'
import type { ChatParams } from '@/api/services/ai/types'
import { FakeChatClient } from '../helpers/ai'

function recorder() {
  const events: AgentEvent[] = []
  return {
    events,
    emit: async (event: AgentEvent) => {
      events.push(event)
    },
  }
}

const params = (overrides: Partial<ChatParams> = {}): ChatParams => ({
  model: 'm-1',
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 100,
  ...overrides,
})

describe('recordingChatClient', () => {
  it('records each call as a model pair, numbered in order, with the forced answer as its shape', async () => {
    const { events, emit } = recorder()
    const client = recordingChatClient(
      new FakeChatClient([
        { text: 'hi there', usage: { inputTokens: 10, outputTokens: 3 } },
        {
          toolUses: [{ name: 'submit', input: { title: 'Secret plan', items: [1, 2], ok: true } }],
          usage: { inputTokens: 20, outputTokens: 5 },
        },
      ]),
      emit,
      { invocation: '0.abc' }
    )
    await client.complete(params())
    await client.complete(
      params({
        toolChoice: { type: 'tool', name: 'submit' },
        tools: [{ name: 'submit', description: 'd', inputSchema: {} }],
      })
    )

    expect(events.map(e => [e.type, (e.data as { toolCallId: string }).toolCallId])).toEqual([
      ['tool.start', 'model:0.abc:1'],
      ['tool.end', 'model:0.abc:1'],
      ['tool.start', 'model:0.abc:2'],
      ['tool.end', 'model:0.abc:2'],
    ])
    expect(events[0]?.data).toEqual({
      name: 'm-1',
      kind: 'model',
      toolCallId: 'model:0.abc:1',
      input: { messages: 1, maxTokens: 100 },
    })
    expect(events[1]?.data).toMatchObject({
      kind: 'model',
      result: { stopReason: 'end_turn', textChars: 8, usage: { inputTokens: 10, outputTokens: 3 } },
    })
    expect(events[2]?.data).toMatchObject({ input: { tool: 'submit', tools: 1 } })
    const end = events[3]?.data as { result: Record<string, unknown> }
    expect(end.result).toMatchObject({
      stopReason: 'tool_use',
      toolCalls: ['submit'],
      answer: { title: '11 chars', items: '2 items', ok: true },
    })
    // The shape, never the content.
    expect(JSON.stringify(events)).not.toContain('Secret plan')
  })

  it('writes the end as an error when the call throws, then rethrows', async () => {
    const { events, emit } = recorder()
    const failure = new AiError('unavailable', 'anthropic', 'overloaded')
    const client = recordingChatClient(new FakeChatClient([{ error: failure }]), emit, {
      invocation: '0.x',
    })
    await expect(client.complete(params())).rejects.toBe(failure)
    expect(events.map(e => e.type)).toEqual(['tool.start', 'tool.end'])
    expect(events[1]?.data).toMatchObject({
      kind: 'model',
      toolCallId: 'model:0.x:1',
      isError: true,
      result: { error: expect.any(String) },
    })
  })

  it('records a streamed call when it ends, and closes one abandoned part-way', async () => {
    const { events, emit } = recorder()
    const client = recordingChatClient(
      new FakeChatClient([{ text: 'streamed', usage: { inputTokens: 1, outputTokens: 1 } }]),
      emit,
      { invocation: '0.s' }
    )
    for await (const _ of client.stream(params())) {
      // read to the end
    }
    for await (const _ of client.stream(params())) break

    expect(events.map(e => [e.type, (e.data as { isError?: boolean }).isError ?? false])).toEqual([
      ['tool.start', false],
      ['tool.end', false],
      ['tool.start', false],
      ['tool.end', true],
    ])
    expect(events[1]?.data).toMatchObject({ result: { textChars: 8 } })
  })
})

describe('answerShape', () => {
  it('counts strings, arrays and objects; keeps numbers, booleans and null', () => {
    expect(
      answerShape({
        s: 'abc',
        a: [1],
        o: { x: 1, y: 2 },
        n: 0.5,
        b: false,
        z: null,
        one: ['x', 'y'],
      })
    ).toEqual({
      s: '3 chars',
      a: '1 item',
      o: '2 fields',
      n: 0.5,
      b: false,
      z: null,
      one: '2 items',
    })
  })
})

describe('loopEventSink', () => {
  it('maps loop events to rows: clipped input, summarised result, the model call id kept', async () => {
    const { events, emit } = recorder()
    const sink = loopEventSink(emit)
    const big = 'x'.repeat(RECORDED_INPUT_CHARS + 50)
    await sink({ kind: 'text', turn: 1, text: 'thinking' })
    await sink({ kind: 'tool_call', turn: 1, toolUseId: 't1', name: 'lookup', input: { q: big } })
    await sink({
      kind: 'tool_result',
      turn: 1,
      toolUseId: 't1',
      name: 'lookup',
      resultText: '{"hits":2}',
      isError: false,
    })
    expect(events[0]).toEqual({ type: 'text', data: { text: 'thinking' } })
    expect(events[1]?.data).toMatchObject({
      name: 'lookup',
      toolCallId: 't1',
      input: { truncated: true, preview: expect.stringMatching(/…$/) },
    })
    expect(events[2]?.data).toEqual({
      name: 'lookup',
      toolCallId: 't1',
      isError: false,
      result: { hits: 2 },
    })
  })
})

describe('runToolLoop and the journal sink', () => {
  const answer: Tool<{ answer: string }> = {
    name: 'answer',
    description: 'terminal',
    schema: z.object({ answer: z.string() }),
  }
  const lookup: Tool<{ q: string }> = {
    name: 'lookup',
    description: 'read',
    schema: z.object({ q: z.string() }),
    handler: async ({ q }) => `found ${q}`,
  }
  const script = [
    { text: 'Looking.', toolUses: [{ id: 'call-1', name: 'lookup', input: { q: 'a' } }] },
    { toolUses: [{ id: 'call-2', name: 'answer', input: { answer: 'done' } }] },
  ]

  /** A journal that records nothing and serves nothing, with a sink. */
  function journal(sink: (event: ToolLoopEvent) => void): ToolLoopJournal {
    const keys = attemptKeys('tool loop')
    return {
      onEvent: sink,
      async open(key) {
        keys.claim(key)
        return {
          reemitServed: false,
          modelTurn: () => null,
          async recordModelTurn() {},
          toolCall: () => null,
          async startToolCall() {},
          async settleToolCall() {},
          async forgetToolCall() {},
        }
      },
    }
  }

  it('records through the sink when the loop has no onEvent — the terminal tool skipped', async () => {
    const seen: ToolLoopEvent[] = []
    await runToolLoop(new FakeChatClient(script), {
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: [lookup as Tool, answer as Tool],
      journal: journal(event => void seen.push(event)),
    })
    expect(seen.map(e => (e.kind === 'text' ? e.kind : `${e.kind}:${e.name}`))).toEqual([
      'text',
      'tool_call:lookup',
      'tool_result:lookup',
    ])
  })

  it('leaves the rows to a loop that passes its own onEvent', async () => {
    const sink: ToolLoopEvent[] = []
    const own: ToolLoopEvent[] = []
    await runToolLoop(new FakeChatClient(script), {
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: [lookup as Tool, answer as Tool],
      journal: journal(event => void sink.push(event)),
      onEvent: event => void own.push(event),
    })
    expect(sink).toEqual([])
    // Its own handler sees everything, the terminal call included — what it skips is its choice.
    expect(own.some(e => e.kind === 'tool_call' && e.name === 'answer')).toBe(true)
  })
})

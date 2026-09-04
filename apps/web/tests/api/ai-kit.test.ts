/**
 * `services/ai/kit.ts` (D17), no database: cache breakpoints, `callStructuredTool` parse + one
 * retry, `runToolLoop` dispatch / terminal tool / turn cap / abort / checkpoint-and-resume,
 * `runStreamingChat` deltas and tool rounds — all driven by `FakeChatClient`.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  cachedSystem,
  callStructuredTool,
  parseToolLoopCheckpoint,
  runStreamingChat,
  runToolLoop,
  StructuredOutputError,
  type Tool,
  type ToolLoopCheckpoint,
  toolInputSchema,
  withRollingCacheBreakpoints,
} from '@/api/services/ai/kit'
import { FakeChatClient } from '../helpers/ai'

describe('prompt caching helpers', () => {
  it('cachedSystem puts one breakpoint on the stable prefix and none on the volatile tail', () => {
    expect(cachedSystem('hello')).toEqual([
      { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
    ])
    expect(cachedSystem({ stable: 'a', volatile: 'b' })).toEqual([
      { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'b' },
    ])
    expect(cachedSystem('x', false)).toEqual([{ type: 'text', text: 'x' }])
  })

  it('withRollingCacheBreakpoints marks the last two messages and copies', () => {
    const input = [
      { role: 'user' as const, content: 'one' },
      { role: 'assistant' as const, content: 'two' },
      { role: 'user' as const, content: 'three' },
    ]
    const out = withRollingCacheBreakpoints(input)
    expect(out[0]?.content).toBe('one')
    expect(out[1]?.content).toEqual([
      { type: 'text', text: 'two', cache_control: { type: 'ephemeral' } },
    ])
    expect(out[2]?.content).toEqual([
      { type: 'text', text: 'three', cache_control: { type: 'ephemeral' } },
    ])
    expect(input[1]?.content).toBe('two')
  })

  it('toolInputSchema renders zod as JSON Schema without $schema', () => {
    const json = toolInputSchema(z.object({ q: z.string().describe('query'), n: z.number().int() }))
    expect(json).toMatchObject({
      type: 'object',
      properties: { q: { type: 'string', description: 'query' }, n: { type: 'integer' } },
      required: ['q', 'n'],
    })
    expect(json).not.toHaveProperty('$schema')
  })
})

describe('callStructuredTool', () => {
  const schema = z.object({ summary: z.string(), keywords: z.array(z.string()).min(1) })
  const tool = { name: 'record_summary', description: 'Record it', schema }

  it('forces the tool and returns the parsed input', async () => {
    const client = new FakeChatClient([
      { toolUses: [{ name: 'record_summary', input: { summary: 'ok', keywords: ['a'] } }] },
    ])
    const out = await callStructuredTool(client, {
      model: 'm',
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tool,
    })
    expect(out).toEqual({ summary: 'ok', keywords: ['a'] })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]?.toolChoice).toEqual({ type: 'tool', name: 'record_summary' })
    expect(client.calls[0]?.tools?.[0]?.inputSchema).toMatchObject({ type: 'object' })
  })

  it('retries ONCE with the validation issues, then throws StructuredOutputError', async () => {
    const usage: number[] = []
    const client = new FakeChatClient([
      { toolUses: [{ id: 'bad1', name: 'record_summary', input: { summary: 1 } }] },
      { toolUses: [{ name: 'record_summary', input: { summary: 'fixed', keywords: ['k'] } }] },
    ])
    const out = await callStructuredTool(client, {
      model: 'm',
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tool,
      onUsage: u => usage.push(u.inputTokens),
    })
    expect(out.summary).toBe('fixed')
    expect(client.calls).toHaveLength(2)
    const retry = client.calls[1]?.messages ?? []
    expect(retry).toHaveLength(3)
    expect(retry[2]?.content).toEqual([
      expect.objectContaining({ type: 'tool_result', toolUseId: 'bad1', isError: true }),
    ])
    expect(usage).toEqual([20])

    const stubborn = new FakeChatClient([{ text: 'no tool' }, { text: 'still no tool' }])
    await expect(
      callStructuredTool(stubborn, { model: 'm', system: 's', messages: [], tool })
    ).rejects.toBeInstanceOf(StructuredOutputError)
    expect(stubborn.calls).toHaveLength(2)
  })
})

const ZERO_TEST_USAGE = { inputTokens: 0, outputTokens: 0 }

describe('runToolLoop', () => {
  const search: Tool<{ q: string }> = {
    name: 'search',
    description: 'search',
    schema: z.object({ q: z.string() }),
    handler: async ({ q }) => `results for ${q}`,
  }
  const record: Tool<{ answer: string }> = {
    name: 'record',
    description: 'terminal',
    schema: z.object({ answer: z.string() }),
  }

  it('runs read tools, feeds results back, and returns the terminal input', async () => {
    const steps: string[][] = []
    const events: string[] = []
    const client = new FakeChatClient([
      { text: 'thinking', toolUses: [{ id: 't1', name: 'search', input: { q: 'x' } }] },
      { toolUses: [{ name: 'record', input: { answer: '42' } }] },
    ])
    const result = await runToolLoop(client, {
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: [search, record],
      onStep: s => {
        steps.push(s.toolNames)
      },
      onEvent: e => {
        events.push(e.kind)
      },
    })
    expect(result.terminalInput).toEqual({ answer: '42' })
    expect(result.terminalTool).toBe('record')
    expect(result.turns).toBe(2)
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 })
    expect(steps).toEqual([['search'], ['record']])
    expect(events).toEqual(['text', 'tool_call', 'tool_result', 'tool_call'])
    // Second call carries the assistant turn + the tool result.
    const second = client.calls[1]?.messages ?? []
    expect(second[2]?.content).toEqual([
      { type: 'tool_result', toolUseId: 't1', content: 'results for x', isError: false },
    ])
  })

  it('unknown tools and invalid inputs come back as is_error results; the turn cap ends the loop', async () => {
    const client = new FakeChatClient(() => ({
      toolUses: [
        { name: 'nope', input: {} },
        { name: 'search', input: { q: 7 } },
      ],
    }))
    const result = await runToolLoop(client, {
      model: 'm',
      system: 's',
      messages: [],
      tools: [search, record],
      maxTurns: 3,
    })
    expect(result.stopReason).toBe('max_turns')
    expect(result.turns).toBe(3)
    expect(result.terminalInput).toBeNull()
    const fed = client.calls[1]?.messages.at(-1)?.content
    expect(fed).toEqual([
      expect.objectContaining({ isError: true, content: 'Unknown tool: nope' }),
      expect.objectContaining({ isError: true, content: expect.stringContaining('Invalid input') }),
    ])
  })

  it('a turn without tool calls ends with no_tool_call; an aborted signal throws before calling', async () => {
    const client = new FakeChatClient([{ text: 'done talking' }])
    const result = await runToolLoop(client, {
      model: 'm',
      system: 's',
      messages: [],
      tools: [record],
    })
    expect(result.stopReason).toBe('no_tool_call')
    const ac = new AbortController()
    ac.abort()
    const untouched = new FakeChatClient([{ text: 'x' }])
    await expect(
      runToolLoop(untouched, {
        model: 'm',
        system: 's',
        messages: [],
        tools: [record],
        signal: ac.signal,
      })
    ).rejects.toThrow(/cancelled/)
    expect(untouched.calls).toHaveLength(0)
  })

  it('checkpoints every turn and resumes from one without replaying the conversation', async () => {
    const checkpoints: ToolLoopCheckpoint[] = []
    const first = new FakeChatClient([
      { toolUses: [{ id: 't1', name: 'search', input: { q: 'x' } }] },
      { error: new Error('provider fell over') },
    ])
    await expect(
      runToolLoop(first, {
        model: 'm',
        system: 's',
        messages: [{ role: 'user', content: 'go' }],
        tools: [search, record],
        onCheckpoint: cp => {
          checkpoints.push(cp)
        },
      })
    ).rejects.toThrow(/fell over/)

    // One completed turn, one checkpoint: the seed, the assistant turn and the tool result.
    expect(checkpoints).toHaveLength(1)
    const resume = checkpoints[0] as ToolLoopCheckpoint
    expect(resume.turns).toBe(1)
    expect(resume.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(resume.messages).toHaveLength(3)

    const second = new FakeChatClient([{ toolUses: [{ name: 'record', input: { answer: '42' } }] }])
    const result = await runToolLoop(second, {
      model: 'm',
      system: 's',
      // The seed is deliberately different: `resume` must win, or the model loses its context.
      messages: [{ role: 'user', content: 'this seed must be ignored' }],
      tools: [search, record],
      resume,
    })

    expect(result.terminalInput).toEqual({ answer: '42' })
    // Turn and token counters carry forward, so `maxTurns` is a budget for the RUN.
    expect(result.turns).toBe(2)
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 })
    // The resumed attempt did NOT re-ask turn 1: its very first request already carries it.
    // (`FakeChatClient` records the live array, which the loop appends to, so compare the head.)
    expect(second.calls[0]?.messages.slice(0, resume.messages.length)).toEqual(resume.messages)
  })

  it('an exhausted turn budget stops a resumed loop without calling the provider', async () => {
    const client = new FakeChatClient([{ toolUses: [{ name: 'record', input: { answer: 'x' } }] }])
    const result = await runToolLoop(client, {
      model: 'm',
      system: 's',
      messages: [],
      tools: [record],
      maxTurns: 2,
      resume: { messages: [{ role: 'user', content: 'go' }], turns: 2, usage: ZERO_TEST_USAGE },
    })
    expect(result.stopReason).toBe('max_turns')
    expect(client.calls).toHaveLength(0)
  })
})

describe('parseToolLoopCheckpoint', () => {
  it('round-trips a real checkpoint, block content included', () => {
    const checkpoint: ToolLoopCheckpoint = {
      turns: 2,
      usage: { inputTokens: 1, outputTokens: 2 },
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 't1', content: 'hits', isError: false }],
        },
      ],
    }
    expect(parseToolLoopCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toEqual(checkpoint)
  })

  it('returns null for anything it cannot trust, so a bad row replays instead of failing', () => {
    // The whole point: an older build's shape or a corrupted value costs ONE replayed attempt.
    expect(parseToolLoopCheckpoint(null)).toBeNull()
    expect(parseToolLoopCheckpoint({ nonsense: true })).toBeNull()
    expect(
      parseToolLoopCheckpoint({
        turns: -1,
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [],
      })
    ).toBeNull()
    expect(
      parseToolLoopCheckpoint({
        turns: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [{ role: 'system', content: 'nope' }],
      })
    ).toBeNull()
  })
})

describe('runStreamingChat', () => {
  it('streams deltas and returns the final text + usage with zero tools', async () => {
    const deltas: string[] = []
    const client = new FakeChatClient([
      { text: 'Hello there, friend.', usage: { inputTokens: 3, outputTokens: 4 } },
    ])
    const result = await runStreamingChat(client, {
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: t => {
        deltas.push(t)
      },
    })
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.join('')).toBe('Hello there, friend.')
    expect(result).toEqual({
      text: 'Hello there, friend.',
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 4 },
      stopReason: 'end_turn',
    })
    expect(client.calls[0]?.tools).toBeUndefined()
  })

  it('runs a read tool between turns and keeps the lead-in text', async () => {
    const lookup: Tool<{ id: string }> = {
      name: 'lookup',
      description: 'l',
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => `record ${id}`,
    }
    const seen: string[] = []
    const client = new FakeChatClient([
      { text: 'Let me check.', toolUses: [{ id: 'c1', name: 'lookup', input: { id: '9' } }] },
      { text: 'Record 9 is fine.' },
    ])
    const result = await runStreamingChat(client, {
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'check 9' }],
      tools: [lookup],
      onDelta: t => {
        seen.push(t)
      },
      onToolStart: c => {
        seen.push(`<start ${c.name}>`)
      },
      onToolEnd: c => {
        seen.push(`<end ${c.result}>`)
      },
    })
    expect(seen.join('')).toBe('Let me check.\n\n<start lookup><end record 9>Record 9 is fine.')
    expect(result.text).toBe('Let me check.\n\nRecord 9 is fine.')
    expect(result.toolCalls).toEqual([
      { id: 'c1', name: 'lookup', input: { id: '9' }, result: 'record 9', isError: false },
    ])
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 })
  })
})

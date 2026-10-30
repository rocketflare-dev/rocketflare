/**
 * `runToolLoop` under an `AgentPolicy` and `authorizeTool`. Pure: the
 * loop is driven by `FakeChatClient`, so every branch is assertable without Postgres.
 *
 * The properties that matter, and that a first draft of this feature (PR #73) got wrong:
 *   - no policy, no change — a loop without one returns exactly what it always did;
 *   - every limit counts across attempts — the counters come from the checkpoint and the
 *     transcript, so a resumed loop never gets a fresh allowance;
 *   - every `tool_use` gets a `tool_result`, even past the budget — the salvage call sends the
 *     transcript, and an unanswered call is a 400 on Anthropic;
 *   - a salvage that fails FAILS — its error propagates, cancellation included.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  InterruptRequested,
  parseToolLoopCheckpoint,
  runToolLoop,
  StructuredOutputError,
  type Tool,
  type ToolLoopCheckpoint,
  ToolLoopExhaustedError,
} from '@/api/services/ai/agent-loop'
import { AiError } from '@/api/services/ai/errors'
import type { ChatMessage, ContentBlock } from '@/api/services/ai/types'
import { FakeChatClient } from '../helpers/ai'

const search = (handler = vi.fn(async ({ q }: { q: string }) => `found ${q}`)) =>
  ({
    name: 'search',
    description: 'Search',
    schema: z.object({ q: z.string() }),
    handler,
  }) as Tool<{ q: string }>

const failing = (): Tool<{ q: string }> => ({
  name: 'flaky',
  description: 'Always fails',
  schema: z.object({ q: z.string() }),
  handler: async () => {
    throw new Error('boom')
  },
})

const answer: Tool<{ answer: string }> = {
  name: 'submit_answer',
  description: 'Submit the answer',
  schema: z.object({ answer: z.string() }),
}

const seed: ChatMessage[] = [{ role: 'user', content: 'Go' }]
const base = { model: 'fake', system: 'sys', messages: seed }

/** Every `tool_use` id in the transcript, and every id a `tool_result` answers. */
function pairing(messages: ChatMessage[]) {
  const blocks = messages.flatMap(m => (typeof m.content === 'string' ? [] : m.content))
  const used = blocks.flatMap(b => (b.type === 'tool_use' ? [b.id] : []))
  const answered = blocks.flatMap(b => (b.type === 'tool_result' ? [b.toolUseId] : []))
  return { used, answered }
}

describe('no policy: the loop behaves as it always has', () => {
  it('stops at maxTurns with no answer and makes no salvage call', async () => {
    const client = new FakeChatClient([
      { toolUses: [{ name: 'search', input: { q: 'a' } }] },
      { toolUses: [{ name: 'search', input: { q: 'b' } }] },
    ])
    const loop = await runToolLoop(client, { ...base, tools: [search(), answer], maxTurns: 2 })
    expect(loop).toMatchObject({ stopReason: 'max_turns', terminalInput: null })
    expect(loop.salvaged).toBeUndefined()
    expect(client.calls).toHaveLength(2)
  })

  it('returns no_tool_call on prose, unsalvaged', async () => {
    const client = new FakeChatClient([{ text: 'I think the answer is 4.' }])
    const loop = await runToolLoop(client, { ...base, tools: [search(), answer] })
    expect(loop).toMatchObject({ stopReason: 'no_tool_call', terminalInput: null })
    expect(client.calls).toHaveLength(1)
  })
})

describe("onExhaustion: 'final-answer' (the default)", () => {
  it('salvages prose with ONE forced call to the terminal tool', async () => {
    const onExhausted = vi.fn()
    const client = new FakeChatClient([
      { text: 'The answer is 4.' },
      { toolUses: [{ name: 'submit_answer', input: { answer: '4' } }] },
    ])
    const loop = await runToolLoop(client, {
      ...base,
      tools: [search(), answer],
      policy: { maxTurns: 5 },
      onExhausted,
    })
    expect(loop).toMatchObject({
      stopReason: 'no_tool_call',
      salvaged: true,
      terminalTool: 'submit_answer',
      terminalInput: { answer: '4' },
    })
    expect(onExhausted).toHaveBeenCalledWith('no_tool_call')
    expect(client.calls[1]?.toolChoice).toEqual({ type: 'tool', name: 'submit_answer' })
  })

  it('salvages at the turn cap, which a policy may lower but never raise', async () => {
    const client = new FakeChatClient([
      { toolUses: [{ name: 'search', input: { q: 'a' } }] },
      { toolUses: [{ name: 'submit_answer', input: { answer: 'from salvage' } }] },
    ])
    const loop = await runToolLoop(client, {
      ...base,
      tools: [search(), answer],
      maxTurns: 1,
      policy: { maxTurns: 10 },
    })
    expect(loop).toMatchObject({ stopReason: 'max_turns', turns: 1, salvaged: true })
  })

  it('fails the run when the salvage cannot produce an answer — never a silent success', async () => {
    const client = new FakeChatClient([
      { text: 'prose' },
      { text: 'still prose' },
      { text: 'and again' },
    ])
    await expect(
      runToolLoop(client, { ...base, tools: [search(), answer], policy: {} })
    ).rejects.toBeInstanceOf(StructuredOutputError)
  })

  it('lets a provider error out of the salvage, so a cancel or an outage is not mistaken for exhaustion', async () => {
    const client = new FakeChatClient([
      { text: 'prose' },
      { error: new AiError('unavailable', 'anthropic', 'Agent run cancelled') },
    ])
    await expect(
      runToolLoop(client, { ...base, tools: [search(), answer], policy: {} })
    ).rejects.toBeInstanceOf(AiError)
  })

  it('throws ToolLoopExhaustedError when there is no single terminal tool to force', async () => {
    const client = new FakeChatClient([{ text: 'prose' }])
    await expect(
      runToolLoop(client, { ...base, tools: [search()], policy: {} })
    ).rejects.toMatchObject({ name: 'ToolLoopExhaustedError', reason: 'no_tool_call' })
  })
})

describe("onExhaustion: 'fail'", () => {
  it('throws instead of salvaging', async () => {
    const client = new FakeChatClient([{ text: 'prose' }])
    const err = await runToolLoop(client, {
      ...base,
      tools: [search(), answer],
      policy: { onExhaustion: 'fail' },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ToolLoopExhaustedError)
    expect(err).toMatchObject({ reason: 'no_tool_call', turns: 1 })
    expect(client.calls).toHaveLength(1)
  })
})

describe('repeatedFailureLimit', () => {
  it('stops after N consecutive failing calls', async () => {
    const client = new FakeChatClient([
      { toolUses: [{ name: 'flaky', input: { q: '1' } }] },
      { toolUses: [{ name: 'flaky', input: { q: '2' } }] },
      { toolUses: [{ name: 'flaky', input: { q: '3' } }] },
    ])
    const err = await runToolLoop(client, {
      ...base,
      tools: [failing(), answer],
      policy: { repeatedFailureLimit: 2, onExhaustion: 'fail' },
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({ reason: 'repeated_failures', turns: 2 })
    expect(client.calls).toHaveLength(2)
  })

  it('resets on a success', async () => {
    const client = new FakeChatClient([
      { toolUses: [{ name: 'flaky', input: { q: '1' } }] },
      { toolUses: [{ name: 'search', input: { q: 'ok' } }] },
      { toolUses: [{ name: 'flaky', input: { q: '2' } }] },
      { toolUses: [{ name: 'submit_answer', input: { answer: 'done' } }] },
    ])
    const loop = await runToolLoop(client, {
      ...base,
      tools: [failing(), search(), answer],
      policy: { repeatedFailureLimit: 2 },
    })
    expect(loop).toMatchObject({ terminalInput: { answer: 'done' } })
    expect(loop.salvaged).toBeUndefined()
  })
})

describe('maxToolCalls', () => {
  it('answers EVERY call in the turn that crosses the budget, runs only what fits, then salvages', async () => {
    const handler = vi.fn(async ({ q }: { q: string }) => `found ${q}`)
    const client = new FakeChatClient([
      {
        toolUses: [
          { name: 'search', input: { q: 'a' } },
          { name: 'search', input: { q: 'b' } },
          { name: 'search', input: { q: 'c' } },
        ],
      },
      { toolUses: [{ name: 'submit_answer', input: { answer: 'salvaged' } }] },
    ])
    const loop = await runToolLoop(client, {
      ...base,
      tools: [search(handler), answer],
      policy: { maxToolCalls: 2 },
    })
    expect(handler).toHaveBeenCalledTimes(2)
    expect(loop).toMatchObject({ stopReason: 'max_tool_calls', salvaged: true })
    const { used, answered } = pairing(client.calls[1]?.messages ?? [])
    expect(answered).toEqual(used)
    const results = loop.messages.flatMap(m =>
      typeof m.content === 'string' ? [] : m.content.filter(b => b.type === 'tool_result')
    ) as Extract<ContentBlock, { type: 'tool_result' }>[]
    expect(results.at(-1)).toMatchObject({
      isError: true,
      content: expect.stringMatching(/Not run/),
    })
  })

  it('counts the calls a resumed transcript already made', async () => {
    const resume: ToolLoopCheckpoint = {
      turns: 2,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [
        ...seed,
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'search', input: { q: 'a' } },
            { type: 'tool_use', id: 't2', name: 'search', input: { q: 'b' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 't1', content: 'x' },
            { type: 'tool_result', toolUseId: 't2', content: 'y' },
          ],
        },
      ],
    }
    const client = new FakeChatClient([
      { toolUses: [{ name: 'submit_answer', input: { answer: 'salvaged' } }] },
    ])
    const loop = await runToolLoop(client, {
      ...base,
      tools: [search(), answer],
      resume,
      policy: { maxToolCalls: 2 },
    })
    // The only model call is the forced salvage: no fresh allowance for the resumed attempt.
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]?.toolChoice).toEqual({ type: 'tool', name: 'submit_answer' })
    expect(loop).toMatchObject({ stopReason: 'max_tool_calls', salvaged: true })
  })
})

describe('maxDurationSeconds', () => {
  it('counts active time carried in the checkpoint, not time since the run started', async () => {
    const resume: ToolLoopCheckpoint = {
      turns: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: seed,
      activeMs: 61_000,
    }
    const client = new FakeChatClient([])
    const err = await runToolLoop(client, {
      ...base,
      tools: [search(), answer],
      resume,
      policy: { maxDurationSeconds: 60, onExhaustion: 'fail' },
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({ reason: 'max_duration' })
    expect(client.calls).toHaveLength(0)
  })

  it('writes the active time into every checkpoint, and reads one written without it as zero', async () => {
    const saved: ToolLoopCheckpoint[] = []
    const client = new FakeChatClient([
      { toolUses: [{ name: 'search', input: { q: 'a' } }] },
      { toolUses: [{ name: 'submit_answer', input: { answer: 'ok' } }] },
    ])
    await runToolLoop(client, {
      ...base,
      tools: [search(), answer],
      resume: {
        turns: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: seed,
        activeMs: 500,
      },
      onCheckpoint: c => {
        saved.push(c)
      },
    })
    expect(saved[0]?.activeMs).toBeGreaterThanOrEqual(500)
    expect(
      parseToolLoopCheckpoint({
        turns: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        messages: [],
      })
    ).not.toHaveProperty('activeMs')
    expect(
      parseToolLoopCheckpoint({
        turns: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        messages: [],
        activeMs: 42,
      })?.activeMs
    ).toBe(42)
  })
})

describe('authorizeTool', () => {
  it('refuses a call before its handler runs and tells the model why', async () => {
    const handler = vi.fn(async () => 'should not run')
    const client = new FakeChatClient([
      { toolUses: [{ name: 'search', input: { q: 'secret' } }] },
      { toolUses: [{ name: 'submit_answer', input: { answer: 'ok' } }] },
    ])
    const authorizeTool = vi.fn(async () => ({ allow: false, reason: 'no secrets here' }))
    const loop = await runToolLoop(client, {
      ...base,
      tools: [search(handler), answer],
      authorizeTool,
    })
    expect(handler).not.toHaveBeenCalled()
    expect(authorizeTool).toHaveBeenCalledWith({
      name: 'search',
      input: { q: 'secret' },
      toolUseId: 'toolu_0_0',
      turn: 1,
    })
    const result = (loop.messages[2]?.content as ContentBlock[] | undefined)?.[0]
    expect(result).toMatchObject({
      type: 'tool_result',
      isError: true,
      content: expect.stringContaining('no secrets here'),
    })
  })

  it('never asks a person to approve a call policy refuses', async () => {
    const gated: Tool<{ to: string }> = {
      name: 'send',
      description: 'Send mail',
      schema: z.object({ to: z.string() }),
      requiresApproval: true,
      handler: async () => 'sent',
    }
    const client = new FakeChatClient([
      { toolUses: [{ name: 'send', input: { to: 'everyone' } }] },
      { toolUses: [{ name: 'submit_answer', input: { answer: 'refused' } }] },
    ])
    const loop = runToolLoop(client, {
      ...base,
      tools: [gated as Tool, answer],
      authorizeTool: call => call.name !== 'send',
    })
    await expect(loop).resolves.toMatchObject({ terminalInput: { answer: 'refused' } })
    await expect(loop).resolves.not.toBeInstanceOf(InterruptRequested)
  })
})

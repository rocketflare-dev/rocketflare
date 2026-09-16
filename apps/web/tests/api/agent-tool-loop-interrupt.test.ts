/**
 * `runToolLoop`'s human-in-the-loop gate (issue #17), driven with a `FakeChatClient` and no
 * database — the loop knows nothing about rows.
 *
 * The three properties worth breaking a build over:
 *
 * - **The gate raises BEFORE any handler runs**, and it scans the whole turn, so a turn with three
 *   calls and one gate parks with nothing executed.
 * - **The resume path answers pending tool calls with the SAME `executeToolUses`** (T1). Two copies
 *   of the approval rules is how a gate ends up bypassed on the resume path only, and the resume
 *   path is the one nobody exercises by hand.
 * - **A tool handler that raises `InterruptRequested` propagates** (T3) instead of becoming the
 *   `isError` result `runHandler` makes of every other throw.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  appendUserText,
  InterruptDeclinedError,
  InterruptRequested,
  type RunToolLoopOptions,
  runToolLoop,
  type Tool,
  type ToolApproval,
  type ToolLoopCheckpoint,
} from '@/api/services/ai/kit'
import type { ChatMessage } from '@/api/services/ai/types'
import { FakeChatClient, type FakeScript, type FakeTurn } from '../helpers/ai'

/**
 * `FakeChatClient` records `params` BY REFERENCE, and `runToolLoop` keeps pushing onto the same
 * `messages` array — so a test that cares what ONE request carried has to snapshot it at call
 * time, or it reads the transcript as it ended up rather than as it was sent.
 */
function snapshotting(turns: FakeTurn[]) {
  const sent: ChatMessage[][] = []
  const script: FakeScript = (params, index) => {
    sent.push(structuredClone(params.messages))
    return turns[index] ?? turns.at(-1) ?? {}
  }
  return { script, sent }
}

const sendTool = (handler = vi.fn(async () => 'sent')): Tool<{ to: string }> => ({
  name: 'send_email',
  description: 'Send an email',
  schema: z.object({ to: z.string() }),
  handler,
  requiresApproval: true,
  approvalMessage: 'Send this email?',
  allowEdits: true,
})

const lookupTool = (handler = vi.fn(async () => 'found')): Tool<{ q: string }> => ({
  name: 'lookup',
  description: 'Look something up',
  schema: z.object({ q: z.string() }),
  handler,
})

const answerTool: Tool<{ answer: string }> = {
  name: 'submit_answer',
  description: 'Answer',
  schema: z.object({ answer: z.string() }),
}

function loop(script: FakeScript, opts: Partial<RunToolLoopOptions> = {}) {
  const client = new FakeChatClient(script, 'anthropic_compatible')
  const run = runToolLoop(client, {
    model: 'fake',
    system: 'be useful',
    messages: [{ role: 'user', content: 'do the thing' }],
    tools: [],
    maxTurns: 6,
    ...opts,
  })
  return { client, run }
}

describe('runToolLoop: the approval gate', () => {
  it('raises before the handler runs, and scans the whole turn', async () => {
    const send = vi.fn(async () => 'sent')
    const lookup = vi.fn(async () => 'found')
    const checkpoints: ToolLoopCheckpoint[] = []
    const { run } = loop(
      [
        {
          toolUses: [
            { id: 'call_a', name: 'lookup', input: { q: 'one' } },
            { id: 'call_b', name: 'send_email', input: { to: 'a@example.test' } },
            { id: 'call_c', name: 'lookup', input: { q: 'two' } },
          ],
        },
      ],
      {
        tools: [sendTool(send), lookupTool(lookup), answerTool],
        onCheckpoint: cp => void checkpoints.push(cp),
      }
    )

    const err = await run.catch(e => e)
    expect(err).toBeInstanceOf(InterruptRequested)
    expect((err as InterruptRequested).requests).toHaveLength(1)
    expect((err as InterruptRequested).requests[0]).toMatchObject({
      key: 'tool:call_b',
      toolCallId: 'call_b',
      spec: { kind: 'approval', message: 'Send this email?' },
    })
    // Not one handler ran — including the two UNGATED calls in the same turn. That is what makes
    // resuming cheap: only the approved call needs to be idempotent.
    expect(send).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
    // And the checkpoint was written FIRST, with the assistant turn on it, or the resumed attempt
    // would re-pay for every turn before this one.
    expect(checkpoints).toHaveLength(1)
    const last = checkpoints[0]?.messages.at(-1)
    expect(last?.role).toBe('assistant')
  })

  it('carries the tool arguments and its JSON Schema into the ask', async () => {
    const { run } = loop(
      [{ toolUses: [{ id: 'c1', name: 'send_email', input: { to: 'x@y.z' } }] }],
      {
        tools: [sendTool(), answerTool],
      }
    )
    const err = (await run.catch(e => e)) as InterruptRequested
    const spec = err.requests[0]?.spec
    expect(spec?.kind).toBe('approval')
    if (spec?.kind !== 'approval') throw new Error('expected an approval ask')
    expect(spec.tool).toMatchObject({
      name: 'send_email',
      input: { to: 'x@y.z' },
      allowEdits: true,
    })
    expect(spec.tool?.inputSchema).toMatchObject({ type: 'object' })
  })

  it('never asks about arguments the tool would reject anyway', async () => {
    const send = vi.fn(async () => 'sent')
    const { run } = loop(
      [
        { toolUses: [{ id: 'c1', name: 'send_email', input: { to: 42 } }] },
        { toolUses: [{ name: 'submit_answer', input: { answer: 'ok' } }] },
      ],
      { tools: [sendTool(send), answerTool] }
    )
    const result = await run
    expect(result.terminalInput).toEqual({ answer: 'ok' })
    expect(send).not.toHaveBeenCalled()
    // It took the ordinary `isError` path instead, so the model was told what was wrong with it.
    const results = result.messages[2]
    expect(JSON.stringify(results)).toContain('Invalid input for send_email')
  })

  it('a predicate gates only the calls that matter', async () => {
    const send = vi.fn(async () => 'sent')
    const gated: Tool<{ to: string }> = {
      ...sendTool(send),
      requiresApproval: false,
      requiresApprovalWhen: input => input.to.endsWith('@example.com'),
    }
    const { run } = loop(
      [
        { toolUses: [{ id: 'c1', name: 'send_email', input: { to: 'a@internal.test' } }] },
        { toolUses: [{ name: 'submit_answer', input: { answer: 'done' } }] },
      ],
      { tools: [gated, answerTool] }
    )
    expect((await run).terminalInput).toEqual({ answer: 'done' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('returns instead of throwing when the host asks for it (the Part-3 seam)', async () => {
    const { run } = loop(
      [{ toolUses: [{ id: 'c1', name: 'send_email', input: { to: 'a@b.c' } }] }],
      {
        tools: [sendTool(), answerTool],
        onInterrupt: async () => 'return',
      }
    )
    const result = await run
    expect(result.stopReason).toBe('interrupt')
    expect(result.interrupts?.[0]?.key).toBe('tool:c1')
    expect(result.terminalInput).toBeNull()
  })
})

describe('runToolLoop: answering a gate', () => {
  const parkedCheckpoint = (toolCallId = 'c1'): ToolLoopCheckpoint => ({
    messages: [
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolCallId, name: 'send_email', input: { to: 'a@b.c' } }],
      },
    ],
    turns: 1,
    usage: { inputTokens: 10, outputTokens: 5 },
  })

  const approval = (over: Partial<ToolApproval> = {}): Map<string, ToolApproval> =>
    new Map([['c1', { interruptId: 'int-1', status: 'resolved', onReject: 'cancel_run', ...over }]])

  it('T1: answers the pending tool calls BEFORE taking a turn, so the model never sees an unanswered tool_use', async () => {
    const send = vi.fn(async () => 'sent')
    const { script, sent } = snapshotting([
      { toolUses: [{ name: 'submit_answer', input: { answer: 'ok' } }] },
    ])
    const { run } = loop(script, {
      tools: [sendTool(send), answerTool],
      resume: parkedCheckpoint(),
      approvals: approval(),
    })
    const result = await run
    expect(send).toHaveBeenCalledWith({ to: 'a@b.c' })
    expect(result.terminalInput).toEqual({ answer: 'ok' })
    // The first request of the resumed attempt already carries the tool_result turn.
    const first = sent[0]?.at(-1)
    expect(first?.role).toBe('user')
    expect(JSON.stringify(first?.content)).toContain('sent')
    // And the turn counter continued rather than restarting.
    expect(result.turns).toBe(2)
  })

  it('an approver may edit the arguments the handler sees', async () => {
    const send = vi.fn(async () => 'sent')
    const { run } = loop([{ toolUses: [{ name: 'submit_answer', input: { answer: 'ok' } }] }], {
      tools: [sendTool(send), answerTool],
      resume: parkedCheckpoint(),
      approvals: approval({ input: { to: 'corrected@example.test' } }),
    })
    await run
    expect(send).toHaveBeenCalledWith({ to: 'corrected@example.test' })
  })

  it('cancel_run throws InterruptDeclinedError and never runs the tool', async () => {
    const send = vi.fn(async () => 'sent')
    const { run } = loop([], {
      tools: [sendTool(send), answerTool],
      resume: parkedCheckpoint(),
      approvals: approval({ status: 'cancelled', note: 'not this one', onReject: 'cancel_run' }),
    })
    const err = await run.catch(e => e)
    expect(err).toBeInstanceOf(InterruptDeclinedError)
    expect((err as InterruptDeclinedError).note).toBe('not this one')
    expect(send).not.toHaveBeenCalled()
  })

  it('tell_model hands the refusal back as a NON-error result and the run carries on', async () => {
    const send = vi.fn(async () => 'sent')
    const { script, sent } = snapshotting([
      { toolUses: [{ name: 'submit_answer', input: { answer: 'ok' } }] },
    ])
    const { run } = loop(script, {
      tools: [sendTool(send), answerTool],
      resume: parkedCheckpoint(),
      approvals: approval({ status: 'cancelled', onReject: 'tell_model' }),
    })
    expect((await run).terminalInput).toEqual({ answer: 'ok' })
    expect(send).not.toHaveBeenCalled()
    const blocks = sent[0]?.at(-1)?.content
    expect(Array.isArray(blocks) && blocks[0]).toMatchObject({
      type: 'tool_result',
      isError: false,
    })
  })

  it('an approved tool executes exactly once across a step retry', async () => {
    const send = vi.fn(async () => 'sent')
    // `runApproved` stands in for `ctx.once` — the durable-effect ledger, here a Map.
    const recorded = new Map<string, unknown>()
    const runApproved = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      if (recorded.has(key)) return recorded.get(key) as T
      const value = await fn()
      recorded.set(key, value)
      return value
    }
    const options: Partial<RunToolLoopOptions> = {
      tools: [sendTool(send), answerTool],
      resume: parkedCheckpoint(),
      approvals: approval(),
      runApproved,
    }
    await loop([{ toolUses: [{ name: 'submit_answer', input: { answer: 'one' } }] }], options).run
    await loop([{ toolUses: [{ name: 'submit_answer', input: { answer: 'two' } }] }], options).run
    expect(send).toHaveBeenCalledTimes(1)
    expect([...recorded.keys()]).toEqual(['tool:int-1'])
  })

  it('an ask still unanswered on resume parks again rather than running the tool', async () => {
    const send = vi.fn(async () => 'sent')
    const { run } = loop([], { tools: [sendTool(send), answerTool], resume: parkedCheckpoint() })
    await expect(run).rejects.toBeInstanceOf(InterruptRequested)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('runToolLoop: interrupts raised inside a handler (T3)', () => {
  it('propagates instead of becoming an isError result', async () => {
    const asking: Tool<{ q: string }> = {
      name: 'lookup',
      description: 'Look something up',
      schema: z.object({ q: z.string() }),
      handler: async () => {
        throw new InterruptRequested([
          {
            key: 'which-customer',
            spec: { kind: 'input', message: 'Which customer?', multiline: false },
          },
        ])
      },
    }
    const { run } = loop([{ toolUses: [{ id: 'c1', name: 'lookup', input: { q: 'x' } }] }], {
      tools: [asking, answerTool],
    })
    const err = await run.catch(e => e)
    expect(err).toBeInstanceOf(InterruptRequested)
    expect((err as InterruptRequested).requests[0]?.key).toBe('which-customer')
  })

  it('every other throw is still an isError result the model can recover from', async () => {
    const broken: Tool<{ q: string }> = {
      name: 'lookup',
      description: 'Look something up',
      schema: z.object({ q: z.string() }),
      handler: async () => {
        throw new Error('the index is down')
      },
    }
    const { run } = loop(
      [
        { toolUses: [{ id: 'c1', name: 'lookup', input: { q: 'x' } }] },
        { toolUses: [{ name: 'submit_answer', input: { answer: 'recovered' } }] },
      ],
      { tools: [broken, answerTool] }
    )
    expect((await run).terminalInput).toEqual({ answer: 'recovered' })
  })
})

describe('steering notes reach the model without two consecutive user turns', () => {
  it('appendUserText folds into a trailing user turn', () => {
    const toolResults: ChatMessage[] = [
      { role: 'user', content: 'seed' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'lookup', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'found' }] },
    ]
    appendUserText(toolResults, 'focus on Q3')
    expect(toolResults).toHaveLength(3)
    expect(toolResults[2]?.content).toEqual([
      { type: 'tool_result', toolUseId: 'c1', content: 'found' },
      { type: 'text', text: 'focus on Q3' },
    ])

    const afterAssistant: ChatMessage[] = [
      { role: 'user', content: 'seed' },
      { role: 'assistant', content: 'thinking' },
    ]
    appendUserText(afterAssistant, 'focus on Q3')
    expect(afterAssistant).toHaveLength(3)
    expect(afterAssistant[2]).toEqual({ role: 'user', content: 'focus on Q3' })

    const stringTail: ChatMessage[] = [{ role: 'user', content: 'seed' }]
    appendUserText(stringTail, 'and this')
    expect(stringTail).toEqual([{ role: 'user', content: 'seed\n\nand this' }])
  })

  it('beforeTurn injects a note into the turn about to run, never as a second user turn', async () => {
    const turns: number[] = []
    const { script, sent } = snapshotting([
      { toolUses: [{ id: 'c1', name: 'lookup', input: { q: 'x' } }] },
      { toolUses: [{ name: 'submit_answer', input: { answer: 'ok' } }] },
    ])
    const { run } = loop(script, {
      tools: [lookupTool(), answerTool],
      beforeTurn: async turn => {
        turns.push(turn)
        return turn === 2 ? [{ role: 'user', content: 'actually, focus on Q3' }] : undefined
      },
    })
    await run
    expect(turns).toEqual([1, 2])
    const second = sent[1] ?? []
    // The note folded into the tool_result turn rather than opening a new one.
    expect(second.filter(m => m.role === 'user')).toHaveLength(2)
    expect(JSON.stringify(second.at(-1)?.content)).toContain('focus on Q3')
    for (const [i, message] of second.entries()) {
      if (i > 0) expect(message.role).not.toBe(second[i - 1]?.role)
    }
  })
})

/**
 * `runToolLoop` with a journal, no database: the record-and-resume contract the runtime builds on
 * (`ctx.journal`, `agent_run_turns`). Each test runs two ATTEMPTS against one store — a fresh
 * client and a fresh `open()` per attempt, as a retried Workflow step gets — and checks what the
 * second one is spared:
 *   - a turn recorded against the same transcript is served, not billed again;
 *   - a tool result recorded mid-turn is served, and only the unrecorded call re-runs;
 *   - a `sideEffects` call that started and never settled is an unknown outcome the model sees —
 *     unless it is `durable`, which re-runs it with the same idempotency key;
 *   - a transcript that changed underneath a record asks again and replaces the record;
 *   - served work emits no events (the attempt that recorded it did), steering notes are
 *     re-applied rather than re-asked, the salvage call is journaled, and two loops under one key
 *     in one attempt throw.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { attemptKeys, EffectKeyConflictError } from '@/api/services/agents/keys'
import {
  type RecordedModelTurn,
  type RecordedToolCall,
  runToolLoop,
  type Tool,
  type ToolLoopCheckpoint,
  type ToolLoopEvent,
  type ToolLoopJournal,
  UNKNOWN_OUTCOME_RESULT,
} from '@/api/services/ai/agent-loop'
import type { ChatMessage } from '@/api/services/ai/types'
import { FakeChatClient } from '../helpers/ai'

/** One store across attempts; `attempt()` is a fresh journal over it, as `executeRun` builds one. */
function memoryStore() {
  const models = new Map<string, Map<number, RecordedModelTurn>>()
  const tools = new Map<string, Map<string, RecordedToolCall>>()
  const failSettle = new Set<string>()
  const loop = <V>(store: Map<string, Map<string | number, V>>, key: string) => {
    let rows = store.get(key)
    if (!rows) {
      rows = new Map()
      store.set(key, rows)
    }
    return rows
  }
  return {
    models,
    tools,
    /** The next settle of this call id throws — a database blip that kills the attempt. */
    failSettleOf: (id: string) => failSettle.add(id),
    attempt(): ToolLoopJournal {
      const keys = attemptKeys('tool loop')
      return {
        async open(key) {
          keys.claim(key)
          const m = loop(models as Map<string, Map<string | number, RecordedModelTurn>>, key)
          const t = loop(tools as Map<string, Map<string | number, RecordedToolCall>>, key)
          return {
            reemitServed: false,
            modelTurn: turn => m.get(turn) ?? null,
            async recordModelTurn(turn, record) {
              m.set(turn, record)
            },
            toolCall: id => t.get(id) ?? null,
            async startToolCall(_turn, id) {
              t.set(id, { status: 'started' })
            },
            async settleToolCall(_turn, id, _name, result) {
              if (failSettle.delete(id)) throw new Error('database unavailable')
              t.set(id, { status: 'settled', ...result })
            },
            async forgetToolCall(id) {
              t.delete(id)
            },
          }
        },
      }
    },
  }
}

const answer: Tool<{ answer: string }> = {
  name: 'answer',
  description: 'terminal',
  schema: z.object({ answer: z.string() }),
}

function readTool(name = 'search') {
  const handler = vi.fn(async (input: { q: string }) => `found ${input.q}`)
  const tool: Tool<{ q: string }> = {
    name,
    description: 'read',
    schema: z.object({ q: z.string() }),
    handler,
  }
  return { tool, handler }
}

const seed: ChatMessage[] = [{ role: 'user', content: 'go' }]

describe('runToolLoop with a journal', () => {
  it('a retry after a mid-turn crash is served the finished call and the turn; only the rest runs', async () => {
    const store = memoryStore()
    const a = readTool('a')
    const b = readTool('b')
    const script = [
      {
        toolUses: [
          { id: 'call-a', name: 'a', input: { q: '1' } },
          { id: 'call-b', name: 'b', input: { q: '2' } },
        ],
      },
      { toolUses: [{ id: 'call-z', name: 'answer', input: { answer: 'done' } }] },
    ]
    const checkpoints: ToolLoopCheckpoint[] = []
    store.failSettleOf('call-b')
    const first = new FakeChatClient(script)
    await expect(
      runToolLoop(first, {
        model: 'm',
        system: 's',
        messages: seed,
        tools: [a.tool, b.tool, answer as Tool],
        // Sequential, so `a` has settled when `b`'s record write fails.
        policy: { maxConcurrentToolCalls: 1 },
        journal: store.attempt(),
        onCheckpoint: cp => void checkpoints.push(cp),
      })
    ).rejects.toThrow(/database unavailable/)
    expect(first.calls).toHaveLength(1)
    // The checkpoint taken BEFORE the tools ran holds the assistant turn with both calls pending.
    expect(checkpoints).toHaveLength(1)

    const second = new FakeChatClient(script.slice(1))
    const result = await runToolLoop(second, {
      model: 'm',
      system: 's',
      messages: seed,
      tools: [a.tool, b.tool, answer as Tool],
      policy: { maxConcurrentToolCalls: 1 },
      journal: store.attempt(),
      resume: checkpoints[0],
    })
    expect(result.terminalInput).toEqual({ answer: 'done' })
    expect(a.handler).toHaveBeenCalledTimes(1)
    expect(b.handler).toHaveBeenCalledTimes(2)
    // Turn 1 came from the checkpoint; only turn 2 was billed in the second attempt.
    expect(second.calls).toHaveLength(1)
  })

  it('a loop restarted from the seed is served every recorded turn and result for nothing', async () => {
    const store = memoryStore()
    const search = readTool()
    const script = [
      { toolUses: [{ id: 's1', name: 'search', input: { q: 'x' } }] },
      { toolUses: [{ id: 's2', name: 'search', input: { q: 'y' } }] },
      { error: new Error('the isolate was evicted') },
    ]
    await expect(
      runToolLoop(new FakeChatClient(script), {
        model: 'm',
        system: 's',
        messages: seed,
        tools: [search.tool, answer as Tool],
        journal: store.attempt(),
      })
    ).rejects.toThrow(/evicted/)

    // No checkpoint at all — a loop inside `ctx.map`, or a plugin's.
    const second = new FakeChatClient([
      { toolUses: [{ id: 'z', name: 'answer', input: { answer: 'ok' } }] },
    ])
    const events: ToolLoopEvent[] = []
    const result = await runToolLoop(second, {
      model: 'm',
      system: 's',
      messages: seed,
      tools: [search.tool, answer as Tool],
      journal: store.attempt(),
      onEvent: event => void events.push(event),
    })
    expect(result.terminalInput).toEqual({ answer: 'ok' })
    expect(result.turns).toBe(3)
    // Usage counts the served turns too: it is the RUN's, not the attempt's.
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 15 })
    expect(second.calls).toHaveLength(1)
    expect(search.handler).toHaveBeenCalledTimes(2)
    // The served turns' events were the first attempt's to emit; only turn 3 emits here.
    expect(events.map(e => e.kind)).toEqual(['tool_call'])
    // And the request it sent carries both earlier turns verbatim (the fake keeps the live array,
    // so the sixth message is turn 3's own reply, pushed after the call).
    expect(second.calls[0]?.messages.slice(0, 5).map(m => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
  })

  it('a side-effect call that started and never settled is an unknown outcome, never a second send', async () => {
    const store = memoryStore()
    const send = vi.fn(async () => 'sent')
    const sendTool: Tool<{ to: string }> = {
      name: 'send',
      description: 'sends',
      schema: z.object({ to: z.string() }),
      sideEffects: true,
      handler: send,
    }
    const script = [
      { toolUses: [{ id: 'mail-1', name: 'send', input: { to: 'a@b.c' } }] },
      { toolUses: [{ id: 'z', name: 'answer', input: { answer: 'checked' } }] },
    ]
    store.failSettleOf('mail-1')
    await expect(
      runToolLoop(new FakeChatClient(script), {
        model: 'm',
        system: 's',
        messages: seed,
        tools: [sendTool as Tool, answer as Tool],
        journal: store.attempt(),
      })
    ).rejects.toThrow(/database unavailable/)
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.tools.get('tool-loop')?.get('mail-1')).toEqual({ status: 'started' })

    const second = new FakeChatClient(script.slice(1))
    await runToolLoop(second, {
      model: 'm',
      system: 's',
      messages: seed,
      tools: [sendTool as Tool, answer as Tool],
      journal: store.attempt(),
    })
    expect(send).toHaveBeenCalledTimes(1)
    // `at(-2)`: the fake keeps the live array, and the loop has pushed turn 2's reply since.
    const results = second.calls[0]?.messages.at(-2)
    expect(results?.content).toEqual([
      { type: 'tool_result', toolUseId: 'mail-1', content: UNKNOWN_OUTCOME_RESULT, isError: true },
    ])
    expect(store.tools.get('tool-loop')?.get('mail-1')).toMatchObject({ status: 'settled' })
  })

  it('a durable side-effect call re-runs with the same idempotency key', async () => {
    const store = memoryStore()
    const charge = vi.fn(async () => 'charged')
    const chargeTool: Tool<{ cents: number }> = {
      name: 'charge',
      description: 'charges',
      schema: z.object({ cents: z.number() }),
      sideEffects: true,
      durable: true,
      handler: charge,
    }
    const script = [
      { toolUses: [{ id: 'pay-1', name: 'charge', input: { cents: 500 } }] },
      { toolUses: [{ id: 'z', name: 'answer', input: { answer: 'paid' } }] },
    ]
    store.failSettleOf('pay-1')
    const tools = [chargeTool as Tool, answer as Tool]
    await expect(
      runToolLoop(new FakeChatClient(script), {
        model: 'm',
        system: 's',
        messages: seed,
        tools,
        journal: store.attempt(),
      })
    ).rejects.toThrow()
    await runToolLoop(new FakeChatClient(script.slice(1)), {
      model: 'm',
      system: 's',
      messages: seed,
      tools,
      journal: store.attempt(),
    })
    expect(charge).toHaveBeenCalledTimes(2)
    for (const call of charge.mock.calls as unknown as [unknown, unknown][]) {
      expect(call[1]).toEqual({ toolCallId: 'pay-1', idempotencyKey: 'pay-1' })
    }
  })

  it('a handler that asks a person forgets its started marker, so the resumed attempt runs it', async () => {
    const store = memoryStore()
    const { InterruptRequested } = await import('@/api/services/ai/agent-loop')
    let answered = false
    const book = vi.fn(async () => {
      if (!answered) {
        throw new InterruptRequested([
          { key: 'which-room', spec: { kind: 'input', message: '?', multiline: false } },
        ])
      }
      return 'booked'
    })
    const bookTool: Tool<{ room: string }> = {
      name: 'book',
      description: 'books',
      schema: z.object({ room: z.string() }),
      sideEffects: true,
      handler: book,
    }
    const script = [
      { toolUses: [{ id: 'b-1', name: 'book', input: { room: 'A' } }] },
      { toolUses: [{ id: 'z', name: 'answer', input: { answer: 'booked' } }] },
    ]
    await expect(
      runToolLoop(new FakeChatClient(script), {
        model: 'm',
        system: 's',
        messages: seed,
        tools: [bookTool as Tool, answer as Tool],
        journal: store.attempt(),
      })
    ).rejects.toBeInstanceOf(InterruptRequested)
    expect(store.tools.get('tool-loop')?.has('b-1')).toBe(false)

    answered = true
    await runToolLoop(new FakeChatClient(script.slice(1)), {
      model: 'm',
      system: 's',
      messages: seed,
      tools: [bookTool as Tool, answer as Tool],
      journal: store.attempt(),
    })
    expect(book).toHaveBeenCalledTimes(2)
    expect(store.tools.get('tool-loop')?.get('b-1')).toEqual({
      status: 'settled',
      text: 'booked',
      isError: false,
    })
  })

  it('a transcript that changed underneath a record asks the model again and replaces it', async () => {
    const store = memoryStore()
    let reply = 'first'
    const flaky: Tool<{ q: string }> = {
      name: 'search',
      description: 'read',
      schema: z.object({ q: z.string() }),
      handler: async () => reply,
    }
    const tools = [flaky as Tool, answer as Tool]
    // Attempt 1 records turn 1 and dies before the result of its read settles.
    store.failSettleOf('s1')
    await expect(
      runToolLoop(
        new FakeChatClient([{ toolUses: [{ id: 's1', name: 'search', input: { q: 'x' } }] }]),
        { model: 'm', system: 's', messages: seed, tools, journal: store.attempt() }
      )
    ).rejects.toThrow()
    // Attempt 2: turn 1 is served, the unrecorded read runs again — and answers differently — so
    // turn 2's transcript is new. Attempt 2 dies after recording turn 2.
    reply = 'second'
    await expect(
      runToolLoop(
        new FakeChatClient([
          { toolUses: [{ id: 's2', name: 'search', input: { q: 'y' } }] },
          { error: new Error('evicted') },
        ]),
        { model: 'm', system: 's', messages: seed, tools, journal: store.attempt() }
      )
    ).rejects.toThrow(/evicted/)
    const turn2 = store.models.get('tool-loop')?.get(2)

    // Attempt 3: drop s1's record (attempt 2 settled it) and change the reply once more, so the
    // re-run read gives turn 2 a transcript its record was not made from.
    store.tools.get('tool-loop')?.delete('s1')
    reply = 'third'
    const third = new FakeChatClient([
      { toolUses: [{ id: 'z', name: 'answer', input: { answer: 'ok' } }] },
    ])
    await runToolLoop(third, {
      model: 'm',
      system: 's',
      messages: seed,
      tools,
      journal: store.attempt(),
    })
    // Turn 2's record answered a transcript that no longer exists: the model was asked again.
    expect(third.calls).toHaveLength(1)
    expect(store.models.get('tool-loop')?.get(2)).not.toEqual(turn2)
  })

  it('a served turn re-applies its steering notes and does not ask beforeTurn again', async () => {
    const store = memoryStore()
    const search = readTool()
    const beforeTurn = vi.fn(async (turn: number) =>
      turn === 1 ? [{ role: 'user' as const, content: 'A person added: be brief' }] : undefined
    )
    await expect(
      runToolLoop(
        new FakeChatClient([
          { toolUses: [{ id: 's1', name: 'search', input: { q: 'x' } }] },
          { error: new Error('evicted') },
        ]),
        {
          model: 'm',
          system: 's',
          messages: seed,
          tools: [search.tool, answer as Tool],
          journal: store.attempt(),
          beforeTurn,
        }
      )
    ).rejects.toThrow()
    beforeTurn.mockClear()

    const second = new FakeChatClient([
      { toolUses: [{ id: 'z', name: 'answer', input: { answer: 'ok' } }] },
    ])
    await runToolLoop(second, {
      model: 'm',
      system: 's',
      messages: seed,
      tools: [search.tool, answer as Tool],
      journal: store.attempt(),
      beforeTurn,
    })
    expect(beforeTurn).toHaveBeenCalledTimes(1)
    expect(beforeTurn).toHaveBeenCalledWith(2)
    // The note delivered to attempt 1 is in attempt 2's transcript, folded into the seed turn.
    expect(JSON.stringify(second.calls[0]?.messages[0])).toContain('be brief')
  })

  it('journals the policy salvage call, so a retry after it is not billed again', async () => {
    const store = memoryStore()
    const options = {
      model: 'm',
      system: 's',
      messages: seed,
      tools: [answer as Tool],
      policy: { onExhaustion: 'final-answer' as const },
    }
    const first = new FakeChatClient([
      { text: 'prose, no tool call' },
      { toolUses: [{ id: 'f', name: 'answer', input: { answer: 'salvaged' } }] },
    ])
    const one = await runToolLoop(first, { ...options, journal: store.attempt() })
    expect(one).toMatchObject({ terminalInput: { answer: 'salvaged' }, salvaged: true })

    const second = new FakeChatClient([])
    const two = await runToolLoop(second, { ...options, journal: store.attempt() })
    expect(two).toMatchObject({ terminalInput: { answer: 'salvaged' }, salvaged: true })
    expect(second.calls).toHaveLength(0)
  })

  it('two loops under one key in one attempt throw; named loops keep separate records', async () => {
    const store = memoryStore()
    const journal = store.attempt()
    const client = () =>
      new FakeChatClient([{ toolUses: [{ id: 'z', name: 'answer', input: { answer: 'ok' } }] }])
    const options = { model: 'm', system: 's', messages: seed, tools: [answer as Tool], journal }
    await runToolLoop(client(), options)
    await expect(runToolLoop(client(), options)).rejects.toBeInstanceOf(EffectKeyConflictError)
    await runToolLoop(client(), { ...options, key: 'second-pass' })
    expect([...store.models.keys()]).toEqual(['tool-loop', 'second-pass'])
  })
})

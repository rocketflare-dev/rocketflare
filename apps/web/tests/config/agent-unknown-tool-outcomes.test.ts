import { agentToolEndEventDataSchema } from '@rocketflare/shared/ai/agents'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  runToolLoop,
  type Tool,
  type ToolLoopCheckpoint,
  type ToolLoopEvent,
} from '@/api/services/ai/kit'
import { FakeChatClient } from '../helpers/ai'

const dummySchema = z.object({ id: z.string() })
const finalAnswerSchema = z.object({ answer: z.string() })

const finalAnswerTool: Tool<{ answer: string }> = {
  name: 'final_answer',
  description: 'Provide final answer',
  schema: finalAnswerSchema,
}

describe('Issue #5: Surface unknown tool outcome after retry instead of silently replaying', () => {
  it('1. does not re-execute side-effecting tool when outcome is reconciled as unknown', async () => {
    let executionCount = 0

    const sideEffectTool: Tool<{ id: string }> = {
      name: 'charge_card',
      description: 'Perform a side effect',
      schema: dummySchema,
      handler: async ({ id }) => {
        executionCount += 1
        return `charged-${id}`
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [{ id: 'call_0', name: 'charge_card', input: { id: 'card_123' } }],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Handled' } }],
      },
    ])

    const events: ToolLoopEvent[] = []
    const unknownMessage =
      'The tool call started but the process stopped before completion was recorded. Outcome is unknown.'

    // Reconciled tool map passed from recovery: call_0 was started in a previous crashed attempt
    const reconciledTools = new Map([
      [
        'call_0',
        {
          toolCallId: 'call_0',
          name: 'charge_card',
          text: unknownMessage,
          isError: false,
          outcome: 'unknown' as const,
        },
      ],
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'Test system',
      messages: [{ role: 'user', content: 'Charge the card' }],
      tools: [sideEffectTool, finalAnswerTool],
      reconciledTools,
      onEvent: event => {
        events.push(event)
      },
    })

    // The tool handler MUST NOT execute because it was reconciled!
    expect(executionCount).toBe(0)

    // The transcript MUST contain the reconciled outcome for the model
    const toolResult = res.messages
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .find(b => b.type === 'tool_result' && b.toolUseId === 'call_0')

    expect(toolResult).toBeDefined()
    if (toolResult && toolResult.type === 'tool_result') {
      expect(toolResult.content).toBe(unknownMessage)
      expect(toolResult.isError).toBe(false)
    }

    // Terminal answer reached successfully
    expect(res.terminalInput).toEqual({ answer: 'Handled' })
  })

  it('2. preserves completed call results while exposing unknown outcome for crashed sibling in concurrent turn', async () => {
    let callAExecution = 0
    let callBExecution = 0

    const testTool: Tool<{ id: string }> = {
      name: 'worker_tool',
      description: 'Worker tool',
      schema: dummySchema,
      handler: async ({ id }) => {
        if (id === 'A') {
          callAExecution += 1
          return 'result-A'
        }
        callBExecution += 1
        return 'result-B'
      },
    }

    const client = new FakeChatClient([
      {
        toolUses: [
          { id: 'call_0', name: 'worker_tool', input: { id: 'A' } }, // call_0: completed before crash
          { id: 'call_1', name: 'worker_tool', input: { id: 'B' } }, // call_1: crashed during execution
        ],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'Completed turn' } }],
      },
    ])

    // call_0 has a known completed result from persisted tool.end
    // call_1 had tool.start without tool.end, reconciled to unknown
    const reconciledTools = new Map([
      [
        'call_0',
        {
          toolCallId: 'call_0',
          name: 'worker_tool',
          text: 'result-A',
          isError: false,
          outcome: 'success' as const,
        },
      ],
      [
        'call_1',
        {
          toolCallId: 'call_1',
          name: 'worker_tool',
          text: 'Outcome is unknown',
          isError: false,
          outcome: 'unknown' as const,
        },
      ],
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'Test system',
      messages: [{ role: 'user', content: 'Run batch' }],
      tools: [testTool, finalAnswerTool],
      reconciledTools,
    })

    // Neither call A nor call B re-executes
    expect(callAExecution).toBe(0)
    expect(callBExecution).toBe(0)

    const blocks = res.messages.flatMap(m => (Array.isArray(m.content) ? m.content : []))
    const resA = blocks.find(b => b.type === 'tool_result' && b.toolUseId === 'call_0')
    const resB = blocks.find(b => b.type === 'tool_result' && b.toolUseId === 'call_1')

    expect(resA).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call_0',
      content: 'result-A',
      isError: false,
    })
    expect(resB).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call_1',
      content: 'Outcome is unknown',
      isError: false,
    })
  })

  it('3. reproduces real crash/recovery path with fresh tool-call IDs on resume', async () => {
    let sideEffectExecutionCount = 0
    let freshToolExecutionCount = 0
    let latestCheckpoint: ToolLoopCheckpoint | undefined

    const abortController = new AbortController()

    const sideEffectTool: Tool<{ id: string }> = {
      name: 'charge_card',
      description: 'Perform a side effect',
      schema: dummySchema,
      handler: async ({ id }) => {
        sideEffectExecutionCount += 1
        // Simulate a process crash / abort during execution of the side-effecting handler
        abortController.abort()
        throw new Error('Process killed mid-handler')
      },
    }

    const freshTool: Tool<{ id: string }> = {
      name: 'send_receipt',
      description: 'Fresh independent tool',
      schema: dummySchema,
      handler: async ({ id }) => {
        freshToolExecutionCount += 1
        return `receipt-sent-${id}`
      },
    }

    // Step 1: Assistant requests charge_card with toolUseId 'call_original_1'
    const firstClient = new FakeChatClient([
      {
        toolUses: [{ id: 'call_original_1', name: 'charge_card', input: { id: 'card_123' } }],
      },
    ])

    // Step 2 & 3: Run begins. The assistant turn is checkpointed BEFORE the handler runs.
    // The process crashes / aborts mid-handler.
    await expect(
      runToolLoop(firstClient, {
        model: 'test-model',
        system: 'Test system',
        messages: [{ role: 'user', content: 'Charge the card' }],
        tools: [sideEffectTool, freshTool, finalAnswerTool],
        signal: abortController.signal,
        onCheckpoint: async cp => {
          latestCheckpoint = cp
        },
      })
    ).rejects.toThrow(/cancelled/)

    // Verify side effect ran once before the crash
    expect(sideEffectExecutionCount).toBe(1)
    // The durable checkpoint recorded the assistant turn before handler execution
    expect(latestCheckpoint).toBeDefined()
    expect(latestCheckpoint?.messages).toHaveLength(2)
    expect(latestCheckpoint?.messages[1]?.role).toBe('assistant')

    // Step 4: Recovery reconciles open tool events.
    // 'call_original_1' had tool.start but no tool.end, so it is reconciled as outcome: 'unknown'
    const unknownMessage =
      'The tool call started but the process stopped before completion was recorded. Outcome is unknown.'
    const reconciledTools = new Map([
      [
        'call_original_1',
        {
          toolCallId: 'call_original_1',
          name: 'charge_card',
          text: unknownMessage,
          isError: false,
          outcome: 'unknown' as const,
        },
      ],
    ])

    // Step 5: Resume from the saved checkpoint.
    // In turn 2 (after the unknown outcome is presented in transcript), the fake model is configured
    // to return a NEW tool call with a NEW tool-call ID ('call_fresh_turn_2'), NOT replaying 'call_original_1'.
    const resumedClient = new FakeChatClient([
      {
        toolUses: [{ id: 'call_fresh_turn_2', name: 'send_receipt', input: { id: 'receipt_456' } }],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'All done after recovery' } }],
      },
    ])

    const res = await runToolLoop(resumedClient, {
      model: 'test-model',
      system: 'Test system',
      messages: [{ role: 'user', content: 'Seed should be ignored on resume' }],
      tools: [sideEffectTool, freshTool, finalAnswerTool],
      resume: latestCheckpoint,
      reconciledTools,
    })

    // Step 6: Assert that the previously uncertain side effect was NOT executed again!
    expect(sideEffectExecutionCount).toBe(1)

    // Step 7: Assert that the unknown outcome is surfaced in the conversation transcript
    const toolResults = res.messages
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .filter(b => b.type === 'tool_result')

    const reconciledResult = toolResults.find(b => b.toolUseId === 'call_original_1')
    expect(reconciledResult).toBeDefined()
    expect(reconciledResult?.content).toBe(unknownMessage)
    expect(reconciledResult?.isError).toBe(false)

    // Step 8: Assert that the genuinely new, unrelated tool call executed
    expect(freshToolExecutionCount).toBe(1)
    const freshResult = toolResults.find(b => b.toolUseId === 'call_fresh_turn_2')
    expect(freshResult).toBeDefined()
    expect(freshResult?.content).toBe('receipt-sent-receipt_456')

    expect(res.terminalInput).toEqual({ answer: 'All done after recovery' })
  })

  it('4. executes newly requested tool calls in subsequent turns even when earlier calls were reconciled', async () => {
    let freshToolExecutions = 0

    const freshTool: Tool<{ id: string }> = {
      name: 'fresh_tool',
      description: 'Fresh tool',
      schema: dummySchema,
      handler: async ({ id }) => {
        freshToolExecutions += 1
        return `fresh-${id}`
      },
    }

    const client = new FakeChatClient([
      {
        // Turn 1: has reconciled call_0
        toolUses: [{ id: 'call_0', name: 'fresh_tool', input: { id: 'reconciled_1' } }],
      },
      {
        // Turn 2: model decides to call fresh_tool with call_1
        toolUses: [{ id: 'call_1', name: 'fresh_tool', input: { id: 'new_2' } }],
      },
      {
        toolUses: [{ name: 'final_answer', input: { answer: 'All finished' } }],
      },
    ])

    const reconciledTools = new Map([
      [
        'call_0',
        {
          toolCallId: 'call_0',
          name: 'fresh_tool',
          text: 'reconciled-outcome',
          isError: false,
          outcome: 'unknown' as const,
        },
      ],
    ])

    const res = await runToolLoop(client, {
      model: 'test-model',
      system: 'Test system',
      messages: [{ role: 'user', content: 'Start' }],
      tools: [freshTool, finalAnswerTool],
      reconciledTools,
    })

    // Turn 1 call_0 was reconciled (not executed); Turn 2 call_1 executed normally
    expect(freshToolExecutions).toBe(1)
    expect(res.turns).toBe(3)
    expect(res.terminalInput).toEqual({ answer: 'All finished' })
  })

  describe('reconcileToolEvents service', () => {
    it('classifies started tool without completion as unknown, leaving completed sibling untouched', async () => {
      const { reconcileToolEvents } = await import('@/api/services/agents/runs')

      const initialEvents = [
        {
          id: 'ev-1',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 1,
          type: 'tool.start',
          data: { name: 'search_knowledge', toolCallId: 'call_known', input: { q: 'hi' } },
          at: new Date('2026-10-22T10:00:00Z'),
        },
        {
          id: 'ev-2',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 2,
          type: 'tool.start',
          data: {
            name: 'send_webhook',
            toolCallId: 'call_crashed',
            input: { url: 'https://ex.com' },
          },
          at: new Date('2026-10-22T10:00:01Z'),
        },
        {
          id: 'ev-3',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 3,
          type: 'tool.end',
          data: { name: 'search_knowledge', toolCallId: 'call_known', result: 'found 1 doc' },
          at: new Date('2026-10-22T10:00:02Z'),
        },
      ]

      const events = [...initialEvents]
      const insertedEvents: any[] = []
      const claimedEffects = new Set<string>()

      const makeSelect = () => {
        const p: any = Promise.resolve([...events])
        p.from = () => p
        p.where = () => p
        p.orderBy = () => p
        return p
      }

      const mockDb: any = {
        select: makeSelect,
        insert: () => ({
          values: (val: any) => ({
            onConflictDoNothing: () => ({
              returning: () => {
                if (claimedEffects.has(val.key)) return []
                claimedEffects.add(val.key)
                return [{ id: 'eff-1' }]
              },
            }),
          }),
        }),
        query: {
          agentRunInterrupts: {
            findMany: () => Promise.resolve([]),
          },
        },
        execute: async () => {
          const seq = events.length + 1
          const row = {
            id: `ev-${seq}`,
            runId: 'run-1',
            tenantId: 'tenant-1',
            seq,
            type: 'tool.end',
            data: {
              name: 'send_webhook',
              toolCallId: 'call_crashed',
              outcome: 'unknown',
              isError: false,
              result:
                'The tool call started but the process stopped before completion was recorded. Outcome is unknown.',
            },
            at: new Date(),
          }
          events.push(row)
          insertedEvents.push(row)
          return [row]
        },
      }

      const reconciled = await reconcileToolEvents(mockDb, 'tenant-1', 'run-1', {
        forceSettled: true,
      })

      // Sibling call_known is success
      expect(reconciled.get('call_known')).toMatchObject({
        toolCallId: 'call_known',
        outcome: 'success',
        text: 'found 1 doc',
        isError: false,
      })

      // Crashed call_crashed is unknown
      expect(reconciled.get('call_crashed')).toMatchObject({
        toolCallId: 'call_crashed',
        outcome: 'unknown',
        isError: false,
      })

      // A durable tool.end event was persisted for call_crashed
      expect(insertedEvents).toHaveLength(1)
      expect(insertedEvents[0].data).toMatchObject({
        name: 'send_webhook',
        toolCallId: 'call_crashed',
        outcome: 'unknown',
      })
    })

    it('does not mark tool unknown when it is pending human approval', async () => {
      const { reconcileToolEvents } = await import('@/api/services/agents/runs')

      const events = [
        {
          id: 'ev-1',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 1,
          type: 'tool.start',
          data: { name: 'index_finding', toolCallId: 'call_pending', input: { text: 'draft' } },
          at: new Date('2026-10-22T10:00:00Z'),
        },
      ]

      const insertedEvents: any[] = []

      const makeSelect = () => {
        const p: any = Promise.resolve([...events])
        p.from = () => p
        p.where = () => p
        p.orderBy = () => p
        return p
      }

      const mockDb: any = {
        select: makeSelect,
        query: {
          agentRunInterrupts: {
            findMany: () =>
              Promise.resolve([
                {
                  id: 'int-1',
                  runId: 'run-1',
                  tenantId: 'tenant-1',
                  key: 'tool:call_pending',
                  toolCallId: 'call_pending',
                  status: 'pending',
                },
              ]),
          },
        },
        execute: async () => {
          throw new Error('should not insert event for pending approval')
        },
      }

      const reconciled = await reconcileToolEvents(mockDb, 'tenant-1', 'run-1', {
        forceSettled: true,
      })

      // Call is not in reconciled map and no tool.end event was inserted
      expect(reconciled.has('call_pending')).toBe(false)
      expect(insertedEvents).toHaveLength(0)
    })

    it('under forceSettled, does not mark rejected/cancelled or expired approval as unknown', async () => {
      const { reconcileToolEvents } = await import('@/api/services/agents/runs')

      const events = [
        {
          id: 'ev-1',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 1,
          type: 'tool.start',
          data: { name: 'delete_resource', toolCallId: 'call_declined' },
          at: new Date('2026-10-22T10:00:00Z'),
        },
        {
          id: 'ev-2',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 2,
          type: 'tool.start',
          data: { name: 'modify_resource', toolCallId: 'call_expired' },
          at: new Date('2026-10-22T10:00:01Z'),
        },
      ]

      const insertedEvents: any[] = []

      const makeSelect = () => {
        const p: any = Promise.resolve([...events])
        p.from = () => p
        p.where = () => p
        p.orderBy = () => p
        return p
      }

      const mockDb: any = {
        select: makeSelect,
        query: {
          agentRunInterrupts: {
            findMany: () =>
              Promise.resolve([
                {
                  id: 'int-declined',
                  runId: 'run-1',
                  tenantId: 'tenant-1',
                  key: 'tool:call_declined',
                  toolCallId: 'call_declined',
                  status: 'cancelled',
                },
                {
                  id: 'int-expired',
                  runId: 'run-1',
                  tenantId: 'tenant-1',
                  key: 'tool:call_expired',
                  toolCallId: 'call_expired',
                  status: 'expired',
                },
              ]),
          },
        },
        execute: async () => {
          throw new Error('should not insert event for rejected or expired approvals')
        },
      }

      const reconciled = await reconcileToolEvents(mockDb, 'tenant-1', 'run-1', {
        forceSettled: true,
      })

      // Explicitly rejected or expired approvals must NOT be classified as unknown
      expect(reconciled.has('call_declined')).toBe(false)
      expect(reconciled.has('call_expired')).toBe(false)
      expect(insertedEvents).toHaveLength(0)
    })

    it('is idempotent across repeated and concurrent reconciliation calls (no duplicate tool.end events)', async () => {
      const { reconcileToolEvents } = await import('@/api/services/agents/runs')

      const events: any[] = [
        {
          id: 'ev-1',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 1,
          type: 'tool.start',
          data: { name: 'external_payment', toolCallId: 'call_concurrent_test' },
          at: new Date('2026-10-22T10:00:00Z'),
        },
      ]

      const insertedEvents: any[] = []
      const claimedEffects = new Set<string>()

      const makeSelect = () => {
        const p: any = Promise.resolve([...events])
        p.from = () => p
        p.where = () => p
        p.orderBy = () => p
        return p
      }

      const mockDb: any = {
        select: makeSelect,
        insert: () => ({
          values: (val: any) => ({
            onConflictDoNothing: () => ({
              returning: () => {
                if (claimedEffects.has(val.key)) return []
                claimedEffects.add(val.key)
                return [{ id: 'eff-' + val.key }]
              },
            }),
          }),
        }),
        query: {
          agentRunInterrupts: {
            findMany: () => Promise.resolve([]),
          },
        },
        execute: async () => {
          const seq = events.length + 1
          const row = {
            id: `ev-${seq}`,
            runId: 'run-1',
            tenantId: 'tenant-1',
            seq,
            type: 'tool.end',
            data: {
              name: 'external_payment',
              toolCallId: 'call_concurrent_test',
              outcome: 'unknown',
              isError: false,
              result: 'Outcome is unknown.',
            },
            at: new Date(),
          }
          events.push(row)
          insertedEvents.push(row)
          return [row]
        },
      }

      // Simulate concurrent calls to reconcileToolEvents
      const [res1, res2] = await Promise.all([
        reconcileToolEvents(mockDb, 'tenant-1', 'run-1', { forceSettled: true }),
        reconcileToolEvents(mockDb, 'tenant-1', 'run-1', { forceSettled: true }),
      ])

      // Sequential follow-up call
      const res3 = await reconcileToolEvents(mockDb, 'tenant-1', 'run-1', { forceSettled: true })

      // Exactly ONE tool.end event was persisted
      expect(insertedEvents).toHaveLength(1)
      expect(res1.get('call_concurrent_test')?.outcome).toBe('unknown')
      expect(res2.get('call_concurrent_test')?.outcome).toBe('unknown')
      expect(res3.get('call_concurrent_test')?.outcome).toBe('unknown')
    })

    it('does not cross-pair concurrent calls to the same tool name', async () => {
      const { reconcileToolEvents } = await import('@/api/services/agents/runs')

      // Two concurrent calls to 'search_knowledge' in the same turn:
      // call_A completed, call_B crashed
      const events: any[] = [
        {
          id: 'ev-1',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 1,
          type: 'tool.start',
          data: { name: 'search_knowledge', toolCallId: 'call_A', input: { q: 'A' } },
          at: new Date('2026-10-22T10:00:00Z'),
        },
        {
          id: 'ev-2',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 2,
          type: 'tool.start',
          data: { name: 'search_knowledge', toolCallId: 'call_B', input: { q: 'B' } },
          at: new Date('2026-10-22T10:00:01Z'),
        },
        {
          id: 'ev-3',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 3,
          type: 'tool.end',
          data: { name: 'search_knowledge', toolCallId: 'call_A', result: 'found A' },
          at: new Date('2026-10-22T10:00:02Z'),
        },
      ]

      const insertedEvents: any[] = []
      const claimedEffects = new Set<string>()

      const makeSelect = () => {
        const p: any = Promise.resolve([...events])
        p.from = () => p
        p.where = () => p
        p.orderBy = () => p
        return p
      }

      const mockDb: any = {
        select: makeSelect,
        insert: () => ({
          values: (val: any) => ({
            onConflictDoNothing: () => ({
              returning: () => {
                if (claimedEffects.has(val.key)) return []
                claimedEffects.add(val.key)
                return [{ id: 'eff-1' }]
              },
            }),
          }),
        }),
        query: {
          agentRunInterrupts: {
            findMany: () => Promise.resolve([]),
          },
        },
        execute: async () => {
          const seq = events.length + 1
          const row = {
            id: `ev-${seq}`,
            runId: 'run-1',
            tenantId: 'tenant-1',
            seq,
            type: 'tool.end',
            data: {
              name: 'search_knowledge',
              toolCallId: 'call_B',
              outcome: 'unknown',
              isError: false,
              result: 'Outcome is unknown.',
            },
            at: new Date(),
          }
          events.push(row)
          insertedEvents.push(row)
          return [row]
        },
      }

      const reconciled = await reconcileToolEvents(mockDb, 'tenant-1', 'run-1', {
        forceSettled: true,
      })

      // call_A is success (not overwritten or confused with call_B)
      expect(reconciled.get('call_A')).toMatchObject({
        toolCallId: 'call_A',
        outcome: 'success',
        text: 'found A',
      })

      // call_B is unknown
      expect(reconciled.get('call_B')).toMatchObject({
        toolCallId: 'call_B',
        outcome: 'unknown',
      })

      // Only call_B received an appended tool.end
      expect(insertedEvents).toHaveLength(1)
      expect(insertedEvents[0].data.toolCallId).toBe('call_B')
    })

    it('reconciles approved tool call as success when effect was recorded under tool:${toolCallId}', async () => {
      const { reconcileToolEvents } = await import('@/api/services/agents/runs')

      const events: any[] = [
        {
          id: 'ev-1',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 1,
          type: 'tool.start',
          data: { name: 'save_record', toolCallId: 'call_appr_1', input: { id: 123 } },
          at: new Date('2026-10-22T10:00:00Z'),
        },
      ]

      const insertedEvents: any[] = []
      const claimedEffects = new Set<string>()

      const makeSelect = (arg?: any) => {
        const isEffectQuery = Boolean(arg && typeof arg === 'object' && 'result' in arg)
        const p: any = Promise.resolve(
          isEffectQuery ? [{ result: { recordId: 123, saved: true } }] : [...events]
        )
        p.from = () => p
        p.where = () => p
        p.orderBy = () => p
        return p
      }

      const mockDb: any = {
        select: makeSelect,
        insert: () => ({
          values: (val: any) => ({
            onConflictDoNothing: () => ({
              returning: () => {
                if (claimedEffects.has(val.key)) return []
                claimedEffects.add(val.key)
                return [{ id: 'eff-1' }]
              },
            }),
          }),
        }),
        query: {
          agentRunInterrupts: {
            findMany: () =>
              Promise.resolve([
                {
                  id: 'int-appr-1',
                  runId: 'run-1',
                  tenantId: 'tenant-1',
                  key: 'tool:call_appr_1',
                  toolCallId: 'call_appr_1',
                  status: 'resolved',
                },
              ]),
          },
        },
        execute: async () => {
          const seq = events.length + 1
          const row = {
            id: `ev-${seq}`,
            runId: 'run-1',
            tenantId: 'tenant-1',
            seq,
            type: 'tool.end',
            data: {
              name: 'save_record',
              toolCallId: 'call_appr_1',
              outcome: 'success',
              isError: false,
              result: { recordId: 123, saved: true },
            },
            at: new Date(),
          }
          events.push(row)
          insertedEvents.push(row)
          return [row]
        },
      }

      const reconciled = await reconcileToolEvents(mockDb, 'tenant-1', 'run-1', {
        forceSettled: true,
      })

      expect(reconciled.get('call_appr_1')).toMatchObject({
        toolCallId: 'call_appr_1',
        outcome: 'success',
        text: '{"recordId":123,"saved":true}',
        isError: false,
      })
      expect(insertedEvents).toHaveLength(1)
      expect(insertedEvents[0].data.outcome).toBe('success')
    })

    it('reconciles approved tool call as success when effect was recorded under tool:${resolvedInterruptId}', async () => {
      const { reconcileToolEvents } = await import('@/api/services/agents/runs')

      const events: any[] = [
        {
          id: 'ev-1',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 1,
          type: 'tool.start',
          data: { name: 'save_record', toolCallId: 'call_appr_2', input: { id: 456 } },
          at: new Date('2026-10-22T10:00:00Z'),
        },
      ]

      const insertedEvents: any[] = []
      const claimedEffects = new Set<string>()

      const makeSelect = (arg?: any) => {
        const isEffectQuery = Boolean(arg && typeof arg === 'object' && 'result' in arg)
        const p: any = Promise.resolve(
          isEffectQuery ? [{ result: { recordId: 456, saved: true } }] : [...events]
        )
        p.from = () => p
        p.where = () => p
        p.orderBy = () => p
        return p
      }

      const mockDb: any = {
        select: makeSelect,
        insert: () => ({
          values: (val: any) => ({
            onConflictDoNothing: () => ({
              returning: () => {
                if (claimedEffects.has(val.key)) return []
                claimedEffects.add(val.key)
                return [{ id: 'eff-1' }]
              },
            }),
          }),
        }),
        query: {
          agentRunInterrupts: {
            findMany: () =>
              Promise.resolve([
                {
                  id: 'int-uuid-456',
                  runId: 'run-1',
                  tenantId: 'tenant-1',
                  key: 'tool:call_appr_2',
                  toolCallId: 'call_appr_2',
                  status: 'resolved',
                },
              ]),
          },
        },
        execute: async () => {
          const seq = events.length + 1
          const row = {
            id: `ev-${seq}`,
            runId: 'run-1',
            tenantId: 'tenant-1',
            seq,
            type: 'tool.end',
            data: {
              name: 'save_record',
              toolCallId: 'call_appr_2',
              outcome: 'success',
              isError: false,
              result: { recordId: 456, saved: true },
            },
            at: new Date(),
          }
          events.push(row)
          insertedEvents.push(row)
          return [row]
        },
      }

      const reconciled = await reconcileToolEvents(mockDb, 'tenant-1', 'run-1', {
        forceSettled: true,
      })

      expect(reconciled.get('call_appr_2')).toMatchObject({
        toolCallId: 'call_appr_2',
        outcome: 'success',
        text: '{"recordId":456,"saved":true}',
        isError: false,
      })
      expect(insertedEvents).toHaveLength(1)
      expect(insertedEvents[0].data.outcome).toBe('success')
    })

    it('leaves approved tool call to run on active resume when effect has not been recorded yet', async () => {
      const { reconcileToolEvents } = await import('@/api/services/agents/runs')

      const events: any[] = [
        {
          id: 'ev-1',
          runId: 'run-1',
          tenantId: 'tenant-1',
          seq: 1,
          type: 'tool.start',
          data: { name: 'charge_card', toolCallId: 'call_pending_run', input: { amount: 50 } },
          at: new Date('2026-10-22T10:00:00Z'),
        },
      ]

      const insertedEvents: any[] = []

      const makeSelect = (arg?: any) => {
        const isEffectQuery = Boolean(arg && typeof arg === 'object' && 'result' in arg)
        const p: any = Promise.resolve(isEffectQuery ? [] : [...events])
        p.from = () => p
        p.where = () => p
        p.orderBy = () => p
        return p
      }

      const mockDb: any = {
        select: makeSelect,
        insert: () => {
          throw new Error('should not insert event')
        },
        query: {
          agentRunInterrupts: {
            findMany: () =>
              Promise.resolve([
                {
                  id: 'int-charge-1',
                  runId: 'run-1',
                  tenantId: 'tenant-1',
                  key: 'tool:call_pending_run',
                  toolCallId: 'call_pending_run',
                  status: 'resolved',
                },
              ]),
          },
        },
        execute: async () => {
          throw new Error('should not execute insert event')
        },
      }

      // Active run resumption (not forceSettled)
      const reconciled = await reconcileToolEvents(mockDb, 'tenant-1', 'run-1', {
        forceSettled: false,
      })

      // Must NOT be marked unknown; leave it to run
      expect(reconciled.has('call_pending_run')).toBe(false)
      expect(insertedEvents).toHaveLength(0)
    })
  })

  describe('schema and runtime validation', () => {
    it('strict outcome schema validation accepts only valid enum outcomes', () => {
      // Valid enum values
      expect(
        agentToolEndEventDataSchema.safeParse({ name: 'test', outcome: 'success' }).success
      ).toBe(true)
      expect(
        agentToolEndEventDataSchema.safeParse({ name: 'test', outcome: 'error' }).success
      ).toBe(true)
      expect(
        agentToolEndEventDataSchema.safeParse({ name: 'test', outcome: 'unknown' }).success
      ).toBe(true)
      expect(agentToolEndEventDataSchema.safeParse({ name: 'test' }).success).toBe(true)

      // Invalid outcome strings or types are rejected
      expect(
        agentToolEndEventDataSchema.safeParse({ name: 'test', outcome: 'invalid_outcome' }).success
      ).toBe(false)
      expect(agentToolEndEventDataSchema.safeParse({ name: 'test', outcome: 123 }).success).toBe(
        false
      )
      expect(agentToolEndEventDataSchema.safeParse({ name: 'test', outcome: true }).success).toBe(
        false
      )
    })

    it('shared runtime suppresses duplicate tool events across agents', async () => {
      const emittedEvents: any[] = []
      const rawEmit = async (event: any) => {
        emittedEvents.push(event)
      }

      const reconciledTools = new Map([
        [
          'call_reconciled',
          {
            toolCallId: 'call_reconciled',
            name: 'test_tool',
            outcome: 'unknown' as const,
            text: 'Outcome is unknown',
            isError: false,
          },
        ],
      ])

      // Emulate shared runtime emit wrapper from runtime.ts
      const sharedEmit = async (event: any): Promise<void> => {
        if (
          (event.type === 'tool.start' || event.type === 'tool.end') &&
          event.data &&
          typeof event.data.toolCallId === 'string' &&
          reconciledTools.has(event.data.toolCallId)
        ) {
          return
        }
        return rawEmit(event)
      }

      // Reconciled tool start/end should be suppressed
      await sharedEmit({
        type: 'tool.start',
        data: { name: 'test_tool', toolCallId: 'call_reconciled' },
      })
      await sharedEmit({
        type: 'tool.end',
        data: { name: 'test_tool', toolCallId: 'call_reconciled', result: 'foo' },
      })

      // Unrelated events and new tool calls pass through
      await sharedEmit({
        type: 'text',
        data: { text: 'Hello' },
      })
      await sharedEmit({
        type: 'tool.start',
        data: { name: 'new_tool', toolCallId: 'call_new' },
      })
      await sharedEmit({
        type: 'tool.end',
        data: { name: 'new_tool', toolCallId: 'call_new', result: 'done' },
      })

      expect(emittedEvents).toHaveLength(3)
      expect(emittedEvents.map(e => e.type)).toEqual(['text', 'tool.start', 'tool.end'])
      expect(emittedEvents[1].data.toolCallId).toBe('call_new')
      expect(emittedEvents[2].data.toolCallId).toBe('call_new')
    })
  })
})

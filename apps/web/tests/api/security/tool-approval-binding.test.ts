/**
 * An approval authorises the call the approver was shown: that tool, with those arguments, once.
 * A second call in the turn that shares the approved id does not run on it.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  approvalsForRun,
  listInterrupts,
  requestInterrupt,
  resolveInterrupt,
} from '@/api/services/agents/interrupts'
import { runOnce } from '@/api/services/agents/runs'
import { InterruptRequested, runToolLoop, type Tool } from '@/api/services/ai/agent-loop'
import { agentRuns } from '@/db/schema'
import { FakeChatClient } from '../../helpers/ai'
import { createTestTenantWithUser } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { FIXTURE_AGENT } from '../../helpers/fixture-agents'

const db = setupTestDatabase()

async function parked(second: { text: string; extra?: number }) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const [run] = await db
    .insert(agentRuns)
    .values({
      tenantId: tenant.id,
      agentKey: FIXTURE_AGENT,
      status: 'running',
      input: { topic: 'x' },
      requestedByUserId: user.id,
    })
    .returning()
  if (!run) throw new Error('fixture insert failed')
  const handler = vi.fn(async (input: { text: string }) => `saved ${input.text}`)
  const tool: Tool<{ text: string }> = {
    name: 'gated_write',
    description: 'a gated write',
    schema: z.object({ text: z.string() }),
    handler,
    requiresApproval: true,
  }
  const client = new FakeChatClient([
    {
      toolUses: [
        { id: 'same_id', name: 'gated_write', input: { text: 'SHOWN' } },
        { id: 'same_id', name: 'gated_write', input: second },
      ],
    },
    { text: 'done' },
  ])
  let checkpoint: unknown
  const base = {
    model: 'm',
    system: 's',
    messages: [{ role: 'user' as const, content: 'go' }],
    tools: [tool as Tool],
    onCheckpoint: (cp: unknown) => {
      checkpoint = cp
    },
  }
  const raised = await runToolLoop(client, base as never).catch(err => err)
  expect(raised).toBeInstanceOf(InterruptRequested)
  for (const r of (raised as InterruptRequested).requests) {
    await requestInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      key: r.key,
      spec: r.spec,
      toolCallId: r.toolCallId ?? null,
    })
  }
  const [ask] = await listInterrupts(db, tenant.id, run.id)
  if (!ask) throw new Error('no ask')
  await resolveInterrupt(db, {
    tenantId: tenant.id,
    runId: run.id,
    interruptId: ask.id,
    status: 'resolved',
    resolvedByUserId: user.id,
  })
  const result = await runToolLoop(client, {
    ...base,
    resume: checkpoint,
    approvals: await approvalsForRun(db, tenant.id, run.id),
    runApproved: (key: string, fn: () => Promise<{ text: string; isError: boolean }>) =>
      runOnce(db, tenant.id, run.id, key, fn),
  } as never)
  return { handler, result, client }
}

function toolResults(client: FakeChatClient) {
  type Block = { type: string; isError?: boolean }
  const blocks = (client.calls.at(-1)?.messages ?? []).flatMap(m =>
    Array.isArray(m.content) ? (m.content as Block[]) : []
  )
  return blocks.filter(b => b.type === 'tool_result')
}

describe('an approval and the calls that share its id', () => {
  it('runs only the arguments the approver was shown', async () => {
    const { handler, client } = await parked({ text: 'NOT-SHOWN' })
    expect(handler.mock.calls.map(c => c[0].text)).toEqual(['SHOWN'])
    expect(toolResults(client).map(b => b.isError)).toEqual([false, true])
  })

  it('runs an identical second call at most once', async () => {
    const { handler, client } = await parked({ text: 'SHOWN' })
    expect(handler).toHaveBeenCalledOnce()
    expect(toolResults(client).map(b => b.isError)).toEqual([false, true])
  })
})

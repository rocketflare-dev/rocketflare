// @vitest-isolate
// Mocks `@/api/services/ai/resolve` and swaps an entry of the `AGENTS` registry, so this file
// needs its own module registry.
/**
 * The runtime half of human-in-the-loop (issue #17), against the real database: `ctx.interrupt`,
 * `executeRun`'s park and decline arms, steering delivery, artifacts, and the two lifecycle
 * transitions a park needs — `parkRun` / `resumeRun` — plus the restart fallback for a park whose
 * Workflow instance is gone.
 *
 * The properties these exist to protect, in the order they would hurt:
 *
 * - **A park is not a settle (T7)**: `finished_at` stays NULL and **the checkpoint survives**, or
 *   the resumed attempt re-pays for every turn the first one already bought.
 * - **A re-entered `execute` finds its own earlier ask (T2)**, because it re-enters `run()` from
 *   the top. Without `UNIQUE (run_id, key)` that is a new question every round, forever.
 * - **`sendEvent → not_found` is an ANSWER (T4/T5)**: the run gets a new instance `<runId>-r1`,
 *   which works only because the caller flipped the row to `running` first.
 * - **Rows before the park**: a row with no parked run re-asks on the next attempt; a parked run
 *   with no row hangs with nothing for anybody to answer.
 */
import type { AgentInterruptSpec } from '@rocketflare/shared/ai/interrupts'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { listArtifacts } from '@/api/services/agents/artifacts'
import {
  approvalsForRun,
  expireInterrupts,
  interruptExpiryFrom,
  listInterrupts,
  parseDurationMs,
  requestInterrupt,
  resolveInterrupt,
} from '@/api/services/agents/interrupts'
import { AGENTS, type AgentContext, type AnyAgentDefinition } from '@/api/services/agents/registry'
import {
  appendEventAtomic,
  claimEffect,
  claimRun,
  enqueueRun,
  expireParkedRun,
  getRun,
  listEvents,
  nextInstanceId,
  nudgeOrRestartInstance,
  parkRun,
  reconcileRun,
  requestCancel,
  resumeRun,
} from '@/api/services/agents/runs'
import { executeRun, isRetryableRunError } from '@/api/services/agents/runtime'
import { AiError } from '@/api/services/ai/errors'
import { InterruptDeclinedError, InterruptRequested, type Tool } from '@/api/services/ai/kit'
import type { ChatClient } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { agentRuns, notifications } from '@/db/schema'
import { FakeChatClient } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const state: { client: ChatClient | null } = { client: null }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => ({
      client: state.client ?? new FakeChatClient([], 'anthropic_compatible'),
      provider: 'anthropic_compatible',
      model: 'fake-model',
      source: 'tenant',
      maxOutputTokens: 2048,
    })),
  }
})

const db = setupTestDatabase()

/** `stubs(env).workflow` is optional (a test may drop the binding); here it is always present. */
function workflowStub(env: TestEnv) {
  const workflow = stubs(env).workflow
  if (!workflow) throw new Error('expected the AGENT_RUN_WORKFLOW stub')
  return workflow
}

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

const original = AGENTS['summarize-text']

/**
 * Swap `summarize-text`'s definition for the run under test. The kit's own agents do not use
 * interrupts until phase 8, and the registry is keyed by `AgentKey`, so there is no third key to
 * borrow — the swap is undone after every test and the file is `@vitest-isolate` for it.
 */
function installAgent(
  run: (ctx: AgentContext) => Promise<unknown>,
  meta: Partial<AnyAgentDefinition['meta']> = {}
): void {
  AGENTS['summarize-text'] = {
    meta: {
      ...original.meta,
      inputSchema: z.any(),
      outputSchema: z.any(),
      ...meta,
    },
    run,
  } as AnyAgentDefinition
}

afterEach(() => {
  AGENTS['summarize-text'] = original
  state.client = null
})

const APPROVAL: AgentInterruptSpec = { kind: 'approval', message: 'Send this email?' }
const CHOICE: AgentInterruptSpec = {
  kind: 'choice',
  message: 'Which customer?',
  options: [
    { value: 'a', label: 'Acme' },
    { value: 'b', label: 'Beta' },
  ],
  allowOther: false,
}

const CHECKPOINT = {
  messages: [{ role: 'user' as const, content: 'seed' }],
  turns: 1,
  usage: { inputTokens: 10, outputTokens: 5 },
}

async function claimedRun(env: TestEnv, role: 'owner' | 'member' = 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  const { run } = await enqueueRun(db, env, {
    tenantId: tenant.id,
    agentKey: 'summarize-text',
    input: { text: 'anything' },
    userId: user.id,
  })
  await claimRun(db, tenant.id, run.id)
  return { run, user, tenant }
}

function execute(env: TestEnv, runId: string, tenantId: string) {
  return executeRun(db, loadConfig(env), env, fakeLogger(), { runId, tenantId })
}

describe('ctx.interrupt parks the run', () => {
  it('writes the ask, parks WITHOUT settling, and keeps the checkpoint', async () => {
    const env = createTestEnv()
    installAgent(async ctx => {
      await ctx.checkpoint.save(CHECKPOINT)
      await ctx.interrupt({ key: 'confirm-send', spec: APPROVAL })
      return { never: true }
    })
    const { run, tenant, user } = await claimedRun(env)

    const outcome = await execute(env, run.id, tenant.id)

    expect(outcome.status).toBe('awaiting_input')
    expect(outcome.interruptIds).toHaveLength(1)

    const row = await getRun(db, tenant.id, run.id)
    expect(row?.status).toBe('awaiting_input')
    // T7: a park is not a settle. Both of these are what make the resume cheap and possible.
    expect(row?.finishedAt).toBeNull()
    expect(row?.checkpoint).toMatchObject({ turns: 1 })

    const [interrupt] = await listInterrupts(db, tenant.id, run.id)
    expect(interrupt).toMatchObject({
      key: 'confirm-send',
      kind: 'approval',
      // `aguiReasonFor` with no tool call: a confirmation, not a `tool_call`.
      reason: 'confirmation',
      status: 'pending',
      message: 'Send this email?',
    })
    expect(interrupt?.responseSchema).toMatchObject({ type: 'object' })
    expect(interrupt?.expiresAt).toBeInstanceOf(Date)

    const events = await listEvents(db, tenant.id, run.id)
    expect(events.map(e => e.type)).toEqual(['interrupt', 'status'])
    expect(events[1]?.data).toMatchObject({ status: 'awaiting_input' })

    // The requester is told, and told once.
    const bell = await db.select().from(notifications).where(eq(notifications.userId, user.id))
    expect(bell).toHaveLength(1)
    expect(bell[0]).toMatchObject({ type: 'agent_run_awaiting_input' })
    expect(bell[0]?.data).toMatchObject({ runId: run.id, interruptId: interrupt?.id })
    expect(stubs(env).hub.broadcasts.length).toBeGreaterThan(0)
  })

  it('T2: a re-entered execute finds its own earlier ask rather than creating a second', async () => {
    const env = createTestEnv()
    let calls = 0
    installAgent(async ctx => {
      calls += 1
      await ctx.interrupt({ key: 'confirm-send', spec: APPROVAL })
      return { never: true }
    })
    const { run, tenant, user } = await claimedRun(env)

    await execute(env, run.id, tenant.id)
    // A step retry / restarted instance re-claims the row and enters `run()` from the top again.
    await resumeRun(db, tenant.id, run.id)
    const second = await execute(env, run.id, tenant.id)

    expect(calls).toBe(2)
    expect(second.status).toBe('awaiting_input')
    const rows = await listInterrupts(db, tenant.id, run.id)
    expect(rows).toHaveLength(1)
    // And nobody was notified twice — `claimEffect('notify:<id>')` is the guard.
    const bell = await db.select().from(notifications).where(eq(notifications.userId, user.id))
    expect(bell).toHaveLength(1)
  })

  it('resumes with the answer and finishes the run', async () => {
    const env = createTestEnv()
    installAgent(async ctx => {
      const answer = await ctx.interrupt({ key: 'which', spec: CHOICE })
      return { chose: answer.payload, status: answer.status }
    })
    const { run, tenant, user } = await claimedRun(env)
    await execute(env, run.id, tenant.id)

    const [pending] = await listInterrupts(db, tenant.id, run.id, 'pending')
    const resolved = await resolveInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      interruptId: pending?.id ?? '',
      status: 'resolved',
      payload: { value: 'b' },
      resolvedByUserId: user.id,
    })
    expect(resolved?.status).toBe('resolved')
    // Answering the same ask twice is a no-op: the compare-and-set is on `pending`.
    expect(
      await resolveInterrupt(db, {
        tenantId: tenant.id,
        runId: run.id,
        interruptId: pending?.id ?? '',
        status: 'resolved',
        payload: { value: 'a' },
        resolvedByUserId: user.id,
      })
    ).toBeNull()

    // The answer IS the transition (decision 2) — the route flips the row before it nudges.
    expect((await resumeRun(db, tenant.id, run.id))?.status).toBe('running')
    const outcome = await execute(env, run.id, tenant.id)

    expect(outcome.status).toBe('succeeded')
    const row = await getRun(db, tenant.id, run.id)
    expect(row?.output).toEqual({ chose: { value: 'b' }, status: 'resolved' })
    // A settled run drops its checkpoint.
    expect(row?.checkpoint).toBeNull()
  })

  it('a declined approval cancels the run with a NULL error and a reason on the event', async () => {
    const env = createTestEnv()
    installAgent(async ctx => {
      await ctx.interrupt({ key: 'confirm-send', spec: APPROVAL })
      return { never: true }
    })
    const { run, tenant, user } = await claimedRun(env)
    await execute(env, run.id, tenant.id)

    const [pending] = await listInterrupts(db, tenant.id, run.id, 'pending')
    await resolveInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      interruptId: pending?.id ?? '',
      status: 'cancelled',
      payload: { note: 'wrong recipient' },
      resolvedByUserId: user.id,
    })
    await resumeRun(db, tenant.id, run.id)
    const outcome = await execute(env, run.id, tenant.id)

    expect(outcome.status).toBe('cancelled')
    const row = await getRun(db, tenant.id, run.id)
    // A refusal is a STATUS, not a message.
    expect(row).toMatchObject({ status: 'cancelled', error: null })
    const last = (await listEvents(db, tenant.id, run.id)).at(-1)
    expect(last?.data).toMatchObject({ status: 'cancelled', reason: 'rejected' })
  })

  it('a declined CHOICE comes back as an answer instead, because declining to answer is one', async () => {
    const env = createTestEnv()
    installAgent(async ctx => {
      const answer = await ctx.interrupt({ key: 'which', spec: CHOICE })
      return { status: answer.status }
    })
    const { run, tenant, user } = await claimedRun(env)
    await execute(env, run.id, tenant.id)
    const [pending] = await listInterrupts(db, tenant.id, run.id, 'pending')
    await resolveInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      interruptId: pending?.id ?? '',
      status: 'cancelled',
      resolvedByUserId: user.id,
    })
    await resumeRun(db, tenant.id, run.id)

    const outcome = await execute(env, run.id, tenant.id)
    expect(outcome.status).toBe('succeeded')
    expect((await getRun(db, tenant.id, run.id))?.output).toEqual({ status: 'cancelled' })
  })

  it('notifies the tenant admins for a system run and for approvers: admin', async () => {
    const env = createTestEnv()
    installAgent(
      async ctx => {
        await ctx.interrupt({ key: 'confirm-send', spec: APPROVAL })
        return {}
      },
      { approvers: 'admin' }
    )
    const { run, tenant, user } = await claimedRun(env, 'owner')
    await execute(env, run.id, tenant.id)
    const bell = await db.select().from(notifications).where(eq(notifications.userId, user.id))
    expect(bell).toHaveLength(1)
  })
})

describe('T3: an interrupt raised inside a tool handler parks the run', () => {
  it('is not swallowed into an isError result', async () => {
    const env = createTestEnv()
    state.client = new FakeChatClient(
      [{ toolUses: [{ id: 'call_1', name: 'pick', input: { hint: 'acme' } }] }],
      'anthropic_compatible'
    )
    const pick: Tool<{ hint: string }> = {
      name: 'pick',
      description: 'Pick a customer',
      schema: z.object({ hint: z.string() }),
      handler: async () => 'unreachable',
    }
    installAgent(async ctx => {
      const asking: Tool<{ hint: string }> = {
        ...pick,
        handler: async () => {
          await ctx.interrupt({ key: 'which-customer', spec: CHOICE })
          return 'answered'
        },
      }
      const { runToolLoop } = await import('@/api/services/ai/kit')
      await runToolLoop(ctx.chat.client, {
        model: ctx.chat.model,
        system: 'pick one',
        messages: [{ role: 'user', content: 'go' }],
        tools: [asking],
        maxTurns: 2,
        onCheckpoint: ctx.checkpoint.save,
      })
      return {}
    })
    const { run, tenant } = await claimedRun(env)

    const outcome = await execute(env, run.id, tenant.id)

    expect(outcome.status).toBe('awaiting_input')
    const [row] = await listInterrupts(db, tenant.id, run.id)
    expect(row).toMatchObject({ key: 'which-customer', kind: 'choice', reason: 'input_required' })
  })
})

describe('steering and artifacts', () => {
  it('a note is delivered exactly once across two attempts', async () => {
    const env = createTestEnv()
    const seen: string[][] = []
    // The attempt boundary that matters is a park and its resume: `run()` is re-entered from the
    // top, and a note the model has already been given must not arrive a second time.
    installAgent(async ctx => {
      seen.push((await ctx.steering()).map(note => note.text))
      await ctx.interrupt({ key: 'pause', spec: CHOICE })
      return {}
    })
    const { run, tenant, user } = await claimedRun(env)
    await appendEventAtomic(db, {
      tenantId: tenant.id,
      runId: run.id,
      type: 'steering',
      data: { text: 'focus on Q3', authorUserId: user.id },
    })

    await execute(env, run.id, tenant.id)
    const [pending] = await listInterrupts(db, tenant.id, run.id, 'pending')
    await resolveInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      interruptId: pending?.id ?? '',
      status: 'resolved',
      payload: { value: 'a' },
      resolvedByUserId: user.id,
    })
    await resumeRun(db, tenant.id, run.id)
    expect((await execute(env, run.id, tenant.id)).status).toBe('succeeded')

    expect(seen).toEqual([['focus on Q3'], []])
  })

  it('an artifact upserts under its key and leaves one thin event per write', async () => {
    const env = createTestEnv()
    installAgent(async ctx => {
      await ctx.artifact({
        key: 'draft',
        title: 'First',
        data: { kind: 'markdown', markdown: 'v1' },
      })
      await ctx.artifact({
        key: 'draft',
        title: 'Redraft',
        data: { kind: 'markdown', markdown: 'v2' },
      })
      return {}
    })
    const { run, tenant } = await claimedRun(env)
    await execute(env, run.id, tenant.id)

    const artifacts = await listArtifacts(db, tenant.id, run.id)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ key: 'draft', title: 'Redraft', kind: 'markdown' })
    const events = await listEvents(db, tenant.id, run.id)
    expect(events.filter(e => e.type === 'artifact')).toHaveLength(2)
    expect(events[0]?.data).toMatchObject({ key: 'draft', kind: 'markdown', title: 'First' })
  })
})

describe('the lifecycle around a park', () => {
  it('parkRun only takes a running row and resumeRun only a parked one', async () => {
    const env = createTestEnv()
    const { run, tenant } = await claimedRun(env)
    expect(await parkRun(db, tenant.id, run.id)).toMatchObject({ status: 'awaiting_input' })
    expect(await parkRun(db, tenant.id, run.id)).toBeNull()
    expect(await resumeRun(db, tenant.id, run.id)).toMatchObject({ status: 'running' })
    expect(await resumeRun(db, tenant.id, run.id)).toBeNull()
  })

  it('a second enqueue while parked deduplicates — the widened exclusive index', async () => {
    const env = createTestEnv()
    const { run, tenant, user } = await claimedRun(env)
    await parkRun(db, tenant.id, run.id)
    const second = await enqueueRun(db, env, {
      tenantId: tenant.id,
      agentKey: 'summarize-text',
      input: { text: 'again' },
      userId: user.id,
    })
    expect(second).toMatchObject({ deduplicated: true })
    expect(second.run.id).toBe(run.id)
  })

  it('cancelling a parked run settles it, expires its asks and wakes the instance', async () => {
    const env = createTestEnv()
    const { run, tenant } = await claimedRun(env)
    await requestInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      key: 'confirm',
      spec: APPROVAL,
    })
    await parkRun(db, tenant.id, run.id)

    const settled = await requestCancel(db, tenant.id, run.id, undefined, env)

    expect(settled).toMatchObject({ status: 'cancelled', error: null })
    expect((await listInterrupts(db, tenant.id, run.id))[0]?.status).toBe('expired')
    // The sleeping instance is woken so it reads the settled row instead of holding its wait.
    expect(workflowStub(env).events).toHaveLength(1)
  })

  it('T6: expireParkedRun settles a park whose asks have all timed out, and leaves the others alone', async () => {
    const env = createTestEnv()
    const { run, tenant } = await claimedRun(env)
    const past = new Date(Date.now() - 60_000)
    const interrupt = await requestInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      key: 'confirm',
      spec: APPROVAL,
      expiresAt: past,
    })
    const parked = await parkRun(db, tenant.id, run.id)
    if (!parked) throw new Error('expected a parked row')

    // A running row is never the read path's to settle.
    expect((await expireParkedRun(db, { ...parked, status: 'running' })).status).toBe('running')
    // Nor is a park still inside its deadline.
    await db.update(agentRuns).set({ status: 'awaiting_input' }).where(eq(agentRuns.id, run.id))
    const future = await requestInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      key: 'later',
      spec: APPROVAL,
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect((await expireParkedRun(db, parked)).status).toBe('awaiting_input')

    await expireInterrupts(db, tenant.id, run.id)
    await db.update(agentRuns).set({ status: 'awaiting_input' }).where(eq(agentRuns.id, run.id))
    await requestInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      key: 'confirm-2',
      spec: APPROVAL,
      expiresAt: past,
    })
    const settled = await expireParkedRun(db, parked)
    expect(settled).toMatchObject({ status: 'cancelled', error: null })
    expect(
      (await listInterrupts(db, tenant.id, run.id)).every(row => row.status === 'expired')
    ).toBe(true)
    expect([interrupt.id, future.id]).toHaveLength(2)
  })

  it('a park with no pending asks is left alone — the window between the answer and the resume', async () => {
    const env = createTestEnv()
    const { run, tenant } = await claimedRun(env)
    const parked = await parkRun(db, tenant.id, run.id)
    if (!parked) throw new Error('expected a parked row')
    expect((await expireParkedRun(db, parked)).status).toBe('awaiting_input')
  })

  it("reconcileRun leaves a 'waiting' instance exactly where it is", async () => {
    const env = createTestEnv()
    const { run, tenant } = await claimedRun(env)
    workflowStub(env).setStatus(run.id, { status: 'waiting' })
    const row = await getRun(db, tenant.id, run.id)
    if (!row) throw new Error('expected a row')
    expect((await reconcileRun(db, env, row)).status).toBe('running')
    // And a parked row is not the runtime's to reconcile at all.
    const parked = await parkRun(db, tenant.id, run.id)
    if (!parked) throw new Error('expected a parked row')
    workflowStub(env).setStatus(run.id, { status: 'errored' })
    expect((await reconcileRun(db, env, parked)).status).toBe('awaiting_input')
  })
})

describe('waking a parked instance', () => {
  it('sends the resume event when the instance is still there', async () => {
    const env = createTestEnv()
    const { run, tenant } = await claimedRun(env)
    const row = await getRun(db, tenant.id, run.id)
    if (!row) throw new Error('expected a row')

    const after = await nudgeOrRestartInstance(db, env, row, { interruptId: 'int-1' })

    expect(after.instanceId).toBe(run.id)
    expect(workflowStub(env).events).toEqual([
      { instanceId: run.id, type: 'agent-resume', payload: { interruptId: 'int-1' } },
    ])
    expect(workflowStub(env).created).toHaveLength(1)
  })

  it('T4/T5: a not_found instance is an ANSWER — a new one is created as <runId>-r1', async () => {
    const env = createTestEnv()
    const { run, tenant } = await claimedRun(env)
    workflowStub(env).notFoundOnSendEvent = true
    const row = await getRun(db, tenant.id, run.id)
    if (!row) throw new Error('expected a row')

    const after = await nudgeOrRestartInstance(db, env, row, { interruptId: 'int-1' })

    expect(after.instanceId).toBe(`${run.id}-r1`)
    expect(workflowStub(env).created.map(c => c.id)).toEqual([run.id, `${run.id}-r1`])
    expect(workflowStub(env).created[1]?.params).toEqual({ runId: run.id, tenantId: tenant.id })
    // The column stays unique and points at the LATEST instance.
    expect((await getRun(db, tenant.id, run.id))?.instanceId).toBe(`${run.id}-r1`)
  })

  it('numbers restarts with a hyphen, never a colon', () => {
    expect(nextInstanceId('run-1', null)).toBe('run-1-r1')
    expect(nextInstanceId('run-1', 'run-1')).toBe('run-1-r1')
    expect(nextInstanceId('run-1', 'run-1-r1')).toBe('run-1-r2')
    expect(nextInstanceId('run-1', 'run-1-r9')).toBe('run-1-r10')
    expect(nextInstanceId('run-1', 'something-else')).toBe('run-1-r1')
  })
})

describe('the plumbing underneath', () => {
  it('requestInterrupt is create-or-read, never an update', async () => {
    const env = createTestEnv()
    const { run, tenant } = await claimedRun(env)
    const first = await requestInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      key: 'k',
      spec: APPROVAL,
      toolCallId: 'call_1',
    })
    expect(first.reason).toBe('tool_call')
    const again = await requestInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      key: 'k',
      spec: { ...APPROVAL, message: 'a different question' },
    })
    expect(again.id).toBe(first.id)
    expect(again.message).toBe('Send this email?')
  })

  it('approvalsForRun keys settled asks by their tool call, and reads an expiry as a decline', async () => {
    const env = createTestEnv()
    const { run, tenant, user } = await claimedRun(env)
    const approved = await requestInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      key: 'a',
      spec: APPROVAL,
      toolCallId: 'call_a',
    })
    await requestInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      key: 'b',
      spec: APPROVAL,
      toolCallId: 'call_b',
    })
    const pendingOnly = await requestInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      key: 'c',
      spec: APPROVAL,
      toolCallId: 'call_c',
    })
    await resolveInterrupt(db, {
      tenantId: tenant.id,
      runId: run.id,
      interruptId: approved.id,
      status: 'resolved',
      payload: { editedInput: { to: 'edited@example.test' }, note: 'fixed the address' },
      resolvedByUserId: user.id,
    })
    await db.update(agentRuns).set({ status: 'awaiting_input' }).where(eq(agentRuns.id, run.id))

    const approvals = await approvalsForRun(db, tenant.id, run.id)
    expect(approvals.get('call_a')).toEqual({
      interruptId: approved.id,
      status: 'resolved',
      input: { to: 'edited@example.test' },
      note: 'fixed the address',
      onReject: 'cancel_run',
    })
    // A pending ask is not an answer.
    expect(approvals.has('call_c')).toBe(false)
    expect(pendingOnly.status).toBe('pending')
  })

  it('claimEffect answers true exactly once per (run, key)', async () => {
    const env = createTestEnv()
    const { run, tenant } = await claimedRun(env)
    expect(await claimEffect(db, tenant.id, run.id, 'notify:x')).toBe(true)
    expect(await claimEffect(db, tenant.id, run.id, 'notify:x')).toBe(false)
    expect(await claimEffect(db, tenant.id, run.id, 'notify:y')).toBe(true)
  })

  it('appendEventAtomic numbers itself in SQL and continues the run stream', async () => {
    const env = createTestEnv()
    const { run, tenant } = await claimedRun(env)
    const first = await appendEventAtomic(db, {
      tenantId: tenant.id,
      runId: run.id,
      type: 'steering',
      data: { text: 'one', authorUserId: null },
    })
    const second = await appendEventAtomic(db, {
      tenantId: tenant.id,
      runId: run.id,
      type: 'steering',
      data: { text: 'two', authorUserId: null },
    })
    expect([first.seq, second.seq]).toEqual([1, 2])
    expect(first.at).toBeInstanceOf(Date)
    expect((await listEvents(db, tenant.id, run.id)).map(e => e.seq)).toEqual([1, 2])
  })

  it('neither interrupt type is retryable', () => {
    expect(isRetryableRunError(new InterruptRequested([{ key: 'k', spec: APPROVAL }]))).toBe(false)
    expect(isRetryableRunError(new InterruptDeclinedError('int-1'))).toBe(false)
    expect(isRetryableRunError(new AiError('unavailable', 'anthropic', 'down'))).toBe(true)
  })

  it('reads a Workflows duration, and treats one it cannot read as "no deadline"', () => {
    expect(parseDurationMs('168 hours')).toBe(604_800_000)
    expect(parseDurationMs('1 hour')).toBe(3_600_000)
    expect(parseDurationMs('30 minutes')).toBe(1_800_000)
    expect(parseDurationMs('3 days')).toBe(259_200_000)
    expect(parseDurationMs('5000')).toBe(5_000)
    expect(parseDurationMs('a fortnight')).toBeNull()
    expect(interruptExpiryFrom('a fortnight')).toBeNull()
    expect(interruptExpiryFrom('1 hour', new Date(0))?.toISOString()).toBe(
      '1970-01-01T01:00:00.000Z'
    )
  })
})

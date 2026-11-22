// @vitest-fixture-agents
/**
 * The agent runtime, for any agent: `AgentRunWorkflow` driven end to end under Node with a fake
 * `step` (runs callbacks inline, records names/config) and test bindings against the real database,
 * on the fixture agent (`tests/helpers/fixture-agents.ts`) with a body written here — one forced
 * tool call answered by a `FakeChatClient`. claim → execute → finish → events in order → row
 * `succeeded` with the output → `ai_usage` row → nudges → one trace; cancellation between turns →
 * `cancelled`; a non-retryable provider error → `failed` with a redacted sentence; a retryable one
 * rethrows on attempt 1 (the platform retries) and the finish backstop settles the row; a run
 * cancelled while queued is skipped at claim; `runOnce`; each step closes its DB client.
 *
 * Plus the suspend/resume loop: `execute#N` / `resume#N` / `expire#N`, whose step names
 * must be DISTINCT per round — the platform treats a step name as its identity and replays a
 * repeated one's earlier result, which would read as "the agent ignored my approval".
 *
 * The single-call example agent's own behaviour is `agent-run-workflow.test.ts`, which an app may
 * delete with the example; nothing here depends on it.
 */
import { AGENT_RESUME_EVENT, MAX_INTERRUPT_ROUNDS } from '@rocketflare/shared/ai/agents'
import type { AgentInterruptSpec } from '@rocketflare/shared/ai/interrupts'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { rootSpanIdForRun, traceIdForRun } from '@/api/observability/trace-ids'
import { listInterrupts, resolveInterrupt } from '@/api/services/agents/interrupts'
import { AGENTS, type AgentContext, type AnyAgentDefinition } from '@/api/services/agents/registry'
import {
  enqueueRun,
  getRun,
  listEvents,
  parkRun,
  resumeRun,
  runOnce,
} from '@/api/services/agents/runs'
import { finishStep } from '@/api/services/agents/runtime'
import { callStructuredTool } from '@/api/services/ai/agent-loop'
import { AiError } from '@/api/services/ai/errors'
import { overrideResolveChatForTests } from '@/api/services/ai/resolve'
import type { ChatClient, ChatParams } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import * as workflowModule from '@/api/workflows/agent-run'
import { AgentRunWorkflow } from '@/api/workflows/agent-run'
import { loadConfig } from '@/config'
import * as dbClient from '@/db/client'
import { agentRuns, aiSpans, aiUsage } from '@/db/schema'
import { FakeChatClient, type FakeScript } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { FIXTURE_AGENT } from '../helpers/fixture-agents'
import { createExecutionContext, createTestEnv, stubs, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep, type FakeWorkflowStepOptions } from '../mocks/cloudflare-workers'

const state: { client: ChatClient | null } = { client: null }

overrideResolveChatForTests(async () => {
  if (!state.client) throw new AiError('auth', 'anthropic_compatible', 'no client scripted')
  return {
    client: state.client,
    provider: 'anthropic_compatible',
    model: 'fake-model',
    source: 'tenant',
    billedToPlatform: false,
    maxOutputTokens: 2048,
  }
})

const db = setupTestDatabase()

const TOOL_TURN = {
  toolUses: [{ name: 'submit_answer', input: { answer: 'Volcanoes are mountains that erupt.' } }],
  usage: { inputTokens: 33, outputTokens: 12 },
}

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

function script(s: FakeScript) {
  const client = new FakeChatClient(s, 'anthropic_compatible')
  state.client = client
  return client
}

async function queuedRun(
  env: TestEnv,
  input: Record<string, unknown> = { text: 'Volcanoes erupt.' }
) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const { run } = await enqueueRun(db, loadConfig(env), env, {
    tenantId: tenant.id,
    agentKey: FIXTURE_AGENT,
    input,
    userId: user.id,
  })
  return { run, user, tenant }
}

async function drive(
  env: TestEnv,
  runId: string,
  tenantId: string,
  stepOptions: FakeWorkflowStepOptions = {},
  maxInterruptRounds?: number
) {
  const { step, calls, waits, names } = createFakeWorkflowStep(stepOptions)
  const workflow = new AgentRunWorkflow(createExecutionContext(), env)
  if (maxInterruptRounds !== undefined) workflow.maxInterruptRounds = maxInterruptRounds
  // The fake covers `do`/`sleep`; the platform type also declares `sleepUntil`/`waitForEvent`.
  const outcome = await workflow.run(
    {
      payload: { runId, tenantId },
      timestamp: new Date(),
      instanceId: runId,
      workflowName: 'rocketflare-agent-run',
    },
    step as unknown as Parameters<AgentRunWorkflow['run']>[1]
  )
  return { outcome, calls, waits, names }
}

const originalAgent = AGENTS[FIXTURE_AGENT]

/**
 * Give the fixture agent a body for the test. The swap is undone after every test, so no later
 * file sharing the registry sees it.
 */
function installAgent(run: (ctx: AgentContext) => Promise<unknown>): void {
  AGENTS[FIXTURE_AGENT] = {
    meta: { ...originalAgent.meta, inputSchema: z.any(), outputSchema: z.any() },
    run,
  } as AnyAgentDefinition
}

/** The default body: one forced tool call, its events, an artifact, and a cancellation check. */
async function answerOnce(ctx: AgentContext) {
  await ctx.step('answer', 'Answering', 'running')
  const system = await ctx.prompt()
  await ctx.emit({ type: 'tool.start', data: { name: 'submit_answer' } })
  const result = await callStructuredTool(ctx.chat.client, {
    model: ctx.chat.model,
    maxTokens: ctx.chat.maxOutputTokens,
    system,
    messages: [{ role: 'user', content: 'Answer.' }],
    tool: {
      name: 'submit_answer',
      description: 'Submit the answer. Call exactly once.',
      schema: z.object({ answer: z.string().min(1) }),
    },
  })
  await ctx.emit({ type: 'tool.end', data: { name: 'submit_answer' } })
  await ctx.step('answer', 'Answering', 'done')
  await ctx.artifact({
    key: 'answer',
    title: 'Answer',
    data: { kind: 'markdown', markdown: result.answer },
  })
  await ctx.checkCancelled()
  return { answer: result.answer }
}

const APPROVAL: AgentInterruptSpec = { kind: 'approval', message: 'Send this email?' }

/** Answer everything this run is waiting on, then un-park it — what the resolve route does. */
async function answerAndResume(tenantId: string, runId: string, userId: string) {
  for (const row of await listInterrupts(db, tenantId, runId, 'pending')) {
    await resolveInterrupt(db, {
      tenantId,
      runId,
      interruptId: row.id,
      status: 'resolved',
      payload: { approved: true },
      resolvedByUserId: userId,
    })
  }
  await resumeRun(db, tenantId, runId)
}

beforeEach(() => {
  state.client = null
  installAgent(answerOnce)
})

afterEach(() => {
  AGENTS[FIXTURE_AGENT] = originalAgent
})

describe('AgentRunWorkflow', () => {
  it('claim → execute → finish: events in order, output persisted, usage recorded, nudges sent, one DB client per step', async () => {
    const env = createTestEnv()
    const client = script([TOOL_TURN])
    const { run, tenant, user } = await queuedRun(env)
    const created = vi.spyOn(dbClient, 'openDatabase')

    const { outcome, calls } = await drive(env, run.id, tenant.id)

    expect(outcome).toEqual({ runId: run.id, status: 'succeeded', error: undefined })
    expect(calls.map(c => c.name)).toEqual(['claim', 'execute#0', 'finish'])
    expect(calls[1]?.config).toEqual({
      retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
      timeout: '10 minutes',
    })
    expect(created).toHaveBeenCalledTimes(3)

    const row = await getRun(db, tenant.id, run.id)
    expect(row).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      output: { answer: 'Volcanoes are mountains that erupt.' },
      error: null,
    })
    expect(row?.startedAt).toBeInstanceOf(Date)
    expect(row?.finishedAt).toBeInstanceOf(Date)

    const events = await listEvents(db, tenant.id, run.id)
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i + 1))
    const summary = (e: { type: string; data: unknown }) => {
      const d = e.data as Record<string, unknown>
      return e.type === 'step' ? [e.type, d.key, d.status] : [e.type, d.status ?? d.name]
    }
    // The runtime's own rows bracket the agent's, in the order the agent wrote them.
    expect(events.map(summary)).toEqual([
      ['status', 'running'],
      ['step', 'answer', 'running'],
      ['tool.start', 'submit_answer'],
      ['tool.end', 'submit_answer'],
      ['step', 'answer', 'done'],
      ['artifact', undefined],
      ['status', 'succeeded'],
    ])

    // The model was asked with the agent's registry prompt and the configured output budget.
    const params: ChatParams | undefined = client.calls[0]
    expect(String(params?.system)).toContain(`working for ${tenant.name}`)
    expect(params?.toolChoice).toEqual({ type: 'tool', name: 'submit_answer' })
    expect(params?.maxTokens).toBe(2048)

    const ledger = await db.select().from(aiUsage).where(eq(aiUsage.tenantId, tenant.id))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      userId: user.id,
      feature: `agent:${FIXTURE_AGENT}`,
      provider: 'anthropic_compatible',
      model: 'fake-model',
      inputTokens: 33,
      outputTokens: 12,
    })

    const nudges = stubs(env)
      .hub.broadcasts.filter(b => b.tenantId === tenant.id)
      .map(b => b.args[1] as { type: string; payload: { entity: string; id: string } })
    expect(nudges.length).toBeGreaterThanOrEqual(events.length)
    for (const n of nudges)
      expect(n).toMatchObject({
        type: 'entity.changed',
        payload: { entity: 'agent-run', id: run.id },
      })

    // One trace per run, derived from its id — `execute#0` (written on the step's own client,
    // hence still three clients above) under the root that `finish` recorded once the run settled.
    expect(row?.traceId).toBe(traceIdForRun(run.id))
    const spans = await db
      .select()
      .from(aiSpans)
      .where(and(eq(aiSpans.tenantId, tenant.id), eq(aiSpans.runId, run.id)))
    expect(new Set(spans.map(s => s.traceId))).toEqual(new Set([traceIdForRun(run.id)]))
    const root = spans.find(s => s.parentSpanId === null)
    const step = spans.find(s => s.name === 'execute#0')
    expect(root).toMatchObject({
      spanId: rootSpanIdForRun(run.id),
      name: `invoke_agent ${FIXTURE_AGENT}`,
      kind: 'agent',
      status: 'ok',
      userId: user.id,
    })
    expect(step?.parentSpanId).toBe(root?.spanId)
    // The first claim exported `run started` under the same root id, so a backend lists the run
    // while it is still going; the root itself is recorded once, at the end.
    const started = spans.find(s => s.name === 'run started')
    expect(started?.parentSpanId).toBe(rootSpanIdForRun(run.id))
    expect(started?.attributes).toMatchObject({
      'rocketflare.run.pending': true,
      'langfuse.trace.name': FIXTURE_AGENT,
      'gen_ai.conversation.id': run.id,
    })
    expect(spans.filter(s => s.spanId === rootSpanIdForRun(run.id))).toHaveLength(1)
    expect(root?.attributes).toMatchObject({ 'gen_ai.conversation.id': run.id })
    const generation = spans.find(s => s.kind === 'llm')
    expect(generation).toMatchObject({
      parentSpanId: step?.spanId,
      name: 'chat fake-model',
      model: 'fake-model',
      inputTokens: 33,
      outputTokens: 12,
    })
  })

  it('a cancel requested between turns → cancelled (a status, not an error)', async () => {
    const env = createTestEnv()
    const { run, tenant } = await queuedRun(env)
    const inner = new FakeChatClient([TOOL_TURN], 'anthropic_compatible')
    // The cancel lands WHILE the model call is in flight; the agent's next `checkCancelled()` sees it.
    state.client = {
      provider: inner.provider,
      stream: p => inner.stream(p),
      complete: async p => {
        await db
          .update(agentRuns)
          .set({ cancelRequestedAt: new Date() })
          .where(eq(agentRuns.id, run.id))
        return inner.complete(p)
      },
    }
    const { outcome } = await drive(env, run.id, tenant.id)
    expect(outcome.status).toBe('cancelled')
    const row = await getRun(db, tenant.id, run.id)
    expect(row).toMatchObject({ status: 'cancelled', error: null, output: null })
    const events = await listEvents(db, tenant.id, run.id)
    expect(events.at(-1)).toMatchObject({ type: 'status', data: { status: 'cancelled' } })
  })

  it('a run cancelled while queued is skipped at claim (no execute, no events)', async () => {
    const env = createTestEnv()
    const { run, tenant } = await queuedRun(env)
    await db
      .update(agentRuns)
      .set({ status: 'cancelled', cancelRequestedAt: new Date(), finishedAt: new Date() })
      .where(eq(agentRuns.id, run.id))
    script([TOOL_TURN])
    const { outcome, calls } = await drive(env, run.id, tenant.id)
    expect(outcome).toEqual({ runId: run.id, status: 'skipped' })
    expect(calls.map(c => c.name)).toEqual(['claim'])
    expect(await listEvents(db, tenant.id, run.id)).toEqual([])
    expect((await getRun(db, tenant.id, run.id))?.status).toBe('cancelled')
  })

  it('a non-retryable provider error → failed at once with a redacted sentence; retryable → rethrown on attempt 1, finish backstop settles', async () => {
    const env = createTestEnv()
    const a = await queuedRun(env)
    script([
      { error: new AiError('auth', 'anthropic_compatible', 'bad key sk-secret-0123456789abcdef') },
    ])
    const failed = await drive(env, a.run.id, a.tenant.id)
    expect(failed.outcome.status).toBe('failed')
    const row = await getRun(db, a.tenant.id, a.run.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toMatch(/rejected the credentials/)
    expect(row?.error).not.toContain('sk-secret')
    const events = await listEvents(db, a.tenant.id, a.run.id)
    expect(events.at(-2)).toMatchObject({ type: 'error', data: { willRetry: false, attempt: 1 } })
    expect(events.at(-1)).toMatchObject({ type: 'status', data: { status: 'failed' } })

    const b = await queuedRun(env)
    script([{ error: new AiError('unavailable', 'anthropic_compatible', 'timeout') }])
    const retried = await drive(env, b.run.id, b.tenant.id)
    // The fake step has no retries: execute threw (attempt 1 ≤ EXECUTE_RETRIES), finish settled it.
    expect(retried.calls.map(c => c.name)).toEqual(['claim', 'execute#0', 'finish'])
    expect(retried.outcome.status).toBe('failed')
    const rowB = await getRun(db, b.tenant.id, b.run.id)
    expect(rowB?.status).toBe('failed')
    expect(rowB?.error).toMatch(/did not complete/)
    const eventsB = await listEvents(db, b.tenant.id, b.run.id)
    expect(
      eventsB.some(e => e.type === 'error' && (e.data as { willRetry: boolean }).willRetry === true)
    ).toBe(true)
  })

  it('runOnce records a result once per key and replays it, including null', async () => {
    const env = createTestEnv()
    const { run, tenant } = await queuedRun(env)
    let calls = 0
    const work = async () => {
      calls += 1
      return { id: calls }
    }
    expect(await runOnce(db, tenant.id, run.id, 'k', work)).toEqual({ id: 1 })
    expect(await runOnce(db, tenant.id, run.id, 'k', work)).toEqual({ id: 1 })
    expect(calls).toBe(1)
    // A different key is different work.
    expect(await runOnce(db, tenant.id, run.id, 'other', work)).toEqual({ id: 2 })
    // `null` is a recorded RESULT, not "nothing recorded" — it must not re-run the work.
    expect(await runOnce(db, tenant.id, run.id, 'n', async () => null)).toBeNull()
    expect(
      await runOnce(db, tenant.id, run.id, 'n', async () => {
        throw new Error('must not run again')
      })
    ).toBeNull()
  })

  it('withStepDatabase closes the client even when the step body throws', async () => {
    const env = createTestEnv()
    const cfg = loadConfig(env)
    const close = vi.fn(async () => {})
    vi.spyOn(dbClient, 'openDatabase').mockReturnValueOnce({ db, close })
    await expect(
      workflowModule.withStepDatabase(env, cfg, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('the suspend/resume loop', () => {
  it('parks, resumes and completes — with a distinct step name per round', async () => {
    const env = createTestEnv()
    script([])
    let entries = 0
    installAgent(async ctx => {
      entries += 1
      const answer = await ctx.interrupt({ key: 'send-it', spec: APPROVAL })
      return { entries, answer: answer.payload }
    })
    const { run, tenant, user } = await queuedRun(env)

    const { outcome, names, waits } = await drive(env, run.id, tenant.id, {
      // The resolve route's two halves, in the order that matters: the answer is written, and the
      // row is flipped `awaiting_input → running`, BEFORE the instance is woken.
      onWait: async () => {
        await answerAndResume(tenant.id, run.id, user.id)
        return { interruptId: null }
      },
    })

    expect(outcome.status).toBe('succeeded')
    // `run()` really was re-entered from the top, and every step name is its own.
    expect(entries).toBe(2)
    expect(names).toEqual(['claim', 'execute#0', 'resume#0', 'execute#1', 'finish'])
    expect(new Set(names).size).toBe(names.length)
    expect(waits).toEqual([
      {
        name: 'resume#0',
        type: AGENT_RESUME_EVENT,
        timeout: loadConfig(env).AGENT_INTERRUPT_TIMEOUT,
      },
    ])
    // T8: a `.` in the event type is `workflow.invalid_event_type` — no fake step would catch it.
    expect(waits[0]?.type).toBe('agent-resume')

    const row = await getRun(db, tenant.id, run.id)
    expect(row).toMatchObject({ status: 'succeeded', error: null })
    expect((row?.output as { answer?: unknown })?.answer).toEqual({ approved: true })
    // The park cleared itself: nothing is left pending and the checkpoint is scratch space again.
    expect(await listInterrupts(db, tenant.id, run.id, 'pending')).toEqual([])
    expect(row?.checkpoint).toBeNull()
  })

  it('nobody answers: the wait times out and the park settles cancelled with a NULL error', async () => {
    const env = createTestEnv()
    script([])
    installAgent(async ctx => {
      await ctx.interrupt({ key: 'send-it', spec: APPROVAL })
      return { never: true }
    })
    const { run, tenant } = await queuedRun(env)

    // No `onWait` and no queued events: the fake wait rejects exactly as the platform's timeout does.
    const { outcome, names } = await drive(env, run.id, tenant.id)

    expect(names).toEqual(['claim', 'execute#0', 'resume#0', 'expire#0', 'finish'])
    expect(outcome.status).toBe('cancelled')
    const row = await getRun(db, tenant.id, run.id)
    // A cancel is a STATUS, not a message: the reason is an event row, `error` stays NULL.
    expect(row).toMatchObject({ status: 'cancelled', error: null })
    expect(row?.finishedAt).toBeInstanceOf(Date)
    const events = await listEvents(db, tenant.id, run.id)
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      data: { status: 'cancelled', reason: 'expired' },
    })
    expect(events.some(e => e.type === 'error')).toBe(false)
    // Nothing is left for anybody to answer.
    expect(await listInterrupts(db, tenant.id, run.id, 'pending')).toEqual([])
    expect((await listInterrupts(db, tenant.id, run.id)).map(i => i.status)).toEqual(['expired'])
  })

  // The cap is lowered for the test: the behaviour is what happens AT it, and 32 rounds of real
  // DB work was 5 s on a CI runner and 30 s on a real Neon branch. The real value is asserted
  // to be what the workflow uses by default.
  it('an agent that never stops asking is abandoned after MAX_INTERRUPT_ROUNDS, cleanly', async () => {
    const ROUNDS = 3
    expect(new AgentRunWorkflow(createExecutionContext(), createTestEnv()).maxInterruptRounds).toBe(
      MAX_INTERRUPT_ROUNDS
    )
    const env = createTestEnv()
    script([])
    let asked = 0
    installAgent(async ctx => {
      // A NEW key every round, which is the only way past `requestInterrupt`'s create-or-read —
      // and precisely the runaway this guard exists for.
      asked += 1
      await ctx.interrupt({ key: `ask-${asked}`, spec: APPROVAL })
      return { never: true }
    })
    const { run, tenant, user } = await queuedRun(env)

    const { outcome, names } = await drive(
      env,
      run.id,
      tenant.id,
      {
        onWait: async () => {
          await answerAndResume(tenant.id, run.id, user.id)
          return { interruptId: null }
        },
      },
      ROUNDS
    )

    // It stopped, rather than looping until the step budget ran out.
    expect(outcome.status).toBe('failed')
    expect(names.filter(n => n.startsWith('resume#'))).toHaveLength(ROUNDS)
    expect(names.at(-2)).toBe(`execute#${ROUNDS}`)
    expect(names.at(-1)).toBe('finish')
    expect(new Set(names).size).toBe(names.length)

    const row = await getRun(db, tenant.id, run.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain(String(ROUNDS))
    // And the questions nobody will now answer are closed, not left pending forever.
    expect(await listInterrupts(db, tenant.id, run.id, 'pending')).toEqual([])
  })

  it('finishStep does not FAIL a parked row (T7) — it expires it', async () => {
    const env = createTestEnv()
    script([])
    installAgent(async ctx => {
      await ctx.interrupt({ key: 'send-it', spec: APPROVAL })
      return { never: true }
    })
    const { run, tenant } = await queuedRun(env)
    await drive(env, run.id, tenant.id, { onWait: () => undefined })
    // Put it back the way the expiry found it, and run the backstop on its own.
    await db
      .update(agentRuns)
      .set({ status: 'running', finishedAt: null })
      .where(eq(agentRuns.id, run.id))
    const parked = await parkRun(db, tenant.id, run.id)
    expect(parked?.status).toBe('awaiting_input')

    const outcome = await finishStep(db, env, fakeLogger(), {
      runId: run.id,
      tenantId: tenant.id,
    })

    expect(outcome.status).not.toBe('failed')
    expect(outcome).toMatchObject({ runId: run.id, status: 'cancelled', error: undefined })
    expect(await getRun(db, tenant.id, run.id)).toMatchObject({
      status: 'cancelled',
      error: null,
    })
  })
})

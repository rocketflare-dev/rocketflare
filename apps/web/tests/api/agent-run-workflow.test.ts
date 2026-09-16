// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the chat provider seam), so this file needs its own module registry.
/**
 * `AgentRunWorkflow` (D7) driven end to end under Node: the class with a fake `step` (runs callbacks
 * inline, records names/config) and test bindings against the real database. claim → execute
 * `summarize-text` with a `FakeChatClient` answering the `submit_summary` tool call → events in order
 * → row `succeeded` with the output → `ai_usage` row → nudges. Also: cancellation between turns →
 * `cancelled`; a non-retryable provider error → `failed` with a redacted sentence; a retryable one
 * rethrows on attempt 1 (the platform retries) and the finish backstop settles the row; a run
 * cancelled while queued is skipped at claim; `index: true` stores the summary through `ingestText`
 * and `searchChunks` finds it (retrieval is exercised, 00 §1.3); each step closes its DB client.
 *
 * Plus the suspend/resume loop (issue #17): `execute#N` / `resume#N` / `expire#N`, whose step names
 * must be DISTINCT per round — the platform treats a step name as its identity and replays a
 * repeated one's earlier result, which would read as "the agent ignored my approval".
 */
import { AGENT_RESUME_EVENT, MAX_INTERRUPT_ROUNDS } from '@rocketflare/shared/ai/agents'
import type { AgentInterruptSpec } from '@rocketflare/shared/ai/interrupts'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fullAccessScope } from '@/api/services/access'
import { listArtifacts } from '@/api/services/agents/artifacts'
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
import { executeRun, finishStep } from '@/api/services/agents/runtime'
import { AiError } from '@/api/services/ai/errors'
import { searchChunks } from '@/api/services/ai/retrieval'
import type { ChatClient, ChatParams } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import * as workflowModule from '@/api/workflows/agent-run'
import { AgentRunWorkflow } from '@/api/workflows/agent-run'
import { loadConfig } from '@/config'
import * as dbClient from '@/db/client'
import { agentRunEffects, agentRuns, aiUsage, chunks, documents } from '@/db/schema'
import { FakeChatClient, type FakeScript } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createExecutionContext, createTestEnv, stubs, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep, type FakeWorkflowStepOptions } from '../mocks/cloudflare-workers'

const state: { client: ChatClient | null } = { client: null }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      if (!state.client) throw new AiError('auth', 'anthropic_compatible', 'no client scripted')
      return {
        client: state.client,
        provider: 'anthropic_compatible',
        model: 'fake-model',
        source: 'tenant',
        maxOutputTokens: 2048,
      }
    }),
  }
})

const db = setupTestDatabase()

const TOOL_TURN = {
  toolUses: [
    {
      name: 'submit_summary',
      input: { summary: 'Volcanoes are mountains that erupt.', keyPoints: ['Erupt', 'Mountains'] },
    },
  ],
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
  const { run } = await enqueueRun(db, env, {
    tenantId: tenant.id,
    agentKey: 'summarize-text',
    input,
    userId: user.id,
  })
  return { run, user, tenant }
}

async function drive(
  env: TestEnv,
  runId: string,
  tenantId: string,
  stepOptions: FakeWorkflowStepOptions = {}
) {
  const { step, calls, waits, names } = createFakeWorkflowStep(stepOptions)
  const workflow = new AgentRunWorkflow(createExecutionContext(), env)
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

const originalAgent = AGENTS['summarize-text']

/**
 * Swap `summarize-text` for an agent written for this test. The kit's own agents do not interrupt
 * until phase 8 and the registry is keyed by `AgentKey`, so there is no third key to borrow; the
 * swap is undone after every test and the file is `@vitest-isolate` for it.
 */
function installAgent(run: (ctx: AgentContext) => Promise<unknown>): void {
  AGENTS['summarize-text'] = {
    meta: { ...originalAgent.meta, inputSchema: z.any(), outputSchema: z.any() },
    run,
  } as AnyAgentDefinition
}

const APPROVAL: AgentInterruptSpec = { kind: 'approval', message: 'Send this email?' }

/**
 * Approve whatever the run is parked on, from inside the fake's `onWait` — the stand-in for a
 * person clicking Approve while the instance sits on `step.waitForEvent`. Returning a payload is
 * what makes the wait resolve rather than time out.
 */
function approveOnWait(tenantId: string, runId: string, userId: string) {
  return async () => {
    await answerAndResume(tenantId, runId, userId)
    return { interruptId: 'answered' }
  }
}

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
})

afterEach(() => {
  AGENTS['summarize-text'] = originalAgent
})

describe('AgentRunWorkflow', () => {
  it('claim → execute → finish: events in order, output persisted, usage recorded, nudges sent, one DB client per step', async () => {
    const env = createTestEnv()
    const client = script([TOOL_TURN])
    const { run, tenant, user } = await queuedRun(env)
    const created = vi.spyOn(dbClient, 'createDatabase')

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
      output: { summary: 'Volcanoes are mountains that erupt.', keyPoints: ['Erupt', 'Mountains'] },
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
    expect(events.map(summary)).toEqual([
      ['status', 'running'],
      ['step', 'precheck', 'running'],
      ['step', 'precheck', 'done'],
      ['step', 'summarize', 'running'],
      ['tool.start', 'submit_summary'],
      ['tool.end', 'submit_summary'],
      ['text', undefined],
      ['step', 'summarize', 'done'],
      ['artifact', undefined],
      ['status', 'succeeded'],
    ])
    expect(events.find(e => e.type === 'text')?.data).toEqual({
      text: 'Volcanoes are mountains that erupt.',
    })

    // The model was asked with the registry prompt (style interpolated) and a forced tool choice.
    const params: ChatParams | undefined = client.calls[0]
    expect(String(params?.system)).toContain(`working for ${tenant.name}`)
    expect(String(params?.system)).toContain('(bullets)')
    expect(params?.toolChoice).toEqual({ type: 'tool', name: 'submit_summary' })
    expect(params?.maxTokens).toBe(2048)

    const ledger = await db.select().from(aiUsage).where(eq(aiUsage.tenantId, tenant.id))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      userId: user.id,
      feature: 'agent:summarize-text',
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

  it('index: true asks first, then stores the summary through ingestText; searchChunks finds it and another tenant finds nothing', async () => {
    const env = createTestEnv()
    script([TOOL_TURN])
    const { run, tenant, user } = await queuedRun(env, { text: 'Volcanoes erupt.', index: true })
    // The write is gated on a person: `execute#0` parks on `approve-index`, the wait is answered,
    // `execute#1` re-enters `run()` and finds the ANSWER on `(run_id, 'approve-index')` (T2).
    const { outcome, calls, waits } = await drive(env, run.id, tenant.id, {
      onWait: approveOnWait(tenant.id, run.id, user.id),
    })
    expect(outcome.status).toBe('succeeded')
    expect(calls.map(c => c.name)).toEqual(['claim', 'execute#0', 'execute#1', 'finish'])
    expect(waits.map(w => w.name)).toEqual(['resume#0'])
    // ONE model call across both attempts: the summarise phase is behind `ctx.once`, so a park is
    // not a second bill. (`script([TOOL_TURN])` would have thrown on a second call.)
    const interrupts = await listInterrupts(db, tenant.id, run.id)
    expect(interrupts.map(i => [i.key, i.kind, i.status])).toEqual([
      ['approve-index', 'approval', 'resolved'],
    ])
    const row = await getRun(db, tenant.id, run.id)
    const documentId = (row?.output as { documentId?: string } | null)?.documentId
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/)
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId as string))
    expect(doc).toMatchObject({
      tenantId: tenant.id,
      source: 'agent:summarize-text',
      status: 'indexed',
      chunkCount: 1,
      embeddingModel: '@cf/baai/bge-m3',
    })
    expect(
      await db
        .select()
        .from(chunks)
        .where(and(eq(chunks.documentId, documentId as string), eq(chunks.tenantId, tenant.id)))
    ).toHaveLength(1)
    const events = await listEvents(db, tenant.id, run.id)
    expect(
      events.filter(e => e.type === 'step' && (e.data as { key: string }).key === 'index')
    ).toHaveLength(2)
    // Two artifacts, each written exactly once despite `run()` being entered twice: `ctx.artifact`
    // upserts on `(run_id, key)`.
    expect(
      events.filter(e => e.type === 'artifact').map(e => (e.data as { key: string }).key)
    ).toEqual(['summary', 'summary-document'])
    const artifacts = await listArtifacts(db, tenant.id, run.id)
    expect(artifacts.map(a => [a.key, a.kind])).toEqual([
      ['summary', 'markdown'],
      ['summary-document', 'document'],
    ])

    const cfg = loadConfig(env)
    const hits = await searchChunks(db, cfg, env, fullAccessScope(tenant.id), {
      query: 'volcanoes erupt',
      limit: 5,
    })
    expect(hits[0]).toMatchObject({ documentId, rank: 1 })
    expect(hits[0]?.text).toContain('Volcanoes are mountains that erupt.')
    const other = await createTestTenantWithUser(db, 'owner')
    expect(
      await searchChunks(db, cfg, env, fullAccessScope(other.tenant.id), {
        query: 'volcanoes erupt',
        limit: 5,
      })
    ).toEqual([])
  })

  it('a declined approval cancels the run with error NULL and indexes nothing', async () => {
    const env = createTestEnv()
    script([TOOL_TURN])
    const { run, tenant, user } = await queuedRun(env, { text: 'Volcanoes erupt.', index: true })
    const { outcome } = await drive(env, run.id, tenant.id, {
      onWait: async () => {
        for (const row of await listInterrupts(db, tenant.id, run.id, 'pending')) {
          await resolveInterrupt(db, {
            tenantId: tenant.id,
            runId: run.id,
            interruptId: row.id,
            status: 'cancelled',
            payload: { note: 'Not for the knowledge base' },
            resolvedByUserId: user.id,
          })
        }
        await resumeRun(db, tenant.id, run.id)
        return { interruptId: 'declined' }
      },
    })

    // `approval` rejects as `cancel_run`, so `ctx.interrupt` throws `InterruptDeclinedError` and
    // the runtime settles the run. A refusal is a STATUS, not a fault: `error` stays NULL.
    expect(outcome.status).toBe('cancelled')
    const row = await getRun(db, tenant.id, run.id)
    expect(row).toMatchObject({ status: 'cancelled', error: null })
    expect(await db.select().from(documents).where(eq(documents.tenantId, tenant.id))).toEqual([])
    // The summary was still produced and is still readable — only the WRITE was refused.
    expect((await listArtifacts(db, tenant.id, run.id)).map(a => a.key)).toEqual(['summary'])
  })

  it('a retry after the ingest does not index the summary twice (ctx.once)', async () => {
    const env = createTestEnv()
    script([TOOL_TURN, TOOL_TURN])
    const { run, tenant, user } = await queuedRun(env, { text: 'Volcanoes erupt.', index: true })
    const { outcome } = await drive(env, run.id, tenant.id, {
      onWait: approveOnWait(tenant.id, run.id, user.id),
    })
    expect(outcome.status).toBe('succeeded')
    const documentIdOf = async () =>
      ((await getRun(db, tenant.id, run.id))?.output as { documentId?: string } | null)?.documentId
    const firstDocumentId = await documentIdOf()
    expect(firstDocumentId).toMatch(/^[0-9a-f-]{36}$/)

    // Put the row back into the state a step retry re-enters with when the failure landed AFTER
    // the ingest committed: still `running`, no output. Without `ctx.once` the second attempt
    // would call `ingestText` again and leave the tenant with two copies of the same summary.
    await db
      .update(agentRuns)
      .set({ status: 'running', output: null, finishedAt: null })
      .where(eq(agentRuns.id, run.id))

    const second = await executeRun(db, loadConfig(env), env, fakeLogger(), {
      runId: run.id,
      tenantId: tenant.id,
    })
    expect(second.status).toBe('succeeded')

    // Same document id replayed from the ledger, and exactly one document in the tenant.
    expect(await documentIdOf()).toBe(firstDocumentId)
    expect(await db.select().from(documents).where(eq(documents.tenantId, tenant.id))).toHaveLength(
      1
    )
    const effects = await db.query.agentRunEffects.findMany({
      where: eq(agentRunEffects.runId, run.id),
    })
    // `index-summary` and `summary` are the agent's; `notify:park:*` is the runtime's once-only
    // "the approvers have been told" claim over the same ledger.
    expect(effects.filter(e => e.key === 'index-summary')).toHaveLength(1)
    expect(effects.map(e => e.key).sort()).toEqual(
      expect.arrayContaining(['index-summary', 'summary'])
    )
    expect(effects.every(e => e.tenantId === tenant.id)).toBe(true)
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
    vi.spyOn(dbClient, 'createDatabase').mockReturnValueOnce({ db, close })
    await expect(
      workflowModule.withStepDatabase(env, cfg, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('the suspend/resume loop (issue #17)', () => {
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
      // row is flipped `awaiting_input → running`, BEFORE the instance is woken (decision 2).
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

  it('an agent that never stops asking is abandoned after MAX_INTERRUPT_ROUNDS, cleanly', async () => {
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

    const { outcome, names } = await drive(env, run.id, tenant.id, {
      onWait: async () => {
        await answerAndResume(tenant.id, run.id, user.id)
        return { interruptId: null }
      },
    })

    // It stopped, rather than looping until the step budget ran out.
    expect(outcome.status).toBe('failed')
    expect(names.filter(n => n.startsWith('resume#'))).toHaveLength(MAX_INTERRUPT_ROUNDS)
    expect(names.at(-2)).toBe(`execute#${MAX_INTERRUPT_ROUNDS}`)
    expect(names.at(-1)).toBe('finish')
    expect(new Set(names).size).toBe(names.length)

    const row = await getRun(db, tenant.id, run.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain(String(MAX_INTERRUPT_ROUNDS))
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

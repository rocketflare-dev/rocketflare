import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fullAccessScope } from '@/api/services/access'
import { listArtifacts } from '@/api/services/agents/artifacts'
import { listInterrupts, resolveInterrupt } from '@/api/services/agents/interrupts'
import { enqueueRun, getRun, listEvents, resumeRun } from '@/api/services/agents/runs'
import { executeRun } from '@/api/services/agents/runtime'
import { AiError } from '@/api/services/ai/errors'
import { overrideResolveChatForTests } from '@/api/services/ai/resolve'
import { searchChunks } from '@/api/services/ai/retrieval'
import type { ChatClient, ChatParams } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import { AgentRunWorkflow } from '@/api/workflows/agent-run'
import { loadConfig } from '@/config'
import { agentRunEffects, agentRuns, aiUsage, chunks, documents } from '@/db/schema'
import { FakeChatClient, type FakeScript } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createExecutionContext, createTestEnv, type TestEnv } from '../mocks/bindings'
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
  const { run } = await enqueueRun(db, loadConfig(env), env, {
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

describe('AgentRunWorkflow', () => {
  it('summarize-text: one forced submit_summary call, its steps and events, the summary as output, usage under its key', async () => {
    const env = createTestEnv()
    const client = script([TOOL_TURN])
    const { run, tenant, user } = await queuedRun(env)

    const { outcome } = await drive(env, run.id, tenant.id)

    expect(outcome).toEqual({ runId: run.id, status: 'succeeded', error: undefined })
    const row = await getRun(db, tenant.id, run.id)
    expect(row).toMatchObject({
      status: 'succeeded',
      output: { summary: 'Volcanoes are mountains that erupt.', keyPoints: ['Erupt', 'Mountains'] },
      error: null,
    })

    const events = await listEvents(db, tenant.id, run.id)
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

    const ledger = await db.select().from(aiUsage).where(eq(aiUsage.tenantId, tenant.id))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      userId: user.id,
      feature: 'agent:summarize-text',
      inputTokens: 33,
      outputTokens: 12,
    })
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
})

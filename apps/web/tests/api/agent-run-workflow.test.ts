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
 */
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueueRun, getRun, listEvents } from '@/api/services/agents/runs'
import { AiError } from '@/api/services/ai/errors'
import { searchChunks } from '@/api/services/ai/retrieval'
import type { ChatClient, ChatParams } from '@/api/services/ai/types'
import * as workflowModule from '@/api/workflows/agent-run'
import { AgentRunWorkflow } from '@/api/workflows/agent-run'
import { loadConfig } from '@/config'
import * as dbClient from '@/db/client'
import { agentRuns, aiUsage, chunks, documents } from '@/db/schema'
import { FakeChatClient, type FakeScript } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createExecutionContext, createTestEnv, stubs, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

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

async function drive(env: TestEnv, runId: string, tenantId: string) {
  const { step, calls } = createFakeWorkflowStep()
  const workflow = new AgentRunWorkflow(createExecutionContext(), env)
  // The fake covers `do`/`sleep`; the platform type also declares `sleepUntil`/`waitForEvent`.
  const outcome = await workflow.run(
    {
      payload: { runId, tenantId },
      timestamp: new Date(),
      instanceId: runId,
      workflowName: 'gmgo-starter-agent-run',
    },
    step as unknown as Parameters<AgentRunWorkflow['run']>[1]
  )
  return { outcome, calls }
}

beforeEach(() => {
  state.client = null
})

describe('AgentRunWorkflow', () => {
  it('claim → execute → finish: events in order, output persisted, usage recorded, nudges sent, one DB client per step', async () => {
    const env = createTestEnv()
    const client = script([TOOL_TURN])
    const { run, tenant, user } = await queuedRun(env)
    const created = vi.spyOn(dbClient, 'createDatabase')

    const { outcome, calls } = await drive(env, run.id, tenant.id)

    expect(outcome).toEqual({ runId: run.id, status: 'succeeded', error: undefined })
    expect(calls.map(c => c.name)).toEqual(['claim', 'execute', 'finish'])
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
    expect(retried.calls.map(c => c.name)).toEqual(['claim', 'execute', 'finish'])
    expect(retried.outcome.status).toBe('failed')
    const rowB = await getRun(db, b.tenant.id, b.run.id)
    expect(rowB?.status).toBe('failed')
    expect(rowB?.error).toMatch(/did not complete/)
    const eventsB = await listEvents(db, b.tenant.id, b.run.id)
    expect(
      eventsB.some(e => e.type === 'error' && (e.data as { willRetry: boolean }).willRetry === true)
    ).toBe(true)
  })

  it('index: true stores the summary through ingestText and searchChunks finds it; another tenant finds nothing', async () => {
    const env = createTestEnv()
    script([TOOL_TURN])
    const { run, tenant } = await queuedRun(env, { text: 'Volcanoes erupt.', index: true })
    const { outcome } = await drive(env, run.id, tenant.id)
    expect(outcome.status).toBe('succeeded')
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

    const cfg = loadConfig(env)
    const hits = await searchChunks(db, cfg, env, tenant.id, { query: 'volcanoes erupt', limit: 5 })
    expect(hits[0]).toMatchObject({ documentId, rank: 1 })
    expect(hits[0]?.text).toContain('Volcanoes are mountains that erupt.')
    const other = await createTestTenantWithUser(db, 'owner')
    expect(
      await searchChunks(db, cfg, env, other.tenant.id, { query: 'volcanoes erupt', limit: 5 })
    ).toEqual([])
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

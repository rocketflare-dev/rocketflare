// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the chat provider seam), so this file needs its own module registry.
/**
 * `research-topic` (D7, D18) — the agentic agent, driven through the real runtime against Postgres
 * with a `FakeChatClient` scripting the turns and a really-ingested document behind
 * `search_knowledge`: the loop searches, then calls the terminal `submit_answer`; the run succeeds
 * with the answer, the citation resolved to the real document, `ai_usage` summed over both turns
 * and the tool events persisted. Also the two decisions in the agent's header: a citation naming a
 * document search never returned is DROPPED, and a loop that ends in prose is salvaged by one
 * forced `submit_answer` call instead of failing.
 *
 * Plus the resume contract: a retryable failure mid-loop leaves a checkpoint on `agent_runs`, and
 * the next `execute` attempt continues that conversation instead of replaying (and re-billing) it —
 * including the documents the first attempt's searches found, which are folded back out of the
 * stored transcript so their citations are not dropped as hallucinations.
 */
import { researchTopicOutputSchema } from '@rocketflare/shared/ai/agents'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueueRun, getRun, listEvents } from '@/api/services/agents/runs'
import { claimStep, executeRun } from '@/api/services/agents/runtime'
import { AiError } from '@/api/services/ai/errors'
import { ingestText } from '@/api/services/ai/ingest'
import { parseToolLoopCheckpoint } from '@/api/services/ai/kit'
import type { ChatClient } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { agentRunEffects, agentRuns, aiUsage } from '@/db/schema'
import { FakeChatClient, type FakeScript } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

const state: { client: ChatClient | null } = { client: null }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      if (!state.client) throw new AiError('auth', 'anthropic_compatible', 'no client scripted')
      return {
        client: state.client,
        provider: 'anthropic_compatible' as const,
        model: 'fake-model',
        source: 'tenant' as const,
        maxOutputTokens: 2048,
      }
    }),
  }
})

const db = setupTestDatabase()

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

/** A tenant with one indexed document — what `search_knowledge` will find. */
async function tenantWithDocument(env: TestEnv) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const { document } = await ingestText(db, loadConfig(env), env, {
    tenantId: tenant.id,
    userId: user.id,
    title: 'Onboarding handbook',
    text: 'Access requests are reviewed by a global admin within two working days.',
    source: 'test',
  })
  return { user, tenant, document }
}

/** Enqueue and run the agent through claim → execute (the workflow steps' bodies). */
async function runResearch(env: TestEnv, tenantId: string, userId: string, topic: string) {
  const params = await enqueueRun(db, env, {
    tenantId,
    agentKey: 'research-topic',
    input: { topic },
    userId,
  }).then(r => ({ runId: r.run.id, tenantId }))
  const logger = fakeLogger()
  expect(await claimStep(db, env, logger, params)).toBe(true)
  const outcome = await executeRun(db, loadConfig(env), env, logger, params)
  return { outcome, runId: params.runId }
}

function script(s: FakeScript) {
  const client = new FakeChatClient(s, 'anthropic_compatible')
  state.client = client
  return client
}

beforeEach(() => {
  state.client = null
})

describe('research-topic agent', () => {
  it('searches the knowledge base, then answers through the terminal tool with a verified citation', async () => {
    const env = createTestEnv()
    const { tenant, user, document } = await tenantWithDocument(env)
    const client = script([
      {
        toolUses: [{ name: 'search_knowledge', input: { query: 'access requests' } }],
        usage: { inputTokens: 40, outputTokens: 10 },
      },
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: {
              answer: 'A global admin reviews them within two working days.',
              citations: [{ documentId: document.id, title: 'whatever the model called it' }],
            },
          },
        ],
        usage: { inputTokens: 60, outputTokens: 20 },
      },
    ])

    const { outcome, runId } = await runResearch(
      env,
      tenant.id,
      user.id,
      'Who reviews access requests?'
    )

    expect(outcome.status).toBe('succeeded')
    const row = await getRun(db, tenant.id, runId)
    const output = researchTopicOutputSchema.parse(row?.output)
    expect(output.answer).toContain('two working days')
    // The title comes from the search hit, never from the model.
    expect(output.citations).toEqual([{ documentId: document.id, title: 'Onboarding handbook' }])
    expect(output.turns).toBe(2)

    // The search really ran: the model was given the built-in tools and got hits back.
    expect(client.calls[0]?.tools?.map(t => t.name)).toEqual([
      'search_knowledge',
      'get_document',
      'list_documents',
      'submit_answer',
    ])
    const events = await listEvents(db, tenant.id, runId)
    const toolNames = events
      .filter(e => e.type === 'tool.start' || e.type === 'tool.end')
      .map(e => (e.data as { name: string }).name)
    // One start + one end for the real tool; the TERMINAL tool emits nothing (its call is the
    // answer, which the output panel renders — emitting it showed the answer three times over).
    expect(toolNames).toEqual(['search_knowledge', 'search_knowledge'])
    expect(events.some(e => e.type === 'text')).toBe(false)

    // Usage is the sum of both turns, under the agent's feature key.
    const usage = await db.query.aiUsage.findMany({ where: eq(aiUsage.tenantId, tenant.id) })
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      feature: 'agent:research-topic',
      inputTokens: 100,
      outputTokens: 30,
    })
  })

  it('drops a citation naming a document the search never returned', async () => {
    const env = createTestEnv()
    const { tenant, user } = await tenantWithDocument(env)
    script([
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: {
              answer: 'Answered without looking anything up.',
              citations: [{ documentId: crypto.randomUUID(), title: 'Invented source' }],
            },
          },
        ],
      },
    ])

    const { outcome, runId } = await runResearch(env, tenant.id, user.id, 'Anything at all?')

    expect(outcome.status).toBe('succeeded')
    const output = researchTopicOutputSchema.parse((await getRun(db, tenant.id, runId))?.output)
    expect(output.citations).toEqual([])
  })

  it('salvages a loop that ends in prose with one forced submit_answer call', async () => {
    const env = createTestEnv()
    const { tenant, user } = await tenantWithDocument(env)
    // Turn 1: prose, no tool call — `runToolLoop` returns `no_tool_call`. Turn 2 is the forced
    // recovery call `callStructuredTool` makes with `toolChoice: { type: 'tool' }`.
    const client = script([
      { text: 'Global admins review them within two working days.' },
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: { answer: 'Global admins review them within two working days.', citations: [] },
          },
        ],
      },
    ])

    const { outcome, runId } = await runResearch(
      env,
      tenant.id,
      user.id,
      'Who reviews access requests?'
    )

    expect(outcome.status).toBe('succeeded')
    expect(client.calls[1]?.toolChoice).toEqual({ type: 'tool', name: 'submit_answer' })
    // Two ledger rows: the loop is written as soon as its tokens are spent, the recovery from its
    // own `onUsage` — so a recovery that FAILED would still leave the loop's tokens recorded.
    const usage = await db.query.aiUsage.findMany({ where: eq(aiUsage.tenantId, tenant.id) })
    expect(usage).toHaveLength(2)
    expect(usage.every(u => u.feature === 'agent:research-topic')).toBe(true)
    const output = researchTopicOutputSchema.parse((await getRun(db, tenant.id, runId))?.output)
    expect(output.answer).toContain('two working days')
    expect(output.turns).toBe(2) // the loop's one turn plus the recovery call

    const steps = (await listEvents(db, tenant.id, runId))
      .filter(e => e.type === 'step')
      .map(e => e.data as { key: string; status: string; detail?: string })
    expect(steps.some(s => s.key === 'answer' && s.detail?.includes('no_tool_call'))).toBe(true)
  })

  it('resumes a retried run from its checkpoint instead of replaying the conversation', async () => {
    const env = createTestEnv()
    const { tenant, user, document } = await tenantWithDocument(env)
    const logger = fakeLogger()

    // Attempt 1: one real search turn, then the provider falls over with a RETRYABLE fault, which
    // is the only way `executeRun` rethrows for a Workflow step retry.
    const first = script([
      {
        toolUses: [{ name: 'search_knowledge', input: { query: 'access requests' } }],
        usage: { inputTokens: 40, outputTokens: 10 },
      },
      { error: new AiError('unavailable', 'anthropic_compatible', 'provider overloaded') },
    ])
    const { run } = await enqueueRun(db, env, {
      tenantId: tenant.id,
      agentKey: 'research-topic',
      input: { topic: 'Who reviews access requests?' },
      userId: user.id,
    })
    const params = { runId: run.id, tenantId: tenant.id }
    expect(await claimStep(db, env, logger, params)).toBe(true)
    await expect(executeRun(db, loadConfig(env), env, logger, params)).rejects.toThrow(/overloaded/)
    expect(first.calls).toHaveLength(2)

    // The row is still active and now carries the resume point for the one completed turn.
    const afterFailure = await db.query.agentRuns.findFirst({ where: eq(agentRuns.id, run.id) })
    expect(afterFailure?.status).toBe('running')
    const checkpoint = parseToolLoopCheckpoint(afterFailure?.checkpoint)
    expect(checkpoint?.turns).toBe(1)
    expect(checkpoint?.messages).toHaveLength(3)

    // Attempt 2: the model answers straight away, citing the document the FIRST attempt found.
    const second = script([
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: {
              answer: 'A global admin reviews them within two working days.',
              citations: [{ documentId: document.id, title: 'the model’s own wording' }],
            },
          },
        ],
        usage: { inputTokens: 60, outputTokens: 20 },
      },
    ])
    const outcome = await executeRun(db, loadConfig(env), env, logger, params)
    expect(outcome.status).toBe('succeeded')

    // It did NOT replay turn 1: the very first request already carries the stored transcript.
    expect(second.calls[0]?.messages.slice(0, 3)).toEqual(checkpoint?.messages)
    const output = researchTopicOutputSchema.parse((await getRun(db, tenant.id, run.id))?.output)
    // Turns carry forward, so `maxTurns` stays a budget for the RUN, not for each attempt.
    expect(output.turns).toBe(2)
    // The citation survives: `seen` was rebuilt from the resumed transcript's tool results, so a
    // document found before the retry is not mistaken for a hallucination.
    expect(output.citations).toEqual([{ documentId: document.id, title: 'Onboarding handbook' }])

    // Ledgered ONCE for the whole run, summing both attempts — `ctx.once` is what stops the
    // resumed attempt writing the loop's tokens a second time.
    const usage = await db.query.aiUsage.findMany({ where: eq(aiUsage.tenantId, tenant.id) })
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ inputTokens: 100, outputTokens: 30 })
    const effects = await db.query.agentRunEffects.findMany({
      where: eq(agentRunEffects.runId, run.id),
    })
    expect(effects.map(e => e.key)).toEqual(['loop-usage'])

    // Settling drops the checkpoint: nothing will resume, and the transcript is not a record.
    const settled = await db.query.agentRuns.findFirst({ where: eq(agentRuns.id, run.id) })
    expect(settled?.checkpoint).toBeNull()
  })

  it('starts fresh when the stored checkpoint cannot be parsed, rather than failing the run', async () => {
    const env = createTestEnv()
    const { tenant, user, document } = await tenantWithDocument(env)
    const logger = fakeLogger()
    const client = script([
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: { answer: 'Fresh start.', citations: [{ documentId: document.id, title: 't' }] },
          },
        ],
      },
    ])
    const { run } = await enqueueRun(db, env, {
      tenantId: tenant.id,
      agentKey: 'research-topic',
      input: { topic: 'Anything?' },
      userId: user.id,
    })
    const params = { runId: run.id, tenantId: tenant.id }
    expect(await claimStep(db, env, logger, params)).toBe(true)
    // A shape an older build might have written, or a corrupted value.
    await db
      .update(agentRuns)
      .set({ checkpoint: { nonsense: true } })
      .where(eq(agentRuns.id, run.id))

    const outcome = await executeRun(db, loadConfig(env), env, logger, params)
    expect(outcome.status).toBe('succeeded')
    // Fresh start = the seed only, not a resumed transcript.
    expect(client.calls[0]?.messages.slice(0, 1)).toEqual([
      { role: 'user', content: 'Research this: Anything?' },
    ])
    // A citation still needs a document the tools returned THIS attempt; none were called, so it
    // is dropped. The run is correct — just as expensive as before checkpoints existed.
    const output = researchTopicOutputSchema.parse((await getRun(db, tenant.id, run.id))?.output)
    expect(output.citations).toEqual([])
  })
})

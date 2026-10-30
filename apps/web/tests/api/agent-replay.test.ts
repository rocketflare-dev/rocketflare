// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the chat and decisions seams), so this file needs its own module registry.
/**
 * Replay: a `triage-research` run recorded through the real runtime, then replayed with the
 * current code — and with candidates that change one thing each — inside a read-only transaction.
 * The contract: a faithful replay matches and writes nothing; a reworded decision is `drift`; a new
 * one is a `decide` miss; a model call nothing recorded is a `chat` miss; a refused write is listed;
 * a live replay re-runs only `{ replay: 'rerun' }` effects and asks only what the record cannot answer.
 */

import type { TriageResearchInput } from '@rocketflare/shared/ai/agents'
import type { DecisionAnswers, DecisionRequest } from '@rocketflare/shared/ai/decisions'
import { count, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decideWithShapes } from '@/api/services/agents/decisions'
import { triageResearchAgent } from '@/api/services/agents/examples/triage-research'
import type { AgentContext, AnyAgentDefinition } from '@/api/services/agents/registry'
import {
  diffJson,
  listReplayableRuns,
  liveReplayWarnings,
  replayRun,
} from '@/api/services/agents/replay'
import { enqueueRun, getRun } from '@/api/services/agents/runs'
import { claimStep, executeRun } from '@/api/services/agents/runtime'
import { AiError } from '@/api/services/ai/errors'
import { ingestText } from '@/api/services/ai/ingest'
import type { ChatClient } from '@/api/services/ai/types'
import { recordUsage } from '@/api/services/ai/usage'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import {
  agentRunArtifacts,
  agentRunDecisions,
  agentRunEffects,
  agentRunEvents,
  aiUsage,
} from '@/db/schema'
import { FakeChatClient, type FakeScript } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

type Decider = (request: DecisionRequest) => DecisionAnswers

const state: { client: ChatClient | null; decide: Decider | null; asks: number } = {
  client: null,
  decide: null,
  asks: 0,
}

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
    resolveDecisions: vi.fn(async () => ({
      client: {
        provider: 'typesafe' as const,
        method: 'typesafe' as const,
        ask: async (req: DecisionRequest) => {
          state.asks += 1
          if (!state.decide) throw new AiError('auth', 'typesafe', 'no decider scripted')
          return {
            answers: state.decide(req),
            usage: { inputTokens: 40, outputTokens: 4 },
            model: 'jev-1.13.0',
          }
        },
      },
      provider: 'typesafe' as const,
      model: 'jev-latest',
      method: 'typesafe' as const,
      source: 'platform' as const,
    })),
  }
})

const db = setupTestDatabase()

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

function script(s: FakeScript) {
  const client = new FakeChatClient(s, 'anthropic_compatible')
  state.client = client
  return client
}

function answerAll(p: number): Decider {
  return req =>
    Object.fromEntries(
      Object.keys(req.questions).map(id => [
        id,
        { type: 'noul', noul: p, confidence: Math.abs(2 * p - 1) },
      ])
    ) as DecisionAnswers
}

const QUESTION = 'How long does an access request take?'

async function recordedRun(env: TestEnv) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const { document } = await ingestText(db, loadConfig(env), env, {
    tenantId: tenant.id,
    userId: user.id,
    title: 'Onboarding handbook',
    text: 'Access requests are reviewed by a global admin within two working days.',
    source: 'test',
  })
  state.decide = answerAll(0.95)
  script([
    {
      toolUses: [
        {
          name: 'submit_answer',
          input: { answer: 'Two working days.', documentIds: [document.id] },
        },
      ],
    },
  ])
  const { run } = await enqueueRun(db, loadConfig(env), env, {
    tenantId: tenant.id,
    agentKey: 'triage-research',
    input: { question: QUESTION },
    userId: user.id,
  })
  const params = { runId: run.id, tenantId: tenant.id }
  expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
  const outcome = await executeRun(db, loadConfig(env), env, fakeLogger(), params)
  expect(outcome.status).toBe('succeeded')
  const row = await getRun(db, tenant.id, run.id)
  if (!row) throw new Error('run vanished')
  // From here on, any model or engine call is the replay's.
  state.asks = 0
  state.client = new FakeChatClient([], 'anthropic_compatible')
  return { row, tenantId: tenant.id, documentId: document.id }
}

/** `triage-research` with its `ctx.decide` rewritten by `rewrite` — one changed thing per test. */
function withDecide(
  rewrite: (key: string, request: DecisionRequest) => [string, DecisionRequest]
): AnyAgentDefinition {
  return {
    meta: triageResearchAgent.meta,
    run: (ctx: AgentContext<TriageResearchInput>) =>
      triageResearchAgent.run({
        ...ctx,
        decide: decideWithShapes((key, request) => ctx.decide(...rewrite(key, request))),
      }),
  }
}

async function rowCounts(runId: string, tenantId: string) {
  const tables = [agentRunDecisions, agentRunEffects, agentRunEvents, agentRunArtifacts] as const
  const counts = await Promise.all(
    tables.map(async t => (await db.select({ n: count() }).from(t).where(eq(t.runId, runId)))[0]?.n)
  )
  const [usage] = await db
    .select({ n: count() })
    .from(aiUsage)
    .where(eq(aiUsage.tenantId, tenantId))
  return [...counts, usage?.n]
}

beforeEach(() => {
  state.client = new FakeChatClient([], 'anthropic_compatible')
  state.decide = null
  state.asks = 0
})

describe('replay', () => {
  it('strict: the current code over its own record matches and writes nothing', async () => {
    const env = createTestEnv()
    const { row, tenantId } = await recordedRun(env)
    const before = await rowCounts(row.id, row.tenantId)

    const [listed] = await listReplayableRuns(db, { tenantId, agentKey: 'triage-research' })
    expect(listed?.id).toBe(row.id)
    const result = await replayRun(db, loadConfig(env), env, row, triageResearchAgent, {
      logger: fakeLogger(),
    })

    expect(result).toMatchObject({
      replayStatus: 'succeeded',
      verdict: 'match',
      outputDiff: [],
      misses: [],
      writes: [],
      artifacts: ['triage:screen'],
    })
    expect(result.decisions.map(d => [d.key, d.status])).toEqual([
      ['relevant', 'served'],
      ['answerable', 'served'],
    ])
    expect(state.asks).toBe(0)
    expect(await rowCounts(row.id, row.tenantId)).toEqual(before)
  })

  it('a reworded decision is served from the record and reported as drift', async () => {
    const env = createTestEnv()
    const { row } = await recordedRun(env)
    const reworded = withDecide((key, request) => {
      if (key !== 'answerable') return [key, request]
      const q = request.questions.answerable
      if (!q) throw new Error('no answerable question')
      return [key, { ...request, questions: { answerable: { ...q, instructions: 'Reworded.' } } }]
    })
    const result = await replayRun(db, loadConfig(env), env, row, reworded, {
      logger: fakeLogger(),
    })
    expect(result.replayStatus).toBe('succeeded')
    expect(result.verdict).toBe('differs')
    expect(result.decisions.find(d => d.key === 'answerable')?.status).toBe('drift')
    expect(state.asks).toBe(0)
  })

  it('the same questions about a different state are served but reported stale', async () => {
    const env = createTestEnv()
    const { row } = await recordedRun(env)
    // What upstream code hands the decision changed (a stricter screen keeps other passages).
    const narrowed = withDecide((key, request) => [
      key,
      key === 'answerable'
        ? { ...request, state: { ...(request.state as object), passages: [] } }
        : request,
    ])
    const result = await replayRun(db, loadConfig(env), env, row, narrowed, {
      logger: fakeLogger(),
    })
    expect(result.replayStatus).toBe('succeeded')
    expect(result.decisions.find(d => d.key === 'answerable')?.status).toBe('stale')
    expect(result.verdict).toBe('differs')
  })

  it('a decision nothing recorded is a decide miss in strict mode', async () => {
    const env = createTestEnv()
    const { row } = await recordedRun(env)
    const renamed = withDecide((key, request) => [key === 'answerable' ? 'enough' : key, request])
    const result = await replayRun(db, loadConfig(env), env, row, renamed, {
      logger: fakeLogger(),
    })
    expect(result).toMatchObject({
      replayStatus: 'miss',
      verdict: 'incomplete',
      misses: [{ kind: 'decide', key: 'enough' }],
    })
    // The recorded key the new code never asked.
    expect(result.decisions.find(d => d.key === 'answerable')?.status).toBe('unused')
  })

  it('a model call nothing recorded is a chat miss in strict mode', async () => {
    const env = createTestEnv()
    const { row } = await recordedRun(env)
    // Unsure now: the replayed code escalates to research-topic, whose loop is a model call.
    const unsure: AnyAgentDefinition = {
      meta: triageResearchAgent.meta,
      run: (ctx: AgentContext<TriageResearchInput>) =>
        triageResearchAgent.run({
          ...ctx,
          decide: decideWithShapes(async (key, request) => {
            const decision = await ctx.decide(key, request)
            if (key !== 'answerable') return decision
            return {
              ...decision,
              answers: { answerable: { type: 'noul', noul: 0.55, confidence: 0.1 } },
            }
          }),
        }),
    }
    const result = await replayRun(db, loadConfig(env), env, row, unsure, {
      logger: fakeLogger(),
    })
    expect(result.replayStatus).toBe('miss')
    expect(result.misses).toContainEqual({ kind: 'chat', key: 'chat' })
  })

  it('a write the agent makes is refused and listed; uncaught, it fails the replay', async () => {
    const env = createTestEnv()
    const { row } = await recordedRun(env)
    const writer: AnyAgentDefinition = {
      meta: triageResearchAgent.meta,
      run: async (ctx: AgentContext<TriageResearchInput>) => {
        await recordUsage(ctx.db, {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          feature: 'agent:triage-research',
          provider: 'anthropic_compatible',
          model: 'fake-model',
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        return triageResearchAgent.run(ctx)
      },
    }
    const before = await rowCounts(row.id, row.tenantId)
    const result = await replayRun(db, loadConfig(env), env, row, writer, {
      logger: fakeLogger(),
    })
    expect(result.replayStatus).toBe('failed')
    expect(result.writes).toEqual(['insert ai_usage'])
    expect(await rowCounts(row.id, row.tenantId)).toEqual(before)
  })

  it('a raw SQL write reaches Postgres and is refused by the read-only transaction', async () => {
    const env = createTestEnv()
    const { row } = await recordedRun(env)
    const raw: AnyAgentDefinition = {
      meta: triageResearchAgent.meta,
      run: async (ctx: AgentContext<TriageResearchInput>) => {
        await ctx.db.execute(sql`DELETE FROM agent_run_effects WHERE run_id = ${ctx.runId}`)
        return triageResearchAgent.run(ctx)
      },
    }
    const before = await rowCounts(row.id, row.tenantId)
    const result = await replayRun(db, loadConfig(env), env, row, raw, { logger: fakeLogger() })
    expect(result.replayStatus).toBe('failed')
    expect(result.error).toContain('a write the replay refused')
    expect(await rowCounts(row.id, row.tenantId)).toEqual(before)
  })

  it('live: re-runs the rerun effect and asks only what the record cannot answer', async () => {
    const env = createTestEnv()
    const { row, documentId } = await recordedRun(env)
    const client = script([
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: { answer: 'Two days, reviewed by a global admin.', documentIds: [documentId] },
          },
        ],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
    ])
    const result = await replayRun(db, loadConfig(env), env, row, triageResearchAgent, {
      mode: 'live',
      logger: fakeLogger(),
    })
    expect(result.replayStatus).toBe('succeeded')
    expect(result.reran).toEqual(['triage:answer'])
    expect(client.calls).toHaveLength(1)
    // Both decisions had the same questions: served, never asked.
    expect(state.asks).toBe(0)
    expect(result.outputDiff).toEqual([
      {
        path: '$.answer',
        recorded: 'Two working days.',
        replayed: 'Two days, reviewed by a global admin.',
      },
    ])
    expect(result.verdict).toBe('differs')
    expect(result.liveUsage?.inputTokens).toBe(100)
    // No write was even attempted: the ledger is the runtime's meter, which a replay has not.
    expect(result.writes).toEqual([])
  })
})

describe('liveReplayWarnings', () => {
  it('warns when knowledge search would be unavailable or embed with another model', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'member')
    const warn = (env: TestEnv, workerHasAi: boolean) =>
      liveReplayWarnings(db, loadConfig(env), env, tenant.id, { workerHasAi })

    // The Worker's own tier (the AI binding) is reachable: nothing to say.
    expect(await warn(createTestEnv(), true)).toEqual([])
    // No binding and no key: every search answers knowledge_search_unavailable.
    const none = await warn(createTestEnv({ AI: undefined, EMBEDDINGS_API_KEY: undefined }), true)
    expect(none).toHaveLength(1)
    expect(none[0]).toContain('no embeddings provider is reachable')
    // The key, where the Worker would use Workers AI: two models' vectors.
    const keyOnly = createTestEnv({ AI: undefined, EMBEDDINGS_API_KEY: 'sk-test' })
    expect((await warn(keyOnly, true))[0]).toContain('two models')
    // …but the key IS the Worker's tier when it has no [ai] block.
    expect(await warn(keyOnly, false)).toEqual([])
  })
})

describe('diffJson', () => {
  it('reports paths, compares dates as JSON and caps the list', () => {
    expect(diffJson({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3, 4] })).toEqual([
      { path: '$.b[1]', recorded: 2, replayed: 3 },
      { path: '$.b[2]', recorded: undefined, replayed: 4 },
    ])
    const at = new Date('2026-01-01T00:00:00Z')
    expect(diffJson({ at }, { at: at.toISOString() })).toEqual([])
    expect(diffJson({ x: null }, {})).toEqual([
      { path: '$.x', recorded: null, replayed: undefined },
    ])
    const many = Array.from({ length: 80 }, (_, i) => i)
    expect(diffJson(many, [], 50)).toHaveLength(50)
  })
})

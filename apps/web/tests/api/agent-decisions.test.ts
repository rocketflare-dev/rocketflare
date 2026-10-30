// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the chat and decisions seams), so this file needs its own module registry.
// Also mocks the plugin barrels to register the fixture agents (tests/helpers/fixture-agents.ts).
/**
 * `ctx.decide` through the real runtime against Postgres, with a scripted decisions engine:
 * a decision is recorded ONCE per `(run, key)` and a re-entered `run()` replays it without asking
 * again; reusing a key with different questions fails the run; each call writes a thin `decision`
 * event (projected to AG-UI as `kit.agent.decision`), an `ai_usage` row and an
 * `agent_run_decisions` row that `GET /runs/:id` returns. `sift` and `pick` map answers back onto
 * items.

 * The decisions example agent built on it is tested in its own file, beside the example.
 */

import type { AgentKey } from '@rocketflare/shared/ai/agents'
import { kitAguiEventSchema } from '@rocketflare/shared/ai/agui'
import type { DecisionAnswers, DecisionRequest } from '@rocketflare/shared/ai/decisions'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { listDecisions } from '@/api/services/agents/decisions'
import { AGENTS, type AgentContext, type AnyAgentDefinition } from '@/api/services/agents/registry'
import { enqueueRun, getRun, listEvents } from '@/api/services/agents/runs'
import { claimStep, executeRun } from '@/api/services/agents/runtime'
import { AiError } from '@/api/services/ai/errors'
import type { ChatClient } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { agentRuns, aiUsage } from '@/db/schema'
import { FakeChatClient } from '../helpers/ai'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { FIXTURE_AGENT } from '../helpers/fixture-agents'
import { json, request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)
vi.mock('@/plugins/server', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureServer(await importOriginal())
)

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

/** Every noul at `p`, every choice to `pick` — enough for these tests. */
function answerAll(p: number, pick?: string): Decider {
  return req =>
    Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        if (q.type === 'noul')
          return [id, { type: 'noul', noul: p, confidence: Math.abs(2 * p - 1) }]
        if (q.type === 'choice') {
          const options = Object.keys(q.criteria)
          const chosen = pick ?? options[0] ?? ''
          return [
            id,
            {
              type: 'choice',
              choice: chosen,
              probabilities: Object.fromEntries(options.map(o => [o, o === chosen ? 1 : 0])),
              confidence: 1,
            },
          ]
        }
        return [id, { type: 'score', score: 0, probabilities: { '0': 1, '1': 0 }, confidence: 1 }]
      })
    )
}

const originalAgent = AGENTS[FIXTURE_AGENT]

function installAgent(run: (ctx: AgentContext) => Promise<unknown>): void {
  AGENTS[FIXTURE_AGENT] = {
    meta: { ...originalAgent.meta, inputSchema: z.any(), outputSchema: z.any() },
    run,
  } as AnyAgentDefinition
}

async function start(env: TestEnv, agentKey: AgentKey, input: unknown) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  return startFor(env, tenant.id, user.id, agentKey, input)
}

async function startFor(
  env: TestEnv,
  tenantId: string,
  userId: string,
  agentKey: AgentKey,
  input: unknown
) {
  const { run } = await enqueueRun(db, loadConfig(env), env, { tenantId, agentKey, input, userId })
  const params = { runId: run.id, tenantId }
  expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
  const outcome = await executeRun(db, loadConfig(env), env, fakeLogger(), params)
  return { outcome, runId: run.id, tenantId, userId }
}

const QUESTIONS = {
  urgent: { type: 'noul' as const, instructions: 'Is this urgent?' },
  team: {
    type: 'choice' as const,
    instructions: 'Which team?',
    criteria: { billing: 'Charges', support: 'Everything else' },
  },
}

beforeEach(() => {
  // The runtime resolves the agent's chat client before `run()`; a test that never calls it still needs one.
  state.client = new FakeChatClient([], 'anthropic_compatible')
  state.decide = null
  state.asks = 0
})

afterEach(() => {
  AGENTS[FIXTURE_AGENT] = originalAgent
})

describe('ctx.decide', () => {
  it('records once, replays on a re-entered run, emits a decision event and ledgers usage', async () => {
    const env = createTestEnv()
    state.decide = answerAll(0.9, 'billing')
    installAgent(async ctx => {
      const d = await ctx.decide('triage', {
        state: { text: 'charged twice' },
        questions: QUESTIONS,
      })
      return { urgent: d.answers.urgent?.noul, team: d.answers.team?.choice, replayed: d.replayed }
    })
    const { outcome, runId, tenantId } = await start(env, FIXTURE_AGENT, { text: 'x' })
    expect(outcome.status).toBe('succeeded')
    expect((await getRun(db, tenantId, runId))?.output).toEqual({
      urgent: 0.9,
      team: 'billing',
      replayed: false,
    })

    // Re-enter as a step retry would: the recorded answer comes back, the engine is not asked.
    await db
      .update(agentRuns)
      .set({ status: 'running', output: null, finishedAt: null })
      .where(eq(agentRuns.id, runId))
    expect(
      (await executeRun(db, loadConfig(env), env, fakeLogger(), { runId, tenantId })).status
    ).toBe('succeeded')
    expect((await getRun(db, tenantId, runId))?.output).toMatchObject({ replayed: true })
    expect(state.asks).toBe(1)

    const [row, ...rest] = await listDecisions(db, tenantId, runId)
    expect(rest).toEqual([])
    expect(row).toMatchObject({
      key: 'triage',
      provider: 'typesafe',
      method: 'typesafe',
      model: 'jev-1.13.0',
      questionsHash: expect.stringMatching(/^[0-9a-f]{12}$/),
    })
    expect(row?.answers.urgent?.confidence).toBeCloseTo(0.8)

    const decisionEvents = (await listEvents(db, tenantId, runId)).filter(
      e => e.type === 'decision'
    )
    expect(decisionEvents).toHaveLength(1)
    expect(decisionEvents[0]?.data).toMatchObject({
      key: 'triage',
      method: 'typesafe',
      answers: [
        { id: 'urgent', type: 'noul', answer: 'yes' },
        { id: 'team', type: 'choice', answer: 'billing', confidence: 1 },
      ],
    })

    const usage = await db
      .select()
      .from(aiUsage)
      .where(
        and(eq(aiUsage.tenantId, tenantId), eq(aiUsage.feature, `agent:${FIXTURE_AGENT}:decide`))
      )
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ provider: 'typesafe', inputTokens: 40, outputTokens: 4 })
  })

  it('fails the run when a recorded key is asked different questions', async () => {
    const env = createTestEnv()
    state.decide = answerAll(0.9)
    let calls = 0
    installAgent(async ctx => {
      calls += 1
      const questions =
        calls === 1 ? QUESTIONS : { urgent: { type: 'noul' as const, instructions: 'Changed?' } }
      await ctx.decide('triage', { state: 'x', questions })
      return {}
    })
    const { runId, tenantId } = await start(env, FIXTURE_AGENT, { text: 'x' })
    await db
      .update(agentRuns)
      .set({ status: 'running', output: null, finishedAt: null })
      .where(eq(agentRuns.id, runId))
    const second = await executeRun(db, loadConfig(env), env, fakeLogger(), { runId, tenantId })
    expect(second.status).toBe('failed')
    expect((await getRun(db, tenantId, runId))?.error).toContain('different questions')
  })

  it('sift keeps items at the threshold; pick returns the item or null', async () => {
    const env = createTestEnv()
    state.decide = req => {
      if ('pick' in req.questions) return answerAll(0, 'b')(req)
      return {
        item_0: { type: 'noul', noul: 0.8, confidence: 0.6 },
        item_1: { type: 'noul', noul: 0.2, confidence: 0.6 },
        item_2: { type: 'noul', noul: 0.5, confidence: 0 },
      }
    }
    installAgent(async ctx => {
      const sifted = await ctx.decide.sift('relevant', {
        items: ['a', 'b', 'c'],
        instructions: 'Relevant?',
      })
      const picked = await ctx.decide.pick('which', {
        items: [{ id: 'a' }, { id: 'b' }],
        idOf: item => item.id,
        describe: item => `record ${item.id}`,
        instructions: 'Which one?',
      })
      return { kept: sifted.kept, p: sifted.p, picked: picked.item, pickedP: picked.p }
    })
    const { runId, tenantId } = await start(env, FIXTURE_AGENT, { text: 'x' })
    expect((await getRun(db, tenantId, runId))?.output).toEqual({
      kept: ['a', 'c'],
      p: [0.8, 0.2, 0.5],
      picked: { id: 'b' },
      pickedP: 1,
    })
  })

  it('GET /runs/:id returns the decisions and /agui projects them as kit.agent.decision', async () => {
    const env = createTestEnv()
    state.decide = answerAll(0.9, 'support')
    installAgent(async ctx => {
      await ctx.decide('triage', { state: 'x', questions: QUESTIONS })
      return {}
    })
    const { runId, tenantId, userId } = await start(env, FIXTURE_AGENT, { text: 'x' })
    const cookie = sessionCookieHeader(await createTestSession(db, userId, tenantId))

    const res = await request(`/api/agents/runs/${runId}`, { headers: cookie }, { env })
    expect(res.status).toBe(200)
    const body = await json<{ decisions: { key: string; request: unknown }[] }>(res)
    expect(body.decisions).toHaveLength(1)
    expect(body.decisions[0]).toMatchObject({ key: 'triage', request: { questions: QUESTIONS } })

    const agui = await json<{ events: unknown[] }>(
      await request(`/api/agents/runs/${runId}/agui`, { headers: cookie }, { env })
    )
    const custom = agui.events
      .map(e => kitAguiEventSchema.parse(e))
      .filter(e => e.type === 'CUSTOM' && e.name === 'kit.agent.decision')
    expect(custom).toHaveLength(1)
  })
})

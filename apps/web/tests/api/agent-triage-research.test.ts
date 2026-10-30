// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the chat and decisions seams), so this file needs its own module registry.
/**
 * `triage-research` end to end over a really-ingested document, with a scripted decisions
 * engine, on all three routes: the screen keeps the passage and the answer cites only kept
 * documents; a screen that keeps nothing answers "not covered" with no model call; an unsure
 * `answerable` escalates to `research-topic`. The `ctx.decide` contract itself is
 * `agent-decisions.test.ts`.
 */
import type { DecisionAnswers, DecisionRequest } from '@rocketflare/shared/ai/decisions'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listArtifacts } from '@/api/services/agents/artifacts'
import { listDecisions } from '@/api/services/agents/decisions'
import { enqueueRun, getRun } from '@/api/services/agents/runs'
import { claimStep, executeRun } from '@/api/services/agents/runtime'
import { AiError } from '@/api/services/ai/errors'
import { ingestText } from '@/api/services/ai/ingest'
import type { ChatClient } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { agentRunDecisions } from '@/db/schema'
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

/** Every noul at `p`, every choice to `pick` — enough for these tests. */
function answerAll(p: number, pick?: string): Decider {
  return req =>
    Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        if (q.type === 'noul') {
          return [id, { type: 'noul', noul: p, confidence: Math.abs(2 * p - 1) }]
        }
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

async function startFor(
  env: TestEnv,
  tenantId: string,
  userId: string,
  agentKey: 'triage-research',
  input: unknown
) {
  const { run } = await enqueueRun(db, loadConfig(env), env, { tenantId, agentKey, input, userId })
  const params = { runId: run.id, tenantId }
  expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
  const outcome = await executeRun(db, loadConfig(env), env, fakeLogger(), params)
  return { outcome, runId: run.id, tenantId, userId }
}

beforeEach(() => {
  // The runtime resolves the agent's chat client before `run()`; a test that never calls it still needs one.
  state.client = new FakeChatClient([], 'anthropic_compatible')
  state.decide = null
  state.asks = 0
})

describe('triage-research', () => {
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

  const QUESTION = 'How long does an access request take?'

  it('answered: keeps the relevant passage and cites only kept documents', async () => {
    const env = createTestEnv()
    const { user, tenant, document } = await tenantWithDocument(env)
    state.decide = answerAll(0.95)
    const client = script([
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: { answer: 'Two working days.', documentIds: [document.id, 'not-a-real-id'] },
          },
        ],
      },
    ])
    const { outcome, runId } = await startFor(env, tenant.id, user.id, 'triage-research', {
      question: QUESTION,
    })
    expect(outcome.status).toBe('succeeded')
    const output = (await getRun(db, tenant.id, runId))?.output
    expect(output).toMatchObject({
      route: 'answered',
      answer: 'Two working days.',
      citations: [{ documentId: document.id, title: 'Onboarding handbook' }],
      kept: 1,
    })
    expect(client.calls).toHaveLength(1)
    // Two decisions: the screen (one request for every passage) and the triage.
    expect((await listDecisions(db, tenant.id, runId)).map(d => d.key)).toEqual([
      'relevant',
      'answerable',
    ])
    expect((await listArtifacts(db, tenant.id, runId)).map(a => a.key)).toEqual(['triage:screen'])
  })

  it('not covered: a screen that keeps nothing answers honestly with no model call', async () => {
    const env = createTestEnv()
    const { user, tenant } = await tenantWithDocument(env)
    state.decide = answerAll(0.05)
    const client = script([])
    const { runId } = await startFor(env, tenant.id, user.id, 'triage-research', {
      question: 'What is the office wifi password?',
    })
    expect((await getRun(db, tenant.id, runId))?.output).toMatchObject({
      route: 'not_covered',
      citations: [],
      kept: 0,
    })
    expect(client.calls).toHaveLength(0)
    expect(
      await db.select().from(agentRunDecisions).where(eq(agentRunDecisions.runId, runId))
    ).toHaveLength(1)
  })

  it('escalated: an unsure answerable hands the case to research-topic', async () => {
    const env = createTestEnv()
    const { user, tenant, document } = await tenantWithDocument(env)
    state.decide = req =>
      'answerable' in req.questions
        ? { answerable: { type: 'noul', noul: 0.55, confidence: 0.1 } }
        : answerAll(0.9)(req)
    const client = script([
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: {
              answer: 'Within two working days.',
              citations: [{ documentId: document.id, title: 'Onboarding handbook' }],
            },
          },
        ],
      },
    ])
    const { outcome, runId } = await startFor(env, tenant.id, user.id, 'triage-research', {
      question: QUESTION,
    })
    expect(outcome.status).toBe('succeeded')
    expect((await getRun(db, tenant.id, runId))?.output).toMatchObject({
      route: 'escalated',
      answer: 'Within two working days.',
    })
    // The research agent's own prompt, not this agent's.
    expect(JSON.stringify(client.calls[0]?.system)).not.toContain('already been screened')
  })
})

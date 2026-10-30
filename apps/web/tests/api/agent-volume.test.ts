// @vitest-isolate
// Mocks `@/api/services/ai/resolve` and swaps an entry of the shared `AGENTS` registry, so this file needs its own module registry.
// Also mocks the plugin barrels to register the fixture agents (tests/helpers/fixture-agents.ts).
/**
 * Agent volume, one seam per describe:
 *   - the exclusive index reads `agent_runs.concurrency_key`: an exclusive agent dedupes, a
 *     non-exclusive one runs side by side, and the two kinds of row never collide;
 *   - the tenant-wide gates: `AGENT_MAX_ACTIVE_RUNS_PER_TENANT` (429 `agent_runs_limit`) and the
 *     daily agent spend (429 `ai_budget_exceeded`);
 *   - `POST /runs/batch`: one `createBatch()`, per-input validation errors, a partial
 *     `create()` failure that fails only its own row, `GET /runs?batchId=`, 400 for an exclusive
 *     agent;
 *   - `ctx.map` / `ctx.scope`: finished items replay after a retry, the concurrency clamp, the
 *     first error stops scheduling, and asks from several items merge into ONE park;
 *   - metering: every model call and decision is one `ai_usage` row carrying the run id, and a
 *     budget trip fails the run with event code `agent_budget_exceeded`;
 *   - replay over a run whose decisions are scoped by `ctx.map`.
 */

import {
  type AgentRun,
  agentRunSchema,
  createAgentRunBatchResponseSchema,
  createAgentRunResponseSchema,
} from '@rocketflare/shared/ai/agents'
import type { DecisionAnswers, DecisionRequest } from '@rocketflare/shared/ai/decisions'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { listInterrupts } from '@/api/services/agents/interrupts'
import { AGENTS, type AgentContext, type AnyAgentDefinition } from '@/api/services/agents/registry'
import { replayRun } from '@/api/services/agents/replay'
import { enqueueRun, getRun, listEvents, requestCancel } from '@/api/services/agents/runs'
import { claimStep, executeRun } from '@/api/services/agents/runtime'
import { runToolLoop, type Tool } from '@/api/services/ai/agent-loop'
import { AiError } from '@/api/services/ai/errors'
import type { ChatClient } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { isUniqueViolation } from '@/db/client'
import { agentRunEffects, agentRuns, aiUsage } from '@/db/schema'
import { FakeChatClient } from '../helpers/ai'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { FIXTURE_AGENT } from '../helpers/fixture-agents'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)
vi.mock('@/plugins/server', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureServer(await importOriginal())
)

const state: { client: ChatClient | null; asks: number } = { client: null, asks: 0 }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => ({
      client: state.client,
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      source: 'tenant' as const,
      maxOutputTokens: 2048,
    })),
    resolveDecisions: vi.fn(async () => ({
      client: {
        provider: 'typesafe' as const,
        method: 'typesafe' as const,
        ask: async (req: DecisionRequest) => {
          state.asks += 1
          return {
            answers: noulAll(req, 0.8),
            usage: { inputTokens: 30, outputTokens: 2 },
            model: 'jev-1',
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

function noulAll(req: DecisionRequest, p: number): DecisionAnswers {
  return Object.fromEntries(
    Object.keys(req.questions).map(id => [
      id,
      { type: 'noul', noul: p, confidence: Math.abs(2 * p - 1) },
    ])
  ) as DecisionAnswers
}

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

const originalAgent = AGENTS[FIXTURE_AGENT]

/** The fixture agent's slot, with any schema, any body and whatever meta the test needs. */
function installAgent(
  run: (ctx: AgentContext) => Promise<unknown>,
  meta: Partial<AnyAgentDefinition['meta']> = {}
): AnyAgentDefinition {
  const agent = {
    meta: { ...originalAgent.meta, inputSchema: z.any(), outputSchema: z.any(), ...meta },
    run,
  } as AnyAgentDefinition
  AGENTS[FIXTURE_AGENT] = agent
  return agent
}

/** A NON-exclusive agent with a real input schema in the fixture agent's slot — what batches take. */
const installBatchable = () =>
  installAgent(async () => ({}), {
    exclusive: false,
    inputSchema: z.object({ question: z.string().min(1) }),
  })

async function actor(role: 'owner' | 'admin' | 'member' = 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function enqueueAndClaim(
  env: TestEnv,
  tenantId: string,
  userId: string,
  input: unknown = {}
) {
  const { run } = await enqueueRun(db, loadConfig(env), env, {
    tenantId,
    agentKey: FIXTURE_AGENT,
    input,
    userId,
  })
  const params = { runId: run.id, tenantId }
  expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
  return params
}

/** The stub binding — always present in a `createTestEnv()` that did not remove it. */
function recorder(env: TestEnv) {
  const workflow = stubs(env).workflow
  if (!workflow) throw new Error('this test needs the AGENT_RUN_WORKFLOW stub')
  return workflow
}

const execute = (env: TestEnv, params: { runId: string; tenantId: string }) =>
  executeRun(db, loadConfig(env), env, fakeLogger(), params)

const ask = (client: ChatClient) =>
  client.complete({
    model: 'claude-sonnet-4-5',
    maxTokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  })

beforeEach(() => {
  state.client = new FakeChatClient(
    [{ text: 'ok', usage: { inputTokens: 40, outputTokens: 10 } }],
    'anthropic'
  )
  state.asks = 0
})

afterEach(() => {
  AGENTS[FIXTURE_AGENT] = originalAgent
})

// ---- the index ---------------------------------------------------------------------------------

describe('exclusive vs non-exclusive', () => {
  it('an exclusive agent dedupes onto its active run; the row says exclusive', async () => {
    const env = createTestEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const input = { tenantId: tenant.id, agentKey: FIXTURE_AGENT, userId: user.id }
    const first = await enqueueRun(db, loadConfig(env), env, { ...input, input: { text: 'one' } })
    const second = await enqueueRun(db, loadConfig(env), env, { ...input, input: { text: 'two' } })
    expect(first.run.concurrencyKey).toBe('')
    expect(second).toMatchObject({ deduplicated: true, run: { id: first.run.id } })
  })

  it('a non-exclusive agent runs side by side, and its rows sit outside the unique index', async () => {
    const env = createTestEnv()
    installAgent(async () => ({}), { exclusive: false })
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const base = { tenantId: tenant.id, agentKey: FIXTURE_AGENT, userId: user.id }
    const a = await enqueueRun(db, loadConfig(env), env, { ...base, input: { n: 1 } })
    const b = await enqueueRun(db, loadConfig(env), env, { ...base, input: { n: 2 } })
    expect(a.deduplicated).toBe(false)
    expect(b.deduplicated).toBe(false)
    expect(a.run.id).not.toBe(b.run.id)
    expect([a.run.concurrencyKey, b.run.concurrencyKey]).toEqual([null, null])

    // The predicate is `concurrency_key IS NOT NULL AND active`: ONE row in the tenant-wide slot
    // may join the two non-exclusive ones for the same agent, and a second one is refused.
    const row = (exclusive: boolean) => ({
      tenantId: tenant.id,
      agentKey: FIXTURE_AGENT,
      status: 'queued' as const,
      input: {},
      concurrencyKey: exclusive ? '' : null,
    })
    await db.insert(agentRuns).values(row(true))
    await db.insert(agentRuns).values(row(false))
    const refused = await db
      .insert(agentRuns)
      .values(row(true))
      .then(
        () => null,
        (err: unknown) => err
      )
    expect(isUniqueViolation(refused)).toBe(true)
  })
})

// ---- tenant-wide gates ------------------------------------------------------------------------

describe('enqueue gates', () => {
  it('429 agent_runs_limit at AGENT_MAX_ACTIVE_RUNS_PER_TENANT, counting every agent', async () => {
    const env = createTestEnv({ AGENT_MAX_ACTIVE_RUNS_PER_TENANT: '2' })
    installBatchable()
    const a = await actor()
    const start = (question: string) =>
      request(
        '/api/agents/runs',
        { method: 'POST', headers: a.cookie },
        { env, json: { agentKey: FIXTURE_AGENT, input: { question } } }
      )
    expect((await start('one')).status).toBe(202)
    expect((await start('two')).status).toBe(202)
    const third = await start('three')
    expect(third.status).toBe(429)
    expect(await json(third)).toMatchObject({
      statusCode: 429,
      code: 'agent_runs_limit',
      details: { active: 2, max: 2 },
    })
  })

  it('an exclusive agent already running is answered, not refused, at the cap', async () => {
    const env = createTestEnv({ AGENT_MAX_ACTIVE_RUNS_PER_TENANT: '1' })
    const a = await actor()
    const start = () =>
      request(
        '/api/agents/runs',
        { method: 'POST', headers: a.cookie },
        { env, json: { agentKey: FIXTURE_AGENT, input: { text: 'Some text.' } } }
      )
    const first = createAgentRunResponseSchema.parse(await json(await start()))
    const again = await start()
    expect(again.status).toBe(202)
    expect(await json(again)).toMatchObject({ id: first.id, deduplicated: true })
  })

  it("429 ai_budget_exceeded once the tenant's agent spend today reaches its cap", async () => {
    const env = createTestEnv({ AGENT_TENANT_DAILY_COST_USD: '5' })
    installBatchable()
    const a = await actor()
    const first = await enqueueRun(db, loadConfig(env), env, {
      tenantId: a.tenant.id,
      agentKey: FIXTURE_AGENT,
      input: { question: 'one' },
      userId: a.user.id,
    })
    // $5.00 already spent today by an agent run in this tenant.
    await db.insert(aiUsage).values({
      tenantId: a.tenant.id,
      agentRunId: first.run.id,
      feature: `agent:${FIXTURE_AGENT}`,
      provider: 'anthropic_compatible',
      model: 'claude-sonnet-4-5',
      costMicrocents: 500_000_000,
    })
    const res = await request(
      '/api/agents/runs',
      { method: 'POST', headers: a.cookie },
      { env, json: { agentKey: FIXTURE_AGENT, input: { question: 'two' } } }
    )
    expect(res.status).toBe(429)
    expect(await json(res)).toMatchObject({
      code: 'ai_budget_exceeded',
      details: { usedUsd: 5, maxUsd: 5 },
    })
  })
})

// ---- batch -------------------------------------------------------------------------------------

describe('POST /api/agents/runs/batch', () => {
  const batch = (cookie: Record<string, string>, env: TestEnv, body: unknown) =>
    request('/api/agents/runs/batch', { method: 'POST', headers: cookie }, { env, json: body })

  it('one createBatch for the valid inputs; an invalid one is an item error with no row', async () => {
    const env = createTestEnv()
    installBatchable()
    const a = await actor()
    const res = await batch(a.cookie, env, {
      agentKey: FIXTURE_AGENT,
      inputs: [{ question: 'first?' }, { question: '' }, { question: 'third?' }],
    })
    expect(res.status).toBe(202)
    const body = createAgentRunBatchResponseSchema.parse(await json(res))
    expect(body).toMatchObject({ agentKey: FIXTURE_AGENT, created: 2, failed: 1 })
    expect(body.items.map(i => i.index)).toEqual([0, 1, 2])
    expect(body.items[1]).toMatchObject({ run: null, error: { code: 'validation_failed' } })
    for (const i of [0, 2]) {
      expect(body.items[i]?.error).toBeNull()
      expect(body.items[i]?.run).toMatchObject({
        status: 'queued',
        exclusive: false,
        batchId: body.batchId,
      })
    }
    const workflow = recorder(env)
    expect(workflow.batches).toEqual([2])
    expect(workflow.created.map(c => c.id)).toEqual([
      body.items[0]?.run?.id,
      body.items[2]?.run?.id,
    ])

    // `?batchId=` lists exactly the batch, for its requester.
    const listed = paginatedResponse(agentRunSchema).parse(
      await json(
        await request(`/api/agents/runs?batchId=${body.batchId}`, { headers: a.cookie }, { env })
      )
    )
    expect(listed.items.map((r: AgentRun) => r.id).sort()).toEqual(
      [body.items[0]?.run?.id, body.items[2]?.run?.id].sort()
    )
  })

  it('a partial create failure fails only its own row; the rest start', async () => {
    const env = createTestEnv()
    installBatchable()
    const a = await actor()
    let calls = 0
    // createBatch fails whole (one bad member); the per-instance fallback fails only the 2nd.
    const workflow = recorder(env)
    let poisoned: string | null = null
    workflow.failCreate = options => {
      calls += 1
      poisoned ??= calls === 2 ? options.id : null
      return options.id === poisoned
    }
    const res = await batch(a.cookie, env, {
      agentKey: FIXTURE_AGENT,
      inputs: [{ question: 'a?' }, { question: 'b?' }, { question: 'c?' }],
    })
    expect(res.status).toBe(202)
    const body = createAgentRunBatchResponseSchema.parse(await json(res))
    expect(body).toMatchObject({ created: 2, failed: 1 })
    expect(workflow.batches).toEqual([])
    expect(body.items[1]).toMatchObject({
      error: { code: 'workflow_create_failed' },
      run: { status: 'failed' },
    })
    expect(body.items[1]?.run?.error).toMatch(/Could not start the workflow/)
    expect([body.items[0]?.run?.status, body.items[2]?.run?.status]).toEqual(['queued', 'queued'])
    expect(workflow.created.map(c => c.id)).toEqual([
      body.items[0]?.run?.id,
      body.items[2]?.run?.id,
    ])
  })

  it('400 agent_exclusive for an exclusive agent, 429 over the cap, 401 anon — and no rows', async () => {
    const env = createTestEnv({ AGENT_MAX_ACTIVE_RUNS_PER_TENANT: '2' })
    const a = await actor()
    const exclusive = await batch(a.cookie, env, {
      agentKey: FIXTURE_AGENT,
      inputs: [{ text: 'x' }],
    })
    expect(exclusive.status).toBe(400)
    expect(await json(exclusive)).toMatchObject({ statusCode: 400, code: 'agent_exclusive' })

    installBatchable()
    const over = await batch(a.cookie, env, {
      agentKey: FIXTURE_AGENT,
      inputs: [{ question: '1' }, { question: '2' }, { question: '3' }],
    })
    expect(over.status).toBe(429)
    expect(await json(over)).toMatchObject({ code: 'agent_runs_limit' })
    expect(
      await db.query.agentRuns.findMany({ where: eq(agentRuns.tenantId, a.tenant.id) })
    ).toEqual([])
    expect(recorder(env).created).toEqual([])

    const tooMany = await batch(a.cookie, env, {
      agentKey: FIXTURE_AGENT,
      inputs: Array.from({ length: 101 }, (_, i) => ({ question: `${i}` })),
    })
    expect(tooMany.status).toBe(400)

    const anon = await request(
      '/api/agents/runs/batch',
      { method: 'POST' },
      { env, json: { agentKey: FIXTURE_AGENT, inputs: [{ question: 'x' }] } }
    )
    expect(anon.status).toBe(401)
  })

  it("another tenant's batch id lists nothing", async () => {
    const env = createTestEnv()
    installBatchable()
    const a = await actor()
    const b = await actor('owner')
    const body = createAgentRunBatchResponseSchema.parse(
      await json(
        await batch(a.cookie, env, { agentKey: FIXTURE_AGENT, inputs: [{ question: 'x' }] })
      )
    )
    const listed = paginatedResponse(agentRunSchema).parse(
      await json(
        await request(`/api/agents/runs?batchId=${body.batchId}`, { headers: b.cookie }, { env })
      )
    )
    expect(listed.items).toEqual([])
  })
})

// ---- fan-out -----------------------------------------------------------------------------------

describe('ctx.map / ctx.scope', () => {
  it('a retried step replays the items that finished and runs only the rest', async () => {
    const env = createTestEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const started: number[] = []
    let failOn: number | null = 3
    installAgent(async ctx =>
      ctx.map(
        'items',
        [0, 1, 2, 3, 4],
        async (n, item) => {
          started.push(n)
          if (n === failOn) {
            failOn = null
            throw new AiError('unavailable', 'anthropic_compatible', 'provider overloaded')
          }
          return item.once('double', async () => n * 2)
        },
        { concurrency: 1 }
      )
    )
    const params = await enqueueAndClaim(env, tenant.id, user.id)

    await expect(execute(env, params)).rejects.toThrow(/overloaded/)
    expect(started).toEqual([0, 1, 2, 3])

    const outcome = await execute(env, params)
    expect(outcome.status).toBe('succeeded')
    // Items 0–2 were served from the record; only 3 and 4 ran again.
    expect(started).toEqual([0, 1, 2, 3, 3, 4])
    expect((await getRun(db, tenant.id, params.runId))?.output).toEqual([0, 2, 4, 6, 8])
    const keys = (
      await db.query.agentRunEffects.findMany({ where: eq(agentRunEffects.runId, params.runId) })
    ).map(e => e.key)
    expect(keys).toEqual(
      expect.arrayContaining(['items[0]', 'items[0]/double', 'items[4]', 'items[4]/double'])
    )
  })

  it('clamps concurrency to 6, and the first error stops scheduling', async () => {
    const env = createTestEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    let inFlight = 0
    let begun = 0
    let peak = 0
    installAgent(async ctx =>
      ctx.map(
        'wide',
        Array.from({ length: 20 }, (_, i) => i),
        async n => {
          inFlight += 1
          begun += 1
          peak = Math.max(peak, inFlight)
          // Hold every item until the map has as many in flight as it will ever allow (or has
          // started them all), so the peak is the clamp rather than the scheduler's timing.
          while (inFlight < 6 && begun < 20) await new Promise(r => setTimeout(r, 1))
          await new Promise(r => setTimeout(r, 1))
          inFlight -= 1
          return n
        },
        { concurrency: 50 }
      )
    )
    expect((await execute(env, await enqueueAndClaim(env, tenant.id, user.id))).status).toBe(
      'succeeded'
    )
    expect(peak).toBe(6)

    const started: number[] = []
    installAgent(async ctx =>
      ctx.map(
        'stop',
        Array.from({ length: 10 }, (_, i) => i),
        async n => {
          started.push(n)
          if (n === 1) throw new Error('item 1 is broken')
          await new Promise(resolve => setTimeout(resolve, 10))
          return n
        },
        { concurrency: 2 }
      )
    )
    const other = await createTestTenantWithUser(db, 'member')
    const outcome = await execute(env, await enqueueAndClaim(env, other.tenant.id, other.user.id))
    expect(outcome).toMatchObject({ status: 'failed', error: 'item 1 is broken' })
    // Item 0 was in flight and finished; nothing after the failure was started.
    expect(started.sort()).toEqual([0, 1])
  })

  it('asks raised by several items become ONE park, keyed by scope', async () => {
    const env = createTestEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    installAgent(async ctx =>
      ctx.map('approve', ['a', 'b', 'c'], async (id, item) => {
        const answer = await item.interrupt({
          key: 'ok',
          spec: { kind: 'approval', title: `Approve ${id}`, message: `Go ahead with ${id}?` },
        })
        return answer.status
      })
    )
    const params = await enqueueAndClaim(env, tenant.id, user.id)
    const outcome = await execute(env, params)
    expect(outcome.status).toBe('awaiting_input')
    expect(outcome.interruptIds).toHaveLength(3)
    const asks = await listInterrupts(db, tenant.id, params.runId)
    expect(asks.map(i => i.key).sort()).toEqual(['approve[0]/ok', 'approve[1]/ok', 'approve[2]/ok'])
    expect((await getRun(db, tenant.id, params.runId))?.status).toBe('awaiting_input')
  })

  it('a scope namespaces decisions and artifacts, and a replay serves them by the scoped key', async () => {
    const env = createTestEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const screen = (threshold: number) => async (ctx: AgentContext) => {
      const items = await ctx.once('items', async () => ['alpha', 'beta', 'gamma'])
      const kept = await ctx.map('screen', items, async (item, scope) => {
        const decision = await scope.decide('relevant', {
          state: { item },
          questions: { relevant: { type: 'noul', instructions: 'Is this item relevant?' } },
        })
        return (decision.answers.relevant?.noul ?? 0) >= threshold ? item : null
      })
      return { kept: kept.filter(Boolean) }
    }
    const agent = installAgent(screen(0.5))
    const params = await enqueueAndClaim(env, tenant.id, user.id)
    expect((await execute(env, params)).status).toBe('succeeded')
    expect(state.asks).toBe(3)
    const decisions = await db.query.agentRunDecisions.findMany({
      where: (t, { eq: is }) => is(t.runId, params.runId),
    })
    expect(decisions.map(d => d.key).sort()).toEqual([
      'screen[0]/relevant',
      'screen[1]/relevant',
      'screen[2]/relevant',
    ])

    const row = await getRun(db, tenant.id, params.runId)
    if (!row) throw new Error('run vanished')
    const same = await replayRun(db, loadConfig(env), env, row, agent, { logger: fakeLogger() })
    expect(same.verdict).toBe('match')
    expect(same.decisions.map(d => [d.key, d.status]).sort()).toEqual([
      ['screen[0]/relevant', 'served'],
      ['screen[1]/relevant', 'served'],
      ['screen[2]/relevant', 'served'],
    ])
    expect(state.asks).toBe(3) // strict: nothing asked

    // A stricter threshold inside the item: the replay RE-RUNS the items (their recorded results
    // are only a cache), so the change shows up as a different output.
    const stricter = { ...agent, run: screen(0.9) } as AnyAgentDefinition
    const changed = await replayRun(db, loadConfig(env), env, row, stricter, {
      logger: fakeLogger(),
    })
    expect(changed.verdict).toBe('differs')
    expect(changed.outputDiff[0]).toMatchObject({ path: '$.kept[0]', recorded: 'alpha' })
  })
})

// ---- metering and budgets ---------------------------------------------------------------------

describe('usage per run and budgets', () => {
  it('every model call and decision is one ai_usage row carrying the run id', async () => {
    const env = createTestEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    installAgent(async ctx => {
      await ask(ctx.chat.client)
      await ask(ctx.chat.client)
      await ctx.decide('urgent', {
        state: { text: 'x' },
        questions: { urgent: { type: 'noul', instructions: 'Urgent?' } },
      })
      await ctx.recordUsage({
        provider: 'anthropic_compatible',
        model: 'claude-sonnet-4-5',
        usage: { inputTokens: 5, outputTokens: 5 },
        feature: `agent:${FIXTURE_AGENT}:own-client`,
      })
      return {}
    })
    const params = await enqueueAndClaim(env, tenant.id, user.id)
    expect((await execute(env, params)).status).toBe('succeeded')
    const rows = await db.query.aiUsage.findMany({ where: eq(aiUsage.tenantId, tenant.id) })
    expect(rows.every(r => r.agentRunId === params.runId)).toBe(true)
    expect(rows.map(r => r.feature).sort()).toEqual([
      `agent:${FIXTURE_AGENT}`,
      `agent:${FIXTURE_AGENT}`,
      `agent:${FIXTURE_AGENT}:decide`,
      `agent:${FIXTURE_AGENT}:own-client`,
    ])
    // A priced model has its cost frozen on the row; TypeSafe has none and counts tokens only.
    expect(rows.find(r => r.feature === `agent:${FIXTURE_AGENT}`)?.costMicrocents).toBeGreaterThan(
      0
    )
    expect(rows.find(r => r.feature.endsWith(':decide'))?.costMicrocents).toBeNull()

    // GET /runs/:id reports the sum.
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const body = (await json(
      await request(`/api/agents/runs/${params.runId}`, { headers: cookie }, { env })
    )) as { usage: { calls: number; inputTokens: number; outputTokens: number } }
    expect(body.usage).toMatchObject({ calls: 4, inputTokens: 40 + 40 + 30 + 5, outputTokens: 27 })
  })

  it('a run over AGENT_RUN_MAX_TOKENS fails with agent_budget_exceeded and the call is not made', async () => {
    const env = createTestEnv({ AGENT_RUN_MAX_TOKENS: '100' })
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const client = state.client as FakeChatClient
    installAgent(async ctx => {
      for (let i = 0; i < 5; i++) await ask(ctx.chat.client)
      return {}
    })
    const params = await enqueueAndClaim(env, tenant.id, user.id)
    const outcome = await execute(env, params)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/token budget \(100 of 100 tokens\)/)
    // 50 + 50 = 100 spent: the third call is refused BEFORE it reaches the provider.
    expect(client.calls).toHaveLength(2)
    const events = await listEvents(db, tenant.id, params.runId)
    expect(events.find(e => e.type === 'error')?.data).toMatchObject({
      code: 'agent_budget_exceeded',
      willRetry: false,
      details: { limit: 'run_tokens', used: 100, max: 100 },
    })
    expect(
      await db.query.aiUsage.findMany({ where: eq(aiUsage.agentRunId, params.runId) })
    ).toHaveLength(2)
  })

  it("meta.budget overrides the deployment's cap, and a retry does not reset the budget", async () => {
    const env = createTestEnv({ AGENT_RUN_MAX_TOKENS: '100000' })
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    let attempt = 0
    installAgent(
      async ctx => {
        attempt += 1
        if (attempt === 1) {
          await ask(ctx.chat.client)
          throw new AiError('rate_limit', 'anthropic_compatible', 'slow down')
        }
        await ask(ctx.chat.client)
        await ask(ctx.chat.client)
        return {}
      },
      { budget: { maxTokens: 60 } }
    )
    const params = await enqueueAndClaim(env, tenant.id, user.id)
    await expect(execute(env, params)).rejects.toThrow(/slow down/)
    // Attempt 2 starts from attempt 1's 50 tokens, so its FIRST call (50 < 60) is allowed and its
    // second (100 ≥ 60) is not. A per-attempt budget would have let both through.
    const outcome = await execute(env, params)
    expect(outcome.status).toBe('failed')
    const events = await listEvents(db, tenant.id, params.runId)
    expect(
      events.find(e => e.type === 'error' && (e.data as { code?: string }).code)?.data
    ).toMatchObject({
      code: 'agent_budget_exceeded',
      details: { limit: 'run_tokens', used: 100, max: 60 },
    })
  })

  it("the tenant's daily cap stops a run that is already going", async () => {
    const env = createTestEnv({ AGENT_TENANT_DAILY_COST_USD: '1' })
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    installAgent(async ctx => ask(ctx.chat.client))
    const params = await enqueueAndClaim(env, tenant.id, user.id)
    await db.insert(aiUsage).values({
      tenantId: tenant.id,
      agentRunId: params.runId,
      feature: `agent:${FIXTURE_AGENT}`,
      provider: 'anthropic_compatible',
      model: 'claude-sonnet-4-5',
      costMicrocents: 100_000_000,
    })
    const outcome = await execute(env, params)
    expect(outcome.status).toBe('failed')
    const events = await listEvents(db, tenant.id, params.runId)
    expect(events.find(e => e.type === 'error')?.data).toMatchObject({
      code: 'agent_budget_exceeded',
      details: { limit: 'tenant_daily_cost' },
    })
    const spent = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.tenantId, tenant.id), eq(aiUsage.agentRunId, params.runId)))
    expect(spent).toHaveLength(1)
  })
})

// ---- policy and usage per turn -----------------------------------------------------------------

describe('policy and per-turn usage', () => {
  const lookup = {
    name: 'lookup',
    description: 'Look something up',
    schema: z.object({ q: z.string() }),
    handler: async ({ q }: { q: string }) => `found ${q}`,
  } as Tool<{ q: string }>
  const submit: Tool<{ answer: string }> = {
    name: 'submit',
    description: 'Submit the answer',
    schema: z.object({ answer: z.string() }),
  }
  const loopAgent = (policy: NonNullable<AnyAgentDefinition['meta']['policy']>) =>
    installAgent(
      async ctx => {
        const loop = await runToolLoop(ctx.chat.client, {
          model: ctx.chat.model,
          system: 'sys',
          messages: [{ role: 'user', content: 'go' }],
          tools: [lookup as Tool, submit as Tool],
          maxTurns: ctx.cfg.AGENT_MAX_TURNS,
          policy,
          onStep: () => ctx.checkCancelled(),
        })
        return { ...(loop.terminalInput as object), salvaged: loop.salvaged ?? false }
      },
      { policy }
    )

  it("onExhaustion 'fail' settles the run failed with agent_policy_exhausted, never retried", async () => {
    const env = createTestEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    state.client = new FakeChatClient([{ text: 'no tools for me' }], 'anthropic')
    loopAgent({ onExhaustion: 'fail' })
    const params = await enqueueAndClaim(env, tenant.id, user.id)
    const outcome = await execute(env, params)
    expect(outcome.status).toBe('failed')
    const events = await listEvents(db, tenant.id, params.runId)
    expect(events.find(e => e.type === 'error')?.data).toMatchObject({
      code: 'agent_policy_exhausted',
      willRetry: false,
      details: { reason: 'no_tool_call', turns: 1 },
    })
  })

  it("onExhaustion 'final-answer' succeeds with the salvaged answer, and the salvage is metered", async () => {
    const env = createTestEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    state.client = new FakeChatClient(
      [
        {
          toolUses: [{ name: 'lookup', input: { q: 'a' } }],
          usage: { inputTokens: 10, outputTokens: 1 },
        },
        {
          toolUses: [{ name: 'submit', input: { answer: 'salvaged' } }],
          usage: { inputTokens: 20, outputTokens: 2 },
        },
      ],
      'anthropic'
    )
    loopAgent({ maxTurns: 1 })
    const params = await enqueueAndClaim(env, tenant.id, user.id)
    expect((await execute(env, params)).status).toBe('succeeded')
    const run = await getRun(db, tenant.id, params.runId)
    expect(run?.output).toEqual({ answer: 'salvaged', salvaged: true })
    const rows = await db.query.aiUsage.findMany({ where: eq(aiUsage.agentRunId, params.runId) })
    expect(rows.map(r => r.inputTokens).sort()).toEqual([10, 20])
  })

  it('a run cancelled mid-loop keeps a usage row for every turn it paid for', async () => {
    const env = createTestEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const turn = {
      toolUses: [{ name: 'lookup', input: { q: 'x' } }],
      usage: { inputTokens: 7, outputTokens: 1 },
    }
    state.client = new FakeChatClient([turn, turn, turn, turn], 'anthropic')
    let turns = 0
    installAgent(async ctx => {
      await runToolLoop(ctx.chat.client, {
        model: ctx.chat.model,
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        tools: [lookup as Tool, submit as Tool],
        maxTurns: 10,
        onStep: async () => {
          turns += 1
          if (turns === 2) await requestCancel(db, tenant.id, ctx.runId)
          await ctx.checkCancelled()
        },
      })
      return {}
    })
    const params = await enqueueAndClaim(env, tenant.id, user.id)
    expect((await execute(env, params)).status).toBe('cancelled')
    const rows = await db.query.aiUsage.findMany({ where: eq(aiUsage.agentRunId, params.runId) })
    expect(rows).toHaveLength(2)
  })
})

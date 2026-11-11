// @vitest-isolate
// Mocks the plugin barrels to register the fixture agents (tests/helpers/fixture-agents.ts).
/**
 * What a run's budget measures. The token budget counts every token the provider processed,
 * prompt-cache reads and writes included. A cost cap can only hold a model it can price, so an
 * unpriced model the deployment pays for is refused before the call; a tenant's own key is not.
 * `ctx.decide`'s chat fallback is metered the same way, call by call, on who pays for ITS model.
 */
import { DEFAULT_MODELS } from '@rocketflare/shared/ai/config'
import { priceFor } from '@rocketflare/shared/ai/pricing'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  AgentBudgetExceededError,
  budgetFor,
  createRunMeter,
  meterChatClient,
} from '@/api/services/agents/budget'
import { AGENTS, type AgentContext, type AnyAgentDefinition } from '@/api/services/agents/registry'
import { enqueueRun } from '@/api/services/agents/runs'
import { claimStep, executeRun } from '@/api/services/agents/runtime'
import { DECIDE_TOOL } from '@/api/services/ai/decisions/llm'
import { resolveChat } from '@/api/services/ai/resolve'
import { runSpend } from '@/api/services/ai/usage'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { agentModels, agentRuns, aiUsage } from '@/db/schema'
import { FakeChatClient, scriptPlatformChat } from '../../helpers/ai'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { FIXTURE_AGENT } from '../../helpers/fixture-agents'
import { request } from '../../helpers/request'
import { createTestEnv, type TestEnv } from '../../mocks/bindings'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)
vi.mock('@/plugins/server', async importOriginal =>
  (await import('../../helpers/fixture-agents')).withFixtureServer(await importOriginal())
)

const db = setupTestDatabase()
function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger
}
const logger = fakeLogger()

async function fixtureRun() {
  const { tenant, user } = await createTestTenantWithUser(db, 'admin')
  const [run] = await db
    .insert(agentRuns)
    .values({
      tenantId: tenant.id,
      agentKey: FIXTURE_AGENT,
      status: 'running',
      input: { text: 'x' },
      requestedByUserId: user.id,
    })
    .returning()
  if (!run) throw new Error('fixture insert failed')
  return { tenant, user, run }
}

const CACHED_CALL = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-4-5',
  usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 400_000, cacheWriteTokens: 100_000 },
}

describe('the run token budget', () => {
  const meterFor = (f: Awaited<ReturnType<typeof fixtureRun>>) =>
    createRunMeter({
      billedToPlatform: true,
      db,
      tenantId: f.tenant.id,
      runId: f.run.id,
      userId: f.user.id,
      agentKey: FIXTURE_AGENT,
      budget: { maxTokens: 1000 },
      logger,
    })

  it('counts prompt-cache tokens toward the cap', async () => {
    const meter = await meterFor(await fixtureRun())
    await meter.record(CACHED_CALL)
    await expect(meter.check()).rejects.toThrow(AgentBudgetExceededError)
  })

  it('a later attempt restarts from the same full count', async () => {
    const fixture = await fixtureRun()
    await (await meterFor(fixture)).record(CACHED_CALL)
    const spend = await runSpend(db, fixture.tenant.id, fixture.run.id)
    expect(spend).toMatchObject({ cacheReadTokens: 400_000, cacheWriteTokens: 100_000 })
    await expect((await meterFor(fixture)).check()).rejects.toThrow(AgentBudgetExceededError)
  })
})

describe('a cost cap and a model the price table cannot cost', () => {
  const env = createTestEnv({
    ANTHROPIC_API_KEY: 'test-platform-key',
    AGENT_RUN_MAX_COST_USD: '0.01',
    AGENT_TENANT_DAILY_COST_USD: '0.01',
  })
  const cfg = loadConfig(env)
  const UNPRICED = 'claude-3-7-sonnet-20250219'
  const PROMPT_KEY = 'agent-decide'
  const BIG = { inputTokens: 100_000, outputTokens: 50_000 }

  async function complete(model: string, budget = budgetFor(cfg), billedToPlatform = true) {
    const { tenant, user, run } = await fixtureRun()
    const meter = await createRunMeter({
      db,
      tenantId: tenant.id,
      runId: run.id,
      userId: user.id,
      agentKey: FIXTURE_AGENT,
      budget,
      billedToPlatform,
      logger,
    })
    const fake = new FakeChatClient([{ text: 'ok', usage: BIG }], 'anthropic')
    const outcome = await meterChatClient(fake, meter)
      .complete({ model, maxTokens: 64, messages: [{ role: 'user', content: 'go' }] })
      .catch(err => err as Error)
    return { outcome, fake, runId: run.id }
  }

  it('refuses a pinned unpriced model on the platform key before calling it', async () => {
    expect(priceFor('anthropic', UNPRICED)).toBeNull()
    const { user, tenant } = await createTestTenantWithUser(db, 'admin')
    const headers = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const put = await request(
      `/api/ai/agent-models/${PROMPT_KEY}`,
      { method: 'PUT', headers },
      { env, json: { model: UNPRICED } }
    )
    expect(put.status).toBe(200)
    const resolved = await resolveChat(db, cfg, env, tenant.id, { promptKey: PROMPT_KEY })
    expect(resolved.model).toBe(UNPRICED)
    expect(resolved.billedToPlatform).toBe(true)

    const { outcome, fake, runId } = await complete(resolved.model)
    expect(outcome).toBeInstanceOf(AgentBudgetExceededError)
    expect((outcome as AgentBudgetExceededError).limit).toBe('unpriced_model')
    expect(fake.calls).toHaveLength(0)
    expect(await db.query.aiUsage.findMany({ where: eq(aiUsage.agentRunId, runId) })).toEqual([])
  })

  it("calls an unpriced model on a tenant's own key under the cap", async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'admin')
    const headers = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const created = await request(
      '/api/ai/config',
      { method: 'POST', headers },
      {
        env,
        json: {
          label: 'Own key',
          provider: 'anthropic',
          model: UNPRICED,
          apiKey: 'sk-ant-own-0123456789abcdef',
        },
      }
    )
    expect(created.status).toBe(201)
    const resolved = await resolveChat(db, cfg, env, tenant.id)
    expect(resolved.model).toBe(UNPRICED)
    expect(resolved.billedToPlatform).toBe(false)

    const { outcome, fake } = await complete(resolved.model, budgetFor(cfg), false)
    expect(outcome).not.toBeInstanceOf(Error)
    expect(fake.calls).toHaveLength(1)
  })

  it('still calls a priced model under the cap', async () => {
    const { outcome, fake } = await complete(DEFAULT_MODELS.anthropic)
    expect(outcome).not.toBeInstanceOf(Error)
    expect(fake.calls).toHaveLength(1)
  })

  it('leaves an unpriced model alone when no cost cap is set', async () => {
    const { outcome, fake } = await complete(UNPRICED, { maxTokens: 1_000_000 })
    expect(outcome).not.toBeInstanceOf(Error)
    expect(fake.calls).toHaveLength(1)
  })
})

describe("ctx.decide's chat fallback under the run meter", () => {
  // No tenant config and no TypeSafe key anywhere: decisions fall back to the platform chat model
  // (Workers AI here), which the deployment pays for — under a cost cap.
  const env = () =>
    createTestEnv({
      ANTHROPIC_API_KEY: undefined,
      TYPESAFE_API_KEY: undefined,
      AGENT_RUN_MAX_COST_USD: '1',
    })
  const UNPRICED_WORKERS_MODEL = '@cf/example/unpriced-model'
  const QUESTIONS = { urgent: { type: 'noul' as const, instructions: 'Is this urgent?' } }
  const originalAgent = AGENTS[FIXTURE_AGENT]

  afterEach(() => {
    AGENTS[FIXTURE_AGENT] = originalAgent
  })

  function decidingAgent(): void {
    AGENTS[FIXTURE_AGENT] = {
      meta: { ...originalAgent.meta, inputSchema: z.any(), outputSchema: z.any() },
      run: async (ctx: AgentContext) => {
        const d = await ctx.decide('triage', { state: 'charged twice', questions: QUESTIONS })
        return { urgent: d.answers.urgent?.noul }
      },
    } as AnyAgentDefinition
  }

  async function runIt(testEnv: TestEnv, pinDecideModel?: string) {
    const { tenant, user } = await createTestTenantWithUser(db, 'admin')
    if (pinDecideModel) {
      await db
        .insert(agentModels)
        .values({ tenantId: tenant.id, promptKey: 'agent-decide', model: pinDecideModel })
    }
    const cfg = loadConfig(testEnv)
    const { run } = await enqueueRun(db, cfg, testEnv, {
      tenantId: tenant.id,
      agentKey: FIXTURE_AGENT,
      input: { text: 'x' },
      userId: user.id,
    })
    const params = { runId: run.id, tenantId: tenant.id }
    expect(await claimStep(db, testEnv, logger, params)).toBe(true)
    const outcome = await executeRun(db, cfg, testEnv, logger, params)
    const usage = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.tenantId, tenant.id), eq(aiUsage.agentRunId, run.id)))
    return { outcome, usage }
  }

  it('refuses a pinned unpriced decide model on the platform key before calling it', async () => {
    expect(priceFor('workers_ai', UNPRICED_WORKERS_MODEL)).toBeNull()
    decidingAgent()
    const testEnv = env()
    const calls = scriptPlatformChat(testEnv, [
      { toolCalls: [{ name: DECIDE_TOOL, input: { urgent: { p_yes: 0.9 } } }] },
    ])
    const { outcome, usage } = await runIt(testEnv, UNPRICED_WORKERS_MODEL)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('no known price')
    expect(calls).toHaveLength(0)
    expect(usage).toEqual([])
  })

  it('ledgers both calls of a decide whose answer fails validation twice', async () => {
    decidingAgent()
    const testEnv = env()
    const calls = scriptPlatformChat(testEnv, [
      {
        toolCalls: [{ name: DECIDE_TOOL, input: { urgent: { p_yes: 7 } } }],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
    ])
    const { outcome, usage } = await runIt(testEnv)
    expect(outcome.status).toBe('failed')
    expect(calls).toHaveLength(2)
    expect(usage).toHaveLength(2)
    expect(usage.every(u => u.feature === `agent:${FIXTURE_AGENT}:decide`)).toBe(true)
    expect(usage.every(u => u.inputTokens === 100 && u.outputTokens === 10)).toBe(true)
  })

  it('counts a priced decide once', async () => {
    decidingAgent()
    const testEnv = env()
    const calls = scriptPlatformChat(testEnv, [
      {
        toolCalls: [{ name: DECIDE_TOOL, input: { urgent: { p_yes: 0.9 } } }],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
    ])
    const { outcome, usage } = await runIt(testEnv)
    expect(outcome.status).toBe('succeeded')
    expect(calls).toHaveLength(1)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      feature: `agent:${FIXTURE_AGENT}:decide`,
      provider: 'workers_ai',
      inputTokens: 100,
      outputTokens: 10,
    })
    expect(usage[0]?.costMicrocents).not.toBeNull()
  })

  it("prices on who pays for the decide model, not the agent's own", async () => {
    const { tenant, user, run } = await fixtureRun()
    const meter = await createRunMeter({
      db,
      tenantId: tenant.id,
      runId: run.id,
      userId: user.id,
      agentKey: FIXTURE_AGENT,
      budget: { maxCostMicrocents: 1_000_000 },
      billedToPlatform: true,
      logger,
    })
    const fake = new FakeChatClient([{ text: 'ok' }], 'workers_ai')
    await meterChatClient(fake, meter, { billedToPlatform: false }).complete({
      model: UNPRICED_WORKERS_MODEL,
      maxTokens: 64,
      messages: [{ role: 'user', content: 'go' }],
    })
    expect(fake.calls).toHaveLength(1)
  })
})

/**
 * What a run's budget measures. The token budget counts every token the provider processed,
 * prompt-cache reads and writes included. A cost cap can only hold a model it can price, so an
 * unpriced model the deployment pays for is refused before the call; a tenant's own key is not.
 */
import { DEFAULT_MODELS } from '@rocketflare/shared/ai/config'
import { priceFor } from '@rocketflare/shared/ai/pricing'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentBudgetExceededError,
  budgetFor,
  createRunMeter,
  meterChatClient,
} from '@/api/services/agents/budget'
import { resolveChat } from '@/api/services/ai/resolve'
import { runSpend } from '@/api/services/ai/usage'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { agentRuns, aiUsage } from '@/db/schema'
import { FakeChatClient } from '../../helpers/ai'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { FIXTURE_AGENT } from '../../helpers/fixture-agents'
import { request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger

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

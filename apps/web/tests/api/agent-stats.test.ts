// @vitest-isolate
// Mocks the plugin barrels to register the fixture agents (tests/helpers/fixture-agents.ts).
/**
 * `GET /api/agents/stats`: one row per registered agent, scoped like the runs list (a member's own
 * runs, an admin's every run), windowed by `?days=`, with tokens and cost from the runs' own
 * `ai_usage` rows — and a `lastRun` that is never a child (the page links straight to it).
 */
import { agentStatsResponseSchema } from '@rocketflare/shared/ai/agents'
import { MICROCENTS_PER_USD } from '@rocketflare/shared/ai/pricing'
import { describe, expect, it, vi } from 'vitest'
import { agentRuns, aiUsage } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { FIXTURE_AGENT, FIXTURE_AGENT_B } from '../helpers/fixture-agents'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)
vi.mock('@/plugins/server', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureServer(await importOriginal())
)

const db = setupTestDatabase()
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

describe('GET /api/agents/stats', () => {
  it('counts, spends and times each agent over the window, in the caller’s scope', async () => {
    const env = createTestEnv()
    const { tenant, user: admin } = await createTestTenantWithUser(db, 'admin')
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, tenant.id, 'member')
    const run = async (values: Partial<typeof agentRuns.$inferInsert>) =>
      (
        await db
          .insert(agentRuns)
          .values({ tenantId: tenant.id, agentKey: FIXTURE_AGENT, input: {}, ...values })
          .returning()
      )[0] as typeof agentRuns.$inferSelect
    const mine = await run({
      requestedByUserId: member.id,
      status: 'succeeded',
      createdAt: minutesAgo(30),
      startedAt: minutesAgo(30),
      finishedAt: minutesAgo(29),
    })
    await run({
      requestedByUserId: admin.id,
      status: 'failed',
      createdAt: minutesAgo(20),
      finishedAt: minutesAgo(19),
    })
    const newest = await run({
      requestedByUserId: admin.id,
      status: 'running',
      createdAt: minutesAgo(10),
    })
    // A child is newer still, but never the "last run".
    await run({
      requestedByUserId: admin.id,
      status: 'queued',
      parentRunId: newest.id,
      createdAt: minutesAgo(5),
    })
    // Outside a 1-day window, but still a last run if it were the newest.
    await run({
      requestedByUserId: admin.id,
      status: 'succeeded',
      createdAt: minutesAgo(3 * 24 * 60),
    })
    await db.insert(aiUsage).values({
      tenantId: tenant.id,
      agentRunId: mine.id,
      feature: 'agent',
      provider: 'anthropic',
      model: 'm',
      inputTokens: 100,
      outputTokens: 50,
      costMicrocents: (2 * MICROCENTS_PER_USD) / 100,
    })

    const get = async (userId: string, days = 1) => {
      const cookie = sessionCookieHeader(await createTestSession(db, userId, tenant.id))
      const res = await request(`/api/agents/stats?days=${days}`, { headers: cookie }, { env })
      expect(res.status).toBe(200)
      const body = agentStatsResponseSchema.parse(await json(res))
      return {
        a: body.items.find(i => i.agentKey === FIXTURE_AGENT),
        b: body.items.find(i => i.agentKey === FIXTURE_AGENT_B),
      }
    }

    const asAdmin = await get(admin.id)
    expect(asAdmin.a).toMatchObject({ runs: 4, succeeded: 1, failed: 1, active: 2, tokens: 150 })
    expect(asAdmin.a?.costUsd).toBeCloseTo(0.02)
    expect(asAdmin.a?.avgDurationMs).toBeGreaterThan(55_000)
    expect(asAdmin.a?.lastRun?.id).toBe(newest.id)
    // An agent nobody ran is still listed, empty.
    expect(asAdmin.b).toMatchObject({ runs: 0, tokens: 0, lastRun: null, avgDurationMs: null })

    const asMember = await get(member.id)
    expect(asMember.a).toMatchObject({ runs: 1, succeeded: 1, failed: 0, tokens: 150 })
    expect(asMember.a?.lastRun?.id).toBe(mine.id)

    expect((await get(admin.id, 7)).a?.runs).toBe(5)
  })
})

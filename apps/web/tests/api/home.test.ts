/**
 * `GET /api/home/summary`: every part tenant-scoped, and each part decided by the reader's
 * permissions — a member sees only their own runs, only the documents they may open, and no
 * activity, invitations or spend; spend appears only with a daily budget set.
 */
import type { AgentKey } from '@rocketflare/shared/ai/agents'
import { homeSummarySchema } from '@rocketflare/shared/home'
import { describe, expect, it } from 'vitest'
import { activityEvents, agentRuns, aiUsage, documents } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
/** An opaque key no registry knows: Home falls back to the key as the title. */
const AGENT = 'home-summary-agent' as AgentKey

async function summary(cookie: Record<string, string>, env = createTestEnv()) {
  const res = await request('/api/home/summary', { headers: cookie }, { env })
  expect(res.status).toBe(200)
  return homeSummarySchema.parse(await json(res))
}

async function workspace() {
  const { user: owner, tenant } = await createTestTenantWithUser(db, 'owner')
  const member = await createTestUser(db, { name: 'Mia Member' })
  await linkUserToTenant(db, member.id, tenant.id, 'member')
  const ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenant.id))
  const memberCookie = sessionCookieHeader(await createTestSession(db, member.id, tenant.id))
  return { owner, member, tenant, ownerCookie, memberCookie }
}

describe('GET /api/home/summary', () => {
  it('answers 401 without a session', async () => {
    expect((await request('/api/home/summary')).status).toBe(401)
  })

  it('gives an owner every part, counted by day and outcome', async () => {
    const { owner, tenant, ownerCookie } = await workspace()
    const today = new Date()
    await db.insert(agentRuns).values([
      {
        tenantId: tenant.id,
        agentKey: AGENT,
        status: 'succeeded',
        input: {},
        requestedByUserId: owner.id,
      },
      {
        tenantId: tenant.id,
        agentKey: AGENT,
        status: 'failed',
        error: 'The model refused',
        input: { topic: '## Supply-chain risk in Q4\nmore detail' },
        requestedByUserId: owner.id,
      },
      // Three weeks ago: the fortnight before, not this one.
      {
        tenantId: tenant.id,
        agentKey: AGENT,
        status: 'succeeded',
        input: {},
        requestedByUserId: owner.id,
        createdAt: new Date(Date.now() - 21 * 86_400_000),
      },
    ])
    await db
      .insert(documents)
      .values({ tenantId: tenant.id, title: 'Handbook', ownerUserId: owner.id, status: 'indexed' })
    await request(
      '/api/invitations',
      { method: 'POST', headers: ownerCookie },
      { json: { email: `home_${Date.now()}@example.test` } }
    )

    // Someone outside the team (a platform admin) acting here is not named on Home.
    const outsider = await createTestUser(db, { name: 'Platform Admin' })
    await db.insert(activityEvents).values({
      tenantId: tenant.id,
      userId: outsider.id,
      type: 'ai_config.created',
      metadata: { scope: 'chat' },
    })

    const body = await summary(ownerCookie)
    expect(body.chat).not.toBeNull()
    const days = body.agents?.days ?? []
    expect(days).toHaveLength(14)
    expect(days.at(-1)).toMatchObject({
      date: today.toISOString().slice(0, 10),
      succeeded: 1,
      failed: 1,
    })
    expect(body.agents?.recent.map(r => r.status).sort()).toEqual([
      'failed',
      'succeeded',
      'succeeded',
    ])
    expect(body.agents?.recent.find(r => r.status === 'failed')).toMatchObject({
      error: 'The model refused',
      agentTitle: AGENT,
      subject: 'Supply-chain risk in Q4',
      requestedBy: { name: owner.name },
      tokens: null,
      costUsd: null,
    })
    expect(body.agents?.previous).toEqual({ runs: 1, succeeded: 1 })
    expect(body.agents?.byAgent).toEqual([
      expect.objectContaining({ agentKey: AGENT, runs: 2, failed: 1 }),
    ])
    expect(body.agents?.byAgent[0]?.daily.at(-1)).toBe(2)
    expect(body.knowledge).toMatchObject({ total: 1, pending: 0 })
    expect(body.knowledge?.recent[0]).toMatchObject({ title: 'Handbook', factCount: null })
    expect(body.team).toMatchObject({ total: 2, roles: { owner: 1, admin: 0, member: 1 } })
    expect(body.team?.invitations?.total).toBe(1)
    expect(body.activity?.map(a => a.type)).toContain('member.invited')
    expect(body.activity?.find(a => a.type === 'member.invited')?.actor?.name).toBe(owner.name)
    expect(body.activity?.find(a => a.type === 'ai_config.created')?.actor).toBeNull()
    // No budget configured → nothing to measure spend against.
    expect(body.spend).toBeNull()
  })

  it('narrows a member to their own runs and visible documents, without admin-only parts', async () => {
    const { owner, member, tenant, memberCookie } = await workspace()
    await db.insert(agentRuns).values([
      {
        tenantId: tenant.id,
        agentKey: AGENT,
        status: 'succeeded',
        input: {},
        requestedByUserId: owner.id,
      },
      {
        tenantId: tenant.id,
        agentKey: AGENT,
        status: 'running',
        input: {},
        requestedByUserId: member.id,
      },
    ])
    await db.insert(documents).values([
      { tenantId: tenant.id, title: 'Open to all', ownerUserId: owner.id, status: 'indexed' },
      {
        tenantId: tenant.id,
        title: 'Private to the owner',
        ownerUserId: owner.id,
        status: 'indexed',
        // `groups` with no grant is private: the owner and admins only.
        visibility: 'groups',
      },
    ])

    const body = await summary(memberCookie)
    expect(body.agents?.recent.map(r => r.status)).toEqual(['running'])
    expect(body.agents?.days.at(-1)).toMatchObject({ succeeded: 0, active: 1 })
    expect(body.knowledge?.total).toBe(1)
    expect(body.knowledge?.recent.map(d => d.title)).toEqual(['Open to all'])
    expect(body.activity).toBeNull()
    expect(body.spend).toBeNull()
    expect(body.team?.total).toBe(2)
  })

  it('shows spend against a configured budget to an admin, never to a member', async () => {
    const { owner, tenant, ownerCookie, memberCookie } = await workspace()
    const [run] = await db
      .insert(agentRuns)
      .values({
        tenantId: tenant.id,
        agentKey: AGENT,
        status: 'succeeded',
        input: {},
        requestedByUserId: owner.id,
      })
      .returning()
    await db.insert(aiUsage).values({
      tenantId: tenant.id,
      userId: owner.id,
      agentRunId: run?.id,
      provider: 'anthropic',
      model: 'claude-test',
      feature: `agent:${AGENT}`,
      inputTokens: 10,
      outputTokens: 10,
      costMicrocents: 150_000_000,
    })
    const env = createTestEnv({ AGENT_TENANT_DAILY_COST_USD: '5' })

    const body = await summary(ownerCookie, env)
    expect(body.spend?.lines).toHaveLength(1)
    expect(body.spend?.lines[0]).toMatchObject({
      scope: 'agents',
      dailyBudgetUsd: 5,
      todayUsd: 1.5,
    })
    expect(body.spend?.lines[0]?.days).toHaveLength(14)

    expect((await summary(memberCookie, env)).spend).toBeNull()
  })

  it('never shows another tenant’s rows', async () => {
    const mine = await workspace()
    const theirs = await workspace()
    await db.insert(agentRuns).values({
      tenantId: theirs.tenant.id,
      agentKey: AGENT,
      status: 'failed',
      input: {},
      requestedByUserId: theirs.owner.id,
    })
    await db
      .insert(documents)
      .values({ tenantId: theirs.tenant.id, title: 'Theirs', ownerUserId: theirs.owner.id })

    const body = await summary(mine.ownerCookie)
    expect(body.agents?.recent).toEqual([])
    expect(body.knowledge?.total).toBe(0)
    expect(body.team?.total).toBe(2)
  })
})

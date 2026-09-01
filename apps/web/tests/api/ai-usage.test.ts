/**
 * `ai_usage` (D18): `recordUsage` rows, `tapUsage` reports every generation, `summarizeUsage`
 * groups per (provider, model, feature) within a range; `GET /api/ai/usage/summary` is admin+,
 * tenant-scoped, and validates the range.
 */
import { aiUsageSummarySchema } from '@rocketflare/shared/ai/usage'
import { describe, expect, it } from 'vitest'
import { recordUsage, summarizeUsage, tapUsage } from '@/api/services/ai/usage'
import { FakeChatClient } from '../helpers/ai'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()

async function actor(role: 'owner' | 'admin' | 'member' = 'admin') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

describe('usage ledger', () => {
  it('records, taps and summarises per provider/model/feature; other tenants are invisible', async () => {
    const a = await actor()
    const b = await actor()
    await recordUsage(db, {
      tenantId: a.tenant.id,
      userId: a.user.id,
      feature: 'chat',
      provider: 'anthropic',
      model: 'm1',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
    })
    await recordUsage(db, {
      tenantId: a.tenant.id,
      userId: null,
      feature: 'chat',
      provider: 'anthropic',
      model: 'm1',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await recordUsage(db, {
      tenantId: a.tenant.id,
      feature: 'summarize-text',
      provider: 'openai',
      model: 'm2',
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    await recordUsage(db, {
      tenantId: b.tenant.id,
      feature: 'chat',
      provider: 'anthropic',
      model: 'm1',
      usage: { inputTokens: 999, outputTokens: 999 },
    })

    // tapUsage reports the fake client's usage through the callback (complete + stream).
    const seen: number[] = []
    const client = tapUsage(
      new FakeChatClient([
        { text: 'a', usage: { inputTokens: 7, outputTokens: 3 } },
        { text: 'b c', usage: { inputTokens: 4, outputTokens: 2 } },
      ]),
      u => {
        seen.push(u.inputTokens + u.outputTokens)
      }
    )
    await client.complete({ model: 'm', maxTokens: 1, messages: [] })
    for await (const _ of client.stream({ model: 'm', maxTokens: 1, messages: [] })) {
      // drain
    }
    await new Promise(r => setTimeout(r, 0))
    expect(seen).toEqual([10, 6])

    const summary = await summarizeUsage(db, a.tenant.id)
    expect(summary.rows).toEqual([
      {
        provider: 'anthropic',
        model: 'm1',
        feature: 'chat',
        calls: 2,
        inputTokens: 11,
        outputTokens: 6,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        costMicrocents: null,
      },
      {
        provider: 'openai',
        model: 'm2',
        feature: 'summarize-text',
        calls: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicrocents: null,
      },
    ])
    expect(summary.totals).toEqual({
      calls: 3,
      inputTokens: 111,
      outputTokens: 56,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      costMicrocents: null,
    })

    // A range that excludes everything.
    const old = await summarizeUsage(db, a.tenant.id, {
      from: new Date('2000-01-01'),
      to: new Date('2000-02-01'),
    })
    expect(old.rows).toEqual([])
    expect(old.totals.calls).toBe(0)
  })

  it('GET /api/ai/usage/summary: admin+ only, validates the range, parses with the contract', async () => {
    const a = await actor()
    await recordUsage(db, {
      tenantId: a.tenant.id,
      feature: 'chat',
      provider: 'anthropic',
      model: 'm1',
      usage: { inputTokens: 5, outputTokens: 5 },
    })
    const res = await request('/api/ai/usage/summary', { headers: a.cookie })
    expect(res.status).toBe(200)
    const body = aiUsageSummarySchema.parse(await json(res))
    expect(body.totals.calls).toBe(1)
    expect(body.to.getTime() - body.from.getTime()).toBeCloseTo(30 * 24 * 3600 * 1000, -4)

    const ranged = await request(
      `/api/ai/usage/summary?from=${encodeURIComponent('2000-01-01T00:00:00Z')}&to=${encodeURIComponent('2000-01-02T00:00:00Z')}`,
      { headers: a.cookie }
    )
    expect(aiUsageSummarySchema.parse(await json(ranged)).totals.calls).toBe(0)
    const inverted = await request(`/api/ai/usage/summary?from=2001-01-01&to=2000-01-01`, {
      headers: a.cookie,
    })
    expect(inverted.status).toBe(400)
    expect(await json(inverted)).toMatchObject({
      error: expect.any(String),
      statusCode: 400,
      code: 'invalid_range',
    })
    expect(
      (await request('/api/ai/usage/summary?from=not-a-date', { headers: a.cookie })).status
    ).toBe(400)

    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, a.tenant.id, 'member')
    const mc = sessionCookieHeader(await createTestSession(db, member.id, a.tenant.id))
    expect((await request('/api/ai/usage/summary', { headers: mc })).status).toBe(403)
    expect((await request('/api/ai/usage/summary')).status).toBe(401)
  })
})

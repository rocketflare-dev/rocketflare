// @vitest-isolate
/**
 * An exclusive agent's slot is one per tenant, but a run is its requester's: whoever finds the slot
 * taken learns that it is busy, and only the requester or an admin learns which run holds it.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  bearerHeader,
  createTestApiKey,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { FIXTURE_AGENT } from '../../helpers/fixture-agents'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)
vi.mock('@/plugins/server', async importOriginal =>
  (await import('../../helpers/fixture-agents')).withFixtureServer(await importOriginal())
)

const db = setupTestDatabase()
const INPUT = 'Text only its requester should read back'

async function holder() {
  const env = createTestEnv()
  const { user: first, tenant } = await createTestTenantWithUser(db, 'member')
  const firstKey = await createTestApiKey(db, tenant.id, first.id)
  const started = await request(
    '/api/agents/runs',
    { method: 'POST', headers: bearerHeader(firstKey.key) },
    { env, json: { agentKey: FIXTURE_AGENT, input: { text: INPUT } } }
  )
  expect(started.status).toBe(202)
  const run = await json<{ id: string }>(started)
  return { env, first, firstKey, tenant, run }
}

async function colleague(tenantId: string, role: 'member' | 'admin') {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return createTestApiKey(db, tenantId, user.id)
}

const enqueue = (env: ReturnType<typeof createTestEnv>, key: string, query = '') =>
  request(
    `/api/agents/runs${query}`,
    { method: 'POST', headers: bearerHeader(key) },
    { env, json: { agentKey: FIXTURE_AGENT, input: { text: 'Other text' } } }
  )

describe('POST /api/agents/runs on a taken exclusive slot', () => {
  it.each(['', '?strict=1'])('another member gets a bare 409 (query "%s")', async query => {
    const { env, first, tenant, run } = await holder()
    const key = await colleague(tenant.id, 'member')
    const res = await enqueue(env, key.key, query)
    expect(res.status).toBe(409)
    const text = JSON.stringify(await json(res))
    expect(text).toContain('agent_run_active')
    expect(text).not.toContain(run.id)
    expect(text).not.toContain(first.id)
    expect(text).not.toContain(INPUT)
  })

  it('the requester keeps the deduplicated 202 and the strict 409 naming the run', async () => {
    const { env, firstKey, run } = await holder()
    const again = await enqueue(env, firstKey.key)
    expect(again.status).toBe(202)
    expect(await json(again)).toMatchObject({ id: run.id, deduplicated: true })
    const strict = await enqueue(env, firstKey.key, '?strict=1')
    expect(strict.status).toBe(409)
    expect(await json(strict)).toMatchObject({ details: { runId: run.id } })
  })

  it('an admin keeps the deduplicated 202', async () => {
    const { env, tenant, run } = await holder()
    const key = await colleague(tenant.id, 'admin')
    const res = await enqueue(env, key.key)
    expect(res.status).toBe(202)
    expect(await json(res)).toMatchObject({ id: run.id, deduplicated: true })
  })
})

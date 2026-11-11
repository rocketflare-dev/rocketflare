// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the chat provider seam) and the plugin barrels (the fixture
// agents), so this file needs its own module registry.
/**
 * A suspended organisation runs no agents: a run cannot be started for it by a route, a plugin or
 * a batch (403 `tenant_suspended`); a run queued before the suspension settles `cancelled` when
 * its Workflow reaches it, with no model call; and suspending ends the runs nothing is executing.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '@/api/services/agents/registry'
import { enqueueRun, enqueueRunBatch, getRun, listEvents } from '@/api/services/agents/runs'
import { AgentRunWorkflow } from '@/api/workflows/agent-run'
import { loadConfig } from '@/config'
import { agentRuns, tenants } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { FIXTURE_AGENT, FIXTURE_AGENT_B } from '../../helpers/fixture-agents'
import { json, request } from '../../helpers/request'
import { createExecutionContext, createTestEnv, type TestEnv } from '../../mocks/bindings'
import { createFakeWorkflowStep } from '../../mocks/cloudflare-workers'

const resolved = vi.hoisted(() => ({ calls: 0 }))

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)
vi.mock('@/plugins/server', async importOriginal =>
  (await import('../../helpers/fixture-agents')).withFixtureServer(await importOriginal())
)
vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      resolved.calls += 1
      throw new Error('a suspended organisation reached the chat provider')
    }),
  }
})

const db = setupTestDatabase()

const originalB = AGENTS[FIXTURE_AGENT_B]

beforeEach(() => {
  resolved.calls = 0
})

afterEach(() => {
  AGENTS[FIXTURE_AGENT_B] = originalB
})

async function suspend(tenantId: string) {
  await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, tenantId))
}

async function drive(env: TestEnv, runId: string, tenantId: string) {
  const { step } = createFakeWorkflowStep()
  const workflow = new AgentRunWorkflow(createExecutionContext(), env)
  return workflow.run(
    {
      payload: { runId, tenantId },
      timestamp: new Date(),
      instanceId: runId,
      workflowName: 'rocketflare-agent-run',
    },
    step as unknown as Parameters<AgentRunWorkflow['run']>[1]
  )
}

describe('starting a run for a suspended organisation', () => {
  it('the route refuses it and stores no run', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    await suspend(tenant.id)
    const res = await request(
      '/api/agents/runs',
      { method: 'POST', headers: cookie },
      { json: { agentKey: FIXTURE_AGENT, input: { text: 'Some text.' } } }
    )
    expect(res.status).toBe(403)
    expect((await json<{ code: string }>(res)).code).toBe(ERROR_CODES.tenantSuspended)
    expect(await db.select().from(agentRuns).where(eq(agentRuns.tenantId, tenant.id))).toEqual([])
  })

  it('enqueueRun and enqueueRunBatch refuse it with 403 tenant_suspended, creating nothing', async () => {
    const env = createTestEnv()
    const cfg = loadConfig(env)
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    await suspend(tenant.id)
    await expect(
      enqueueRun(db, cfg, env, {
        tenantId: tenant.id,
        agentKey: FIXTURE_AGENT,
        input: { text: 'Some text.' },
        userId: user.id,
      })
    ).rejects.toMatchObject({ statusCode: 403, code: ERROR_CODES.tenantSuspended })
    // A batch takes a non-exclusive agent only.
    AGENTS[FIXTURE_AGENT_B] = { ...originalB, meta: { ...originalB.meta, exclusive: false } }
    await expect(
      enqueueRunBatch(db, cfg, env, {
        tenantId: tenant.id,
        agentKey: FIXTURE_AGENT_B,
        inputs: [{ topic: 'volcanoes' }],
        userId: user.id,
      })
    ).rejects.toMatchObject({ statusCode: 403, code: ERROR_CODES.tenantSuspended })
    expect(await db.select().from(agentRuns).where(eq(agentRuns.tenantId, tenant.id))).toEqual([])
  })
})

describe('a run queued before the suspension', () => {
  it('settles cancelled when executed, with no model call', async () => {
    const env = createTestEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const { run } = await enqueueRun(db, loadConfig(env), env, {
      tenantId: tenant.id,
      agentKey: FIXTURE_AGENT,
      input: { text: 'Some text.' },
      userId: user.id,
    })
    await suspend(tenant.id)

    const outcome = await drive(env, run.id, tenant.id)
    expect(outcome.status).toBe('cancelled')
    expect(resolved.calls).toBe(0)
    expect(await getRun(db, tenant.id, run.id)).toMatchObject({
      status: 'cancelled',
      error: null,
      output: null,
    })
    const events = await listEvents(db, tenant.id, run.id)
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      data: { status: 'cancelled', reason: 'tenant_suspended' },
    })
  })

  it('is cancelled by the suspension itself, and the suspension is reversible', async () => {
    const env = createTestEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const { run } = await enqueueRun(db, loadConfig(env), env, {
      tenantId: tenant.id,
      agentKey: FIXTURE_AGENT,
      input: { text: 'Some text.' },
      userId: user.id,
    })
    const admin = await createTestGlobalAdmin(db)
    const cookie = sessionCookieHeader(await createTestSession(db, admin.id))
    const suspendRoute = (suspended: boolean) =>
      request(
        `/api/admin/tenants/${tenant.id}/suspend`,
        { method: 'POST', headers: cookie },
        { env, json: { suspended } }
      )
    expect((await suspendRoute(true)).status).toBe(200)
    expect((await getRun(db, tenant.id, run.id))?.status).toBe('cancelled')

    expect((await suspendRoute(false)).status).toBe(200)
    const again = await enqueueRun(db, loadConfig(env), env, {
      tenantId: tenant.id,
      agentKey: FIXTURE_AGENT,
      input: { text: 'Some text.' },
      userId: user.id,
    })
    expect(again).toMatchObject({ deduplicated: false, run: { status: 'queued' } })
  })
})

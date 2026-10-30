// @vitest-isolate
// Swaps an entry of the shared `AGENTS` registry, so this file needs its own module registry.
// Also mocks the plugin barrels to register the fixture agents (tests/helpers/fixture-agents.ts).
/**
 * A plugin starting an agent run from a background context — `ctx.startAgentRun` on
 * `JobCtx`, `CronCtx` and `EmailCtx`, through the route's own `enqueueRun`:
 *   - a started run is a `queued` row on the Workflow, nudged, with an activity row; the caller
 *     gets its id; `triggeredBy` is the requester, omitted it is a system run;
 *   - `idempotencyKey`: the same key answers the same run — settled or not, `deduplicated` — while
 *     a different key, or another tenant, is a run of its own; a `create()` failure leaves no row
 *     under the derived id, so the retry starts it; a row whose instance never got created gets one;
 *   - the route's gates apply: input validation, an unknown agent, the active-run cap, a missing
 *     binding (503 before any write);
 *   - `@testkit/unit` records every call and can replace the starter;
 *   - `storage()` on `ToolCtx` and `AgentCtx` is the `FILES` bucket, 503 without it.
 */

import type { AgentKey } from '@rocketflare/shared/ai/agents'
import { makeCronCtx, makeEmailCtx, makeJobCtx, makeToolCtx } from '@testkit/unit'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { traceIdForRun } from '@/api/observability/trace-ids'
import { AGENTS, type AgentContext, type AnyAgentDefinition } from '@/api/services/agents/registry'
import { idempotentRunId } from '@/api/services/agents/runs'
import { activityEvents, agentRuns } from '@/db/schema'
import { agentCtx } from '@/plugins/api/ai'
import type { JobCtx } from '@/plugins/api/jobs'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { FIXTURE_AGENT, FIXTURE_AGENT_B } from '../helpers/fixture-agents'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)
vi.mock('@/plugins/server', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureServer(await importOriginal())
)

const db = setupTestDatabase()

const originalAgent = AGENTS[FIXTURE_AGENT]

/** A non-exclusive agent with a real input schema in the fixture agent's slot. */
function installAgent(meta: Partial<AnyAgentDefinition['meta']> = {}) {
  AGENTS[FIXTURE_AGENT] = {
    meta: {
      ...originalAgent.meta,
      exclusive: false,
      inputSchema: z.object({ documentId: z.string().uuid() }),
      outputSchema: z.any(),
      ...meta,
    },
    run: async () => ({}),
  } as AnyAgentDefinition
}

afterEach(() => {
  AGENTS[FIXTURE_AGENT] = originalAgent
})

function recorder(env: TestEnv) {
  const workflow = stubs(env).workflow
  if (!workflow) throw new Error('this test needs the AGENT_RUN_WORKFLOW stub')
  return workflow
}

const runRow = async (id: string) =>
  (await db.select().from(agentRuns).where(eq(agentRuns.id, id)))[0]

/** The shape of the motivating case: a `receipts.prepare` job, once the document's text is ready. */
async function prepareReceipt(ctx: JobCtx, payload: { tenantId: string; documentId: string }) {
  return ctx.startAgentRun({
    agentKey: FIXTURE_AGENT,
    tenantId: payload.tenantId,
    input: { documentId: payload.documentId },
    idempotencyKey: `receipt:${payload.documentId}`,
  })
}

describe('ctx.startAgentRun', () => {
  it('starts a queued run on the Workflow, nudges, records the activity and answers the id', async () => {
    installAgent()
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const ctx = makeJobCtx({ db, env })
    const documentId = crypto.randomUUID()

    const started = await prepareReceipt(ctx, { tenantId: tenant.id, documentId })

    expect(started).toEqual({ runId: expect.any(String), status: 'queued', deduplicated: false })
    const row = await runRow(started.runId)
    expect(row).toMatchObject({
      tenantId: tenant.id,
      agentKey: FIXTURE_AGENT,
      status: 'queued',
      input: { documentId },
      requestedByUserId: null,
      instanceId: started.runId,
      traceId: traceIdForRun(started.runId),
    })
    expect(recorder(env).created).toEqual([
      { id: started.runId, params: { runId: started.runId, tenantId: tenant.id } },
    ])
    expect(stubs(env).hub?.broadcasts.some(b => b.tenantId === tenant.id)).toBe(true)
    const activity = await db
      .select()
      .from(activityEvents)
      .where(
        and(eq(activityEvents.tenantId, tenant.id), eq(activityEvents.subjectId, started.runId))
      )
    expect(activity).toMatchObject([
      {
        type: 'agent_run.requested',
        userId: null,
        metadata: { agentKey: FIXTURE_AGENT, via: 'plugin' },
      },
    ])
    expect(ctx.startedRuns).toEqual([
      {
        input: expect.objectContaining({ idempotencyKey: `receipt:${documentId}` }),
        result: started,
      },
    ])
  })

  it('credits triggeredBy as the requester', async () => {
    installAgent()
    const env = createTestEnv()
    const { tenant, user } = await createTestTenantWithUser(db, 'member')
    const { runId } = await makeJobCtx({ db, env }).startAgentRun({
      agentKey: FIXTURE_AGENT,
      tenantId: tenant.id,
      input: { documentId: crypto.randomUUID() },
      triggeredBy: user.id,
    })
    expect((await runRow(runId))?.requestedByUserId).toBe(user.id)
  })

  it('is on CronCtx and EmailCtx too, and the builders record it', async () => {
    installAgent()
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const input = { agentKey: FIXTURE_AGENT, tenantId: tenant.id }
    const cron = makeCronCtx({ db, env })
    const email = makeEmailCtx({ db, env })
    const a = await cron.startAgentRun({ ...input, input: { documentId: crypto.randomUUID() } })
    const b = await email.startAgentRun({ ...input, input: { documentId: crypto.randomUUID() } })
    expect(a.runId).not.toBe(b.runId)
    expect(cron.startedRuns.map(r => r.result?.runId)).toEqual([a.runId])
    expect(email.startedRuns.map(r => r.result?.runId)).toEqual([b.runId])
    expect(recorder(env).created).toHaveLength(2)
  })
})

describe('idempotencyKey', () => {
  it('a redelivered job answers the first run — even after it settled — and starts nothing', async () => {
    installAgent()
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const ctx = makeJobCtx({ db, env })
    const payload = { tenantId: tenant.id, documentId: crypto.randomUUID() }

    const first = await prepareReceipt(ctx, payload)
    const again = await prepareReceipt(ctx, payload)
    expect(again).toEqual({ runId: first.runId, status: 'queued', deduplicated: true })

    await db.update(agentRuns).set({ status: 'succeeded' }).where(eq(agentRuns.id, first.runId))
    const afterSettle = await prepareReceipt(ctx, payload)
    expect(afterSettle).toEqual({ runId: first.runId, status: 'succeeded', deduplicated: true })

    expect(recorder(env).created).toHaveLength(1)
    const rows = await db.select().from(agentRuns).where(eq(agentRuns.tenantId, tenant.id))
    expect(rows).toHaveLength(1)
    const activity = await db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.tenantId, tenant.id), eq(activityEvents.subjectId, first.runId)))
    expect(activity).toHaveLength(1)
  })

  it('two deliveries at once still start one run', async () => {
    installAgent()
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const ctx = makeJobCtx({ db, env })
    const payload = { tenantId: tenant.id, documentId: crypto.randomUUID() }

    const results = await Promise.all([prepareReceipt(ctx, payload), prepareReceipt(ctx, payload)])

    expect(new Set(results.map(r => r.runId)).size).toBe(1)
    expect(results.filter(r => !r.deduplicated)).toHaveLength(1)
    expect(recorder(env).created).toHaveLength(1)
  })

  it('a different key, or the same key in another tenant, is a run of its own', async () => {
    installAgent()
    const env = createTestEnv()
    const a = await createTestTenantWithUser(db, 'owner')
    const b = await createTestTenantWithUser(db, 'owner')
    const ctx = makeJobCtx({ db, env })
    const documentId = crypto.randomUUID()

    const one = await prepareReceipt(ctx, { tenantId: a.tenant.id, documentId })
    const other = await prepareReceipt(ctx, {
      tenantId: a.tenant.id,
      documentId: crypto.randomUUID(),
    })
    const elsewhere = await prepareReceipt(ctx, { tenantId: b.tenant.id, documentId })

    expect(new Set([one.runId, other.runId, elsewhere.runId]).size).toBe(3)
    expect([one, other, elsewhere].every(r => !r.deduplicated)).toBe(true)
    expect((await runRow(elsewhere.runId))?.tenantId).toBe(b.tenant.id)
  })

  it('derives a stable UUID from (tenant, agent, key)', async () => {
    const t = crypto.randomUUID()
    const id = await idempotentRunId(t, FIXTURE_AGENT, 'k')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await idempotentRunId(t, FIXTURE_AGENT, 'k')).toBe(id)
    expect(await idempotentRunId(t, FIXTURE_AGENT_B, 'k')).not.toBe(id)
    expect(await idempotentRunId(crypto.randomUUID(), FIXTURE_AGENT, 'k')).not.toBe(id)
  })

  it('a create() failure leaves no row under the derived id, so the retry starts the run', async () => {
    installAgent()
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const ctx = makeJobCtx({ db, env })
    const payload = { tenantId: tenant.id, documentId: crypto.randomUUID() }
    const workflow = recorder(env)

    workflow.failCreate = () => true
    await expect(prepareReceipt(ctx, payload)).rejects.toThrow(/could not create/)
    const runId = await idempotentRunId(tenant.id, FIXTURE_AGENT, `receipt:${payload.documentId}`)
    expect(await runRow(runId)).toBeUndefined()
    expect(ctx.startedRuns[0]?.error).toBeInstanceOf(Error)

    workflow.failCreate = null
    const retried = await prepareReceipt(ctx, payload)
    expect(retried).toEqual({ runId, status: 'queued', deduplicated: false })
    expect(workflow.created.map(c => c.id)).toEqual([runId])
  })

  it('a row whose instance was never created gets one on the next call', async () => {
    installAgent()
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const documentId = crypto.randomUUID()
    const runId = await idempotentRunId(tenant.id, FIXTURE_AGENT, `receipt:${documentId}`)
    // What a caller that died between the insert and `create()` leaves behind.
    await db.insert(agentRuns).values({
      id: runId,
      traceId: traceIdForRun(runId),
      tenantId: tenant.id,
      agentKey: FIXTURE_AGENT,
      status: 'queued',
      input: { documentId },
    })

    const started = await prepareReceipt(makeJobCtx({ db, env }), {
      tenantId: tenant.id,
      documentId,
    })

    expect(started).toEqual({ runId, status: 'queued', deduplicated: true })
    expect(recorder(env).created.map(c => c.id)).toEqual([runId])
    expect((await runRow(runId))?.instanceId).toBe(runId)
  })
})

describe('the route’s gates apply', () => {
  it('invalid input is a 400 and writes nothing', async () => {
    installAgent()
    const env = createTestEnv()
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    await expect(
      makeJobCtx({ db, env }).startAgentRun({
        agentKey: FIXTURE_AGENT,
        tenantId: tenant.id,
        input: { documentId: 'not-a-uuid' },
      })
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(await db.select().from(agentRuns).where(eq(agentRuns.tenantId, tenant.id))).toEqual([])
  })

  it('an unknown agent is a 400', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    await expect(
      makeJobCtx({ db }).startAgentRun({
        agentKey: 'no-such-agent' as AgentKey,
        tenantId: tenant.id,
        input: {},
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_failed' })
  })

  it('the active-run cap is a 429, and a redelivery of a started run is still answered', async () => {
    installAgent()
    const env = createTestEnv({ AGENT_MAX_ACTIVE_RUNS_PER_TENANT: '1' })
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const ctx = makeJobCtx({ db, env })
    const payload = { tenantId: tenant.id, documentId: crypto.randomUUID() }
    const first = await prepareReceipt(ctx, payload)
    await expect(
      prepareReceipt(ctx, { tenantId: tenant.id, documentId: crypto.randomUUID() })
    ).rejects.toMatchObject({ statusCode: 429, code: 'agent_runs_limit' })
    expect(await prepareReceipt(ctx, payload)).toMatchObject({
      runId: first.runId,
      deduplicated: true,
    })
  })

  it('no AGENT_RUN_WORKFLOW binding is a 503 before any write', async () => {
    installAgent()
    const env = createTestEnv({ AGENT_RUN_WORKFLOW: undefined })
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    await expect(
      prepareReceipt(makeJobCtx({ db, env }), {
        tenantId: tenant.id,
        documentId: crypto.randomUUID(),
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'agent_runs_not_configured' })
    expect(await db.select().from(agentRuns).where(eq(agentRuns.tenantId, tenant.id))).toEqual([])
  })

  it('a test can replace the starter, and the call is still recorded', async () => {
    const ctx = makeJobCtx({
      db,
      startAgentRun: async () => ({ runId: 'fake-run', status: 'queued', deduplicated: false }),
    })
    const tenantId = crypto.randomUUID()
    const documentId = crypto.randomUUID()
    expect(await prepareReceipt(ctx, { tenantId, documentId })).toMatchObject({ runId: 'fake-run' })
    expect(ctx.startedRuns).toEqual([
      {
        input: {
          agentKey: FIXTURE_AGENT,
          tenantId,
          input: { documentId },
          idempotencyKey: `receipt:${documentId}`,
        },
        result: { runId: 'fake-run', status: 'queued', deduplicated: false },
      },
    ])
  })
})

describe('storage() on ToolCtx and AgentCtx', () => {
  /** The slice of `AgentContext` the adapter reads before any method is called. */
  function runtimeContext(env: TestEnv, tenantId: string): AgentContext {
    return {
      db,
      cfg: {},
      env,
      logger: console,
      tenantId,
      runId: crypto.randomUUID(),
      userId: null,
      input: {},
      tools: [],
      chat: { client: { provider: 'anthropic' }, model: 'm', maxOutputTokens: 1 },
    } as unknown as AgentContext
  }

  it('is the FILES bucket for a tool and for an agent', async () => {
    const env = createTestEnv()
    const tenantId = crypto.randomUUID()
    const tool = makeToolCtx({ db, env, tenantId })
    await tool.storage().put(`tenants/${tenantId}/receipts/a.txt`, 'from a tool', {
      contentType: 'text/plain',
    })
    const agent = agentCtx(runtimeContext(env, tenantId))
    await agent.storage().put(`tenants/${tenantId}/receipts/b.txt`, 'from an agent', {
      contentType: 'text/plain',
    })

    expect([...(stubs(env).files?.objects.keys() ?? [])].sort()).toEqual([
      `tenants/${tenantId}/receipts/a.txt`,
      `tenants/${tenantId}/receipts/b.txt`,
    ])
    const read = await agent.storage().get(`tenants/${tenantId}/receipts/a.txt`)
    expect(await new Response(read?.body).text()).toBe('from a tool')
  })

  it('is a 503 storage_not_configured without the binding', () => {
    const env = createTestEnv({ FILES: undefined })
    const tenantId = crypto.randomUUID()
    expect(() => makeToolCtx({ db, env, tenantId }).storage()).toThrow(
      expect.objectContaining({ statusCode: 503, code: 'storage_not_configured' })
    )
    expect(() => agentCtx(runtimeContext(env, tenantId)).storage()).toThrow(
      expect.objectContaining({ statusCode: 503, code: 'storage_not_configured' })
    )
  })
})

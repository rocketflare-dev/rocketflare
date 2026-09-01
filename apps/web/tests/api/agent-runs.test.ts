/**
 * `/api/agents` (D7): the enqueue handoff — 202 + a `queued` row + a Workflow instance recorded on
 * the stub binding (id = run id, params `{ runId, tenantId }`); exclusive dedupe (same run back with
 * `deduplicated: true`, 409 `agent_run_active` only with `?strict=1`); input validated against the
 * agent's schema (400) BEFORE any row; members see only their own runs (others' are 404, admins see
 * all); cancel flips a queued run to `cancelled` and sets `cancelRequestedAt`; `GET /runs/:id`
 * reconciles a stale active row against the runtime (`not_found` → failed, `errored` → failed,
 * `complete` → succeeded); no binding → 503 `agent_runs_not_configured`; 401 anon; tenant isolation.
 */
import {
  agentListResponseSchema,
  agentRunWithEventsSchema,
  createAgentRunResponseSchema,
} from '@gmgo/shared/ai/agents'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { agentRuns } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

async function actor(role: 'owner' | 'admin' | 'member' = 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function memberOf(tenantId: string, role: 'member' | 'admin' = 'member') {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
}

const start = (
  cookie: Record<string, string>,
  env: TestEnv,
  text = 'Some text to summarise.',
  qs = ''
) =>
  request(
    `/api/agents/runs${qs}`,
    { method: 'POST', headers: cookie },
    { env, json: { agentKey: 'summarize-text', input: { text } } }
  )

describe('GET /api/agents', () => {
  it('lists the registry meta (no schemas on the wire); 401 anon', async () => {
    const a = await actor()
    const body = agentListResponseSchema.parse(
      await json(await request('/api/agents', { headers: a.cookie }))
    )
    expect(body.items).toEqual([
      expect.objectContaining({
        key: 'summarize-text',
        promptKey: 'summarize-text',
        exclusive: true,
        title: expect.any(String),
      }),
    ])
    expect((await request('/api/agents')).status).toBe(401)
  })
})

describe('POST /api/agents/runs', () => {
  it('202 → queued row + Workflow instance with id = run id and params { runId, tenantId }; activity + nudge', async () => {
    const a = await actor()
    const env = createTestEnv()
    const res = await start(a.cookie, env)
    expect(res.status).toBe(202)
    const run = createAgentRunResponseSchema.parse(await json(res))
    expect(run).toMatchObject({
      tenantId: a.tenant.id,
      agentKey: 'summarize-text',
      status: 'queued',
      input: { text: 'Some text to summarise.', style: 'bullets', index: false },
      output: null,
      error: null,
      requestedByUserId: a.user.id,
      instanceId: run.id,
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      deduplicated: false,
    })
    expect(stubs(env).workflow?.created).toEqual([
      { id: run.id, params: { runId: run.id, tenantId: a.tenant.id } },
    ])
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id))
    expect(row?.status).toBe('queued')
    expect(row?.instanceId).toBe(run.id)
    const nudges = stubs(env).hub.broadcasts.filter(b => b.tenantId === a.tenant.id)
    expect(nudges.map(b => (b.args[1] as { type: string; payload: unknown }).type)).toContain(
      'entity.changed'
    )
    expect(nudges.map(b => (b.args[1] as { payload: unknown }).payload)).toContainEqual({
      entity: 'agent-run',
      id: run.id,
    })
  })

  it('exclusive: a second request while one is active answers THAT run (deduplicated); ?strict=1 → 409', async () => {
    const a = await actor()
    const env = createTestEnv()
    const first = createAgentRunResponseSchema.parse(await json(await start(a.cookie, env)))
    const again = await start(a.cookie, env, 'Different text')
    expect(again.status).toBe(202)
    const second = createAgentRunResponseSchema.parse(await json(again))
    expect(second.id).toBe(first.id)
    expect(second.deduplicated).toBe(true)
    expect(second.input).toEqual(first.input)
    expect(stubs(env).workflow?.created).toHaveLength(1)

    const strict = await start(a.cookie, env, 'x', '?strict=1')
    expect(strict.status).toBe(409)
    expect(await json(strict)).toMatchObject({
      error: expect.any(String),
      statusCode: 409,
      code: 'agent_run_active',
      details: { runId: first.id },
    })
  })

  it('validates the body and the agent input (400) before any row exists', async () => {
    const a = await actor()
    const env = createTestEnv()
    const bad = await request(
      '/api/agents/runs',
      { method: 'POST', headers: a.cookie },
      { env, json: { agentKey: 'summarize-text', input: { text: '' } } }
    )
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ statusCode: 400, code: 'validation_failed' })
    const unknown = await request(
      '/api/agents/runs',
      { method: 'POST', headers: a.cookie },
      { env, json: { agentKey: 'nope', input: {} } }
    )
    expect(unknown.status).toBe(400)
    expect(await db.select().from(agentRuns).where(eq(agentRuns.tenantId, a.tenant.id))).toEqual([])
    expect(stubs(env).workflow?.created).toEqual([])
  })

  it('503 agent_runs_not_configured without the Workflow binding, and no row is written', async () => {
    const a = await actor()
    const res = await start(a.cookie, createTestEnv({ AGENT_RUN_WORKFLOW: undefined }))
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({
      error: expect.any(String),
      statusCode: 503,
      code: 'agent_runs_not_configured',
    })
    expect(await db.select().from(agentRuns).where(eq(agentRuns.tenantId, a.tenant.id))).toEqual([])
  })
})

describe('GET /api/agents/runs(/:id) — visibility', () => {
  it("members see only their own runs; another member's run is 404; admins see every run", async () => {
    const a = await actor('member')
    const env = createTestEnv()
    const mine = createAgentRunResponseSchema.parse(await json(await start(a.cookie, env)))
    const other = await memberOf(a.tenant.id)
    const admin = await memberOf(a.tenant.id, 'admin')

    expect(
      (await request(`/api/agents/runs/${mine.id}`, { headers: other.cookie }, { env })).status
    ).toBe(404)
    const otherList = await json<{ items: Array<{ id: string }> }>(
      await request('/api/agents/runs', { headers: other.cookie }, { env })
    )
    expect(otherList.items).toEqual([])

    const mineDetail = agentRunWithEventsSchema.parse(
      await json(await request(`/api/agents/runs/${mine.id}`, { headers: a.cookie }, { env }))
    )
    expect(mineDetail).toMatchObject({ id: mine.id, status: 'queued', events: [] })

    const adminList = await json<{ items: Array<{ id: string }>; pagination: { total: number } }>(
      await request('/api/agents/runs?agentKey=summarize-text', { headers: admin.cookie }, { env })
    )
    expect(adminList.items.map(i => i.id)).toEqual([mine.id])
    expect(adminList.pagination.total).toBe(1)
    expect(
      (await request(`/api/agents/runs/${mine.id}`, { headers: admin.cookie }, { env })).status
    ).toBe(200)

    // Other tenant: 404, and a filtered list is empty.
    const b = await actor('owner')
    expect(
      (await request(`/api/agents/runs/${mine.id}`, { headers: b.cookie }, { env })).status
    ).toBe(404)
    expect(
      (await request('/api/agents/runs/not-a-uuid', { headers: a.cookie }, { env })).status
    ).toBe(404)
    expect((await request(`/api/agents/runs/${mine.id}`)).status).toBe(401)
  })
})

describe('POST /api/agents/runs/:id/cancel', () => {
  it('a queued run is cancelled outright (flag + finishedAt); cancelling again is idempotent; a running run only gets the flag', async () => {
    const a = await actor()
    const env = createTestEnv()
    const run = createAgentRunResponseSchema.parse(await json(await start(a.cookie, env)))
    const res = await request(
      `/api/agents/runs/${run.id}/cancel`,
      { method: 'POST', headers: a.cookie },
      { env }
    )
    expect(res.status).toBe(200)
    const cancelled = createAgentRunResponseSchema.parse(await json(res))
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelRequestedAt).toBeInstanceOf(Date)
    expect(cancelled.finishedAt).toBeInstanceOf(Date)
    const again = createAgentRunResponseSchema.parse(
      await json(
        await request(
          `/api/agents/runs/${run.id}/cancel`,
          { method: 'POST', headers: a.cookie },
          { env }
        )
      )
    )
    expect(again.status).toBe('cancelled')

    // The slot is free again: a new run can be enqueued.
    const next = createAgentRunResponseSchema.parse(await json(await start(a.cookie, env)))
    expect(next.id).not.toBe(run.id)
    expect(next.deduplicated).toBe(false)
    // Simulate the claim step: running → cancel sets only the flag; the run polls it.
    await db
      .update(agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(agentRuns.id, next.id))
    const flagged = createAgentRunResponseSchema.parse(
      await json(
        await request(
          `/api/agents/runs/${next.id}/cancel`,
          { method: 'POST', headers: a.cookie },
          { env }
        )
      )
    )
    expect(flagged.status).toBe('running')
    expect(flagged.cancelRequestedAt).toBeInstanceOf(Date)
    expect(flagged.finishedAt).toBeNull()
  })

  it('another member cannot cancel my run (404)', async () => {
    const a = await actor()
    const env = createTestEnv()
    const run = createAgentRunResponseSchema.parse(await json(await start(a.cookie, env)))
    const other = await memberOf(a.tenant.id)
    expect(
      (
        await request(
          `/api/agents/runs/${run.id}/cancel`,
          { method: 'POST', headers: other.cookie },
          { env }
        )
      ).status
    ).toBe(404)
  })
})

describe('reconcile on read', () => {
  it('an active row whose instance is not_found → failed; errored → failed with the message; complete → succeeded; running → untouched; no binding → untouched', async () => {
    const a = await actor()
    const env = createTestEnv()
    const run = createAgentRunResponseSchema.parse(await json(await start(a.cookie, env)))

    // Same binding, instance still running: nothing changes.
    let detail = agentRunWithEventsSchema.parse(
      await json(await request(`/api/agents/runs/${run.id}`, { headers: a.cookie }, { env }))
    )
    expect(detail.status).toBe('queued')

    // No binding at all: a read never 503s and never settles.
    detail = agentRunWithEventsSchema.parse(
      await json(
        await request(
          `/api/agents/runs/${run.id}`,
          { headers: a.cookie },
          { env: createTestEnv({ AGENT_RUN_WORKFLOW: undefined }) }
        )
      )
    )
    expect(detail.status).toBe('queued')

    // The runtime says errored.
    stubs(env).workflow?.setStatus(run.id, {
      status: 'errored',
      error: { name: 'Error', message: 'step exhausted retries' },
    })
    detail = agentRunWithEventsSchema.parse(
      await json(await request(`/api/agents/runs/${run.id}`, { headers: a.cookie }, { env }))
    )
    expect(detail).toMatchObject({ status: 'failed', error: 'step exhausted retries' })
    expect(detail.finishedAt).toBeInstanceOf(Date)

    // A fresh binding that never created the instance: `not_found` is an answer → failed.
    const run2 = createAgentRunResponseSchema.parse(await json(await start(a.cookie, env)))
    detail = agentRunWithEventsSchema.parse(
      await json(
        await request(
          `/api/agents/runs/${run2.id}`,
          { headers: a.cookie },
          { env: createTestEnv() }
        )
      )
    )
    expect(detail).toMatchObject({ status: 'failed', error: 'Workflow instance not found' })

    // complete while the row is still active → succeeded.
    const run3 = createAgentRunResponseSchema.parse(await json(await start(a.cookie, env)))
    stubs(env).workflow?.setStatus(run3.id, { status: 'complete' })
    detail = agentRunWithEventsSchema.parse(
      await json(await request(`/api/agents/runs/${run3.id}`, { headers: a.cookie }, { env }))
    )
    expect(detail.status).toBe('succeeded')
  })
})

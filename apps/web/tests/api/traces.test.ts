/**
 * The local trace store read back (D32): spans flushed through `databaseSpanStore` land in
 * `ai_spans`; `GET /api/traces` lists one row per trace for the caller's tenant only, with the
 * filters the CLI uses; `GET /api/traces/:id` returns a trace's spans by trace id, run id or message
 * id, and another tenant's id is a 404 exactly like an unknown one; anonymous 401, members 403.
 */
import { traceDetailSchema, traceListResponseSchema } from '@rocketflare/shared/ai/traces'
import { describe, expect, it } from 'vitest'
import { databaseSpanStore } from '@/api/observability/span-store'
import { rootSpanIdForRun, traceIdForRun } from '@/api/observability/trace-ids'
import { traceChatClient, tracerFor, withAgentTrace } from '@/api/observability/tracing'
import { loadConfig } from '@/config'
import { agentRuns } from '@/db/schema'
import { FakeChatClient } from '../helpers/ai'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())

async function actor(role: 'owner' | 'admin' | 'member' = 'admin') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

/** One chat-shaped trace: root → generation → tool call. Returns its trace id. */
async function recordChat(tenantId: string, userId: string, fail = false): Promise<string> {
  const tracer = tracerFor(cfg, { store: databaseSpanStore(db) })
  let traceId = ''
  const fake = new FakeChatClient([fail ? { error: new Error('boom') } : { text: 'hello' }])
  await withAgentTrace('chat', { tracer, tenantId, userId, input: 'hi' }, async trace => {
    traceId = trace.traceId
    trace.toolCall({
      name: 'search_knowledge',
      input: { query: 'x' },
      output: '{"hits":[]}',
      startTime: new Date(),
      endTime: new Date(),
    })
    await traceChatClient(fake, trace, { provider: 'anthropic' }, tracer).complete({
      model: 'claude-test',
      maxTokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    })
  }).catch(() => undefined)
  await tracer.flush()
  return traceId
}

describe('/api/traces', () => {
  it('lists only the caller tenant traces, newest first, with totals', async () => {
    const a = await actor()
    const b = await actor()
    const ok = await recordChat(a.tenant.id, a.user.id)
    const failed = await recordChat(a.tenant.id, a.user.id, true)
    const other = await recordChat(b.tenant.id, b.user.id)

    const res = await request('/api/traces', { headers: a.cookie })
    expect(res.status).toBe(200)
    const body = traceListResponseSchema.parse(await json(res))
    expect(body.items.map(t => t.traceId)).toEqual([failed, ok])
    expect(body.items.map(t => t.traceId)).not.toContain(other)
    expect(body.pagination.total).toBe(2)
    const okTrace = body.items.find(t => t.traceId === ok)
    expect(okTrace).toMatchObject({
      name: 'invoke_agent chat',
      status: 'ok',
      spanCount: 3,
      inputTokens: 10,
      outputTokens: 5,
      models: ['claude-test'],
      userId: a.user.id,
    })
    expect(body.items.find(t => t.traceId === failed)?.status).toBe('error')

    const errors = traceListResponseSchema.parse(
      await json(await request('/api/traces?status=error', { headers: a.cookie }))
    )
    expect(errors.items.map(t => t.traceId)).toEqual([failed])
    const byAgent = traceListResponseSchema.parse(
      await json(await request('/api/traces?agent=nope', { headers: a.cookie }))
    )
    expect(byAgent.items).toEqual([])
  })

  it('shows one trace by id with parent-linked spans; another tenant trace is a 404', async () => {
    const a = await actor()
    const b = await actor()
    const mine = await recordChat(a.tenant.id, a.user.id)
    const theirs = await recordChat(b.tenant.id, b.user.id)

    const detail = traceDetailSchema.parse(
      await json(await request(`/api/traces/${mine}`, { headers: a.cookie }))
    )
    const root = detail.spans.find(s => s.parentSpanId === null)
    expect(root?.name).toBe('invoke_agent chat')
    expect(
      detail.spans
        .filter(s => s.parentSpanId === root?.spanId)
        .map(s => s.kind)
        .sort()
    ).toEqual(['llm', 'tool'])
    expect(detail.spans.find(s => s.kind === 'tool')).toMatchObject({
      toolName: 'search_knowledge',
      content: { input: { query: 'x' }, output: '{"hits":[]}' },
    })
    expect(detail.trace.traceUrl).toBeNull()

    const cross = await request(`/api/traces/${theirs}`, { headers: a.cookie })
    expect(cross.status).toBe(404)
    expect((await json<{ code: string }>(cross)).code).toBe('trace_not_found')
  })

  it('resolves an agent run id to the run trace, steps under the derived root', async () => {
    const a = await actor()
    const [run] = await db
      .insert(agentRuns)
      .values({ tenantId: a.tenant.id, agentKey: 'summarize-text', input: {}, status: 'running' })
      .returning()
    if (!run) throw new Error('no run')
    const tracer = tracerFor(cfg, { store: databaseSpanStore(db) })
    await withAgentTrace(
      'summarize-text',
      {
        tracer,
        tenantId: a.tenant.id,
        runId: run.id,
        traceId: traceIdForRun(run.id),
        parentSpanId: rootSpanIdForRun(run.id),
        spanName: 'execute#0',
        kind: 'span',
      },
      async () => 'ok'
    )
    await tracer.flush()

    const detail = traceDetailSchema.parse(
      await json(await request(`/api/traces/${run.id}`, { headers: a.cookie }))
    )
    expect(detail.trace).toMatchObject({ traceId: traceIdForRun(run.id), runId: run.id })
    expect(detail.spans[0]).toMatchObject({
      name: 'execute#0',
      parentSpanId: rootSpanIdForRun(run.id),
    })
    const list = traceListResponseSchema.parse(
      await json(await request(`/api/traces?runId=${run.id}`, { headers: a.cookie }))
    )
    expect(list.items.map(t => t.traceId)).toEqual([traceIdForRun(run.id)])
  })

  it('is admin+: anonymous 401, a member 403, an unknown uuid 404, a malformed id 400', async () => {
    const anon = await request('/api/traces')
    expect(anon.status).toBe(401)
    expect(await json(anon)).toMatchObject({ statusCode: 401, error: expect.any(String) })
    const m = await actor('member')
    expect((await request('/api/traces', { headers: m.cookie })).status).toBe(403)
    const a = await actor()
    expect(
      (await request('/api/traces/00000000-0000-4000-8000-000000000000', { headers: a.cookie }))
        .status
    ).toBe(404)
    expect((await request('/api/traces/xyz', { headers: a.cookie })).status).toBe(400)
  })
})

/**
 * `projectRunToAgui` (D7) row by row, and `GET /api/agents/runs/:id/agui` end to end against a real
 * run. The projection is pure — the event row ids ARE the AG-UI message and tool-call ids — so the
 * mapping is asserted directly and the route only has to prove the ownership rules and the shape.
 */
import type { AgentRun, AgentRunEvent } from '@rocketflare/shared/ai/agents'
import {
  agentRunAguiResponseSchema,
  KIT_CUSTOM_EVENTS,
  kitAguiEventSchema,
} from '@rocketflare/shared/ai/agui'
import { describe, expect, it } from 'vitest'
import { projectRunToAgui } from '@/api/services/agents/agui-projection'
import { agentRunEvents, agentRuns } from '@/db/schema'
import { aguiTypes, customEvents } from '../helpers/ai'
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

const RUN_ID = '99999999-9999-4999-8999-999999999999'
const TENANT_ID = '88888888-8888-4888-8888-888888888888'

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: RUN_ID,
  tenantId: TENANT_ID,
  agentKey: 'research-topic',
  status: 'succeeded',
  input: { question: 'why' },
  output: { answer: 'because' },
  error: null,
  requestedByUserId: null,
  instanceId: RUN_ID,
  attempt: 1,
  startedAt: new Date(),
  finishedAt: new Date(),
  cancelRequestedAt: null,
  createdAt: new Date(),
  ...over,
})

let seq = 0
const event = (type: AgentRunEvent['type'], data: unknown): AgentRunEvent => {
  seq += 1
  return {
    id: `0000000${seq % 10}-0000-4000-8000-00000000000${seq % 10}`,
    runId: RUN_ID,
    seq,
    type,
    at: new Date(),
    data,
  }
}

describe('projectRunToAgui', () => {
  it('opens with a synthetic RUN_STARTED whose thread is the run', () => {
    const [first] = projectRunToAgui(run({ status: 'queued' }), [])
    expect(first).toEqual({ type: 'RUN_STARTED', threadId: RUN_ID, runId: RUN_ID })
  })

  it('maps a step to STEP_STARTED/FINISHED plus the label CUSTOM stepName cannot carry', () => {
    const events = [
      event('status', { status: 'running' }),
      event('step', { key: 'search', label: 'Searching', status: 'running' }),
      event('step', { key: 'search', label: 'Searching', status: 'done', detail: '3 hits' }),
    ]
    const out = projectRunToAgui(run({ status: 'running' }), events)
    expect(aguiTypes(out)).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
      'CUSTOM',
      'STEP_FINISHED',
      'CUSTOM',
    ])
    expect(customEvents(out)).toEqual([
      {
        name: KIT_CUSTOM_EVENTS.agentStep,
        value: { key: 'search', label: 'Searching', status: 'running' },
      },
      {
        name: KIT_CUSTOM_EVENTS.agentStep,
        value: { key: 'search', label: 'Searching', status: 'done', detail: '3 hits' },
      },
    ])
  })

  it('maps text to one whole message and pairs a tool call with its result', () => {
    const start = event('tool.start', { name: 'search_knowledge', input: { query: 'x' } })
    const events = [
      event('text', { text: 'Thinking about it.' }),
      start,
      event('tool.end', { name: 'search_knowledge', isError: false, result: { hits: 2 } }),
    ]
    const out = projectRunToAgui(run(), events)
    expect(aguiTypes(out)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'RUN_FINISHED',
    ])
    const call = out.find(e => e.type === 'TOOL_CALL_START')
    expect(call?.type === 'TOOL_CALL_START' && call).toMatchObject({
      toolCallId: start.id,
      toolCallName: 'search_knowledge',
      // The text message that preceded it — the call belongs to that turn.
      parentMessageId: events[0]?.id,
    })
    const args = out.find(e => e.type === 'TOOL_CALL_ARGS')
    expect(JSON.parse(args?.type === 'TOOL_CALL_ARGS' ? args.delta : '{}')).toEqual({ query: 'x' })
    const result = out.find(e => e.type === 'TOOL_CALL_RESULT')
    // The result refers back to the CALL's id, not its own row.
    expect(result?.type === 'TOOL_CALL_RESULT' && result.toolCallId).toBe(start.id)
    expect(JSON.parse(result?.type === 'TOOL_CALL_RESULT' ? result.content : '{}')).toMatchObject({
      isError: false,
      result: { hits: 2 },
    })
  })

  it('reports a retry as a non-terminal CUSTOM, not an error', () => {
    const out = projectRunToAgui(run({ status: 'running' }), [
      event('error', { message: 'rate limited', attempt: 1, willRetry: true }),
    ])
    expect(customEvents(out)).toEqual([
      { name: KIT_CUSTOM_EVENTS.agentRetry, value: { message: 'rate limited', attempt: 1 } },
    ])
    expect(aguiTypes(out)).not.toContain('RUN_ERROR')
  })

  it('carries the run output in RUN_FINISHED and the run error in RUN_ERROR', () => {
    const ok = projectRunToAgui(run(), [])
    expect(ok.at(-1)).toEqual({
      type: 'RUN_FINISHED',
      threadId: RUN_ID,
      runId: RUN_ID,
      result: { answer: 'because' },
    })
    const failed = projectRunToAgui(run({ status: 'failed', output: null, error: 'boom' }), [
      event('error', { message: 'boom', willRetry: false }),
    ])
    expect(failed.at(-1)).toEqual({
      type: 'RUN_ERROR',
      message: 'boom',
      code: 'agent_run_failed',
    })
  })

  it('distinguishes a cancelled run from one that is still going', () => {
    // A finite array cannot say "cancelled" by omitting the terminal event: that is how an ACTIVE
    // run is represented. A settled cancel is a coded RUN_ERROR.
    const cancelled = projectRunToAgui(run({ status: 'cancelled', output: null }), [])
    expect(cancelled.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'agent_run_cancelled' })
    for (const status of ['queued', 'running'] as const) {
      const active = projectRunToAgui(run({ status, output: null }), [])
      expect(aguiTypes(active)).toEqual(['RUN_STARTED'])
    }
  })

  it('projects a row whose data is malformed instead of throwing', () => {
    const out = projectRunToAgui(run(), [
      event('step', {}),
      event('text', { text: null }),
      event('tool.start', 'not an object'),
      event('tool.end', null),
    ])
    expect(() => out.map(e => kitAguiEventSchema.parse(e))).not.toThrow()
    expect(aguiTypes(out)).not.toContain('TEXT_MESSAGE_START')
  })

  it('emits only events the kit declares', () => {
    const out = projectRunToAgui(run(), [
      event('status', { status: 'running' }),
      event('step', { key: 'k', label: 'L', status: 'running' }),
      event('text', { text: 'hi' }),
      event('tool.start', { name: 't', input: {} }),
      event('tool.end', { name: 't', isError: true }),
    ])
    for (const e of out) expect(kitAguiEventSchema.safeParse(e).success).toBe(true)
  })
})

describe('GET /api/agents/runs/:id/agui', () => {
  async function seedRun(status: AgentRun['status'] = 'succeeded') {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const [row] = await db
      .insert(agentRuns)
      .values({
        tenantId: tenant.id,
        agentKey: 'summarize-text',
        status,
        input: { text: 'hello' },
        output: status === 'succeeded' ? { summary: 'hi', keyPoints: [] } : null,
        requestedByUserId: user.id,
      })
      .returning()
    if (!row) throw new Error('no run')
    await db.insert(agentRunEvents).values([
      { runId: row.id, tenantId: tenant.id, seq: 1, type: 'status', data: { status: 'running' } },
      {
        runId: row.id,
        tenantId: tenant.id,
        seq: 2,
        type: 'step',
        data: { key: 'summarize', label: 'Summarising', status: 'running' },
      },
      { runId: row.id, tenantId: tenant.id, seq: 3, type: 'text', data: { text: 'hi' } },
    ])
    return {
      run: row,
      tenant,
      user,
      cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
    }
  }

  it('answers the projection for a run the caller owns', async () => {
    const { run: row, cookie } = await seedRun()
    const res = await request(`/api/agents/runs/${row.id}/agui`, { headers: cookie })
    expect(res.status).toBe(200)
    const body = agentRunAguiResponseSchema.parse(await json(res))
    expect(aguiTypes(body.events)).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
      'CUSTOM',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ])
  })

  it('is 404 for another member’s run, 401 anonymous, and visible to an admin', async () => {
    const { run: row, tenant } = await seedRun()
    const other = await createTestUser(db)
    await linkUserToTenant(db, other.id, tenant.id, 'member')
    const otherCookie = sessionCookieHeader(await createTestSession(db, other.id, tenant.id))
    expect(
      (await request(`/api/agents/runs/${row.id}/agui`, { headers: otherCookie })).status
    ).toBe(404)

    const admin = await createTestUser(db)
    await linkUserToTenant(db, admin.id, tenant.id, 'admin')
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id, tenant.id))
    expect(
      (await request(`/api/agents/runs/${row.id}/agui`, { headers: adminCookie })).status
    ).toBe(200)

    expect((await request(`/api/agents/runs/${row.id}/agui`)).status).toBe(401)
  })
})

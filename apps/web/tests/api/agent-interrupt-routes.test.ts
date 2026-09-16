// @vitest-isolate
// Swaps entries in the `AGENTS` module singleton (to get an `approvers: 'admin'` agent and one that
// interrupts) and mocks `@/api/services/ai/resolve`, so this file needs its own module registry.
/**
 * The human-in-the-loop routes (issue #17, phase 5):
 *
 *   POST /api/agents/runs/:id/interrupts/:interruptId   — the eight-step answer
 *   POST /api/agents/runs/:id/steering                  — a note to a run in flight
 *   GET  /api/agents/interrupts                         — the inbox
 *   GET  /api/agents/runs/:id[?events=0]                — now carrying interrupts[] and artifacts[]
 *
 * The properties worth stating, because each is one bug away from stranding a run:
 *
 * - **The answer IS the transition (T4).** `resumeRun` flips `awaiting_input → running` BEFORE the
 *   instance is woken, which is the only reason a restarted instance's `claim` — whose predicate is
 *   the narrow `queued|running` — finds anything. The end-to-end case here drives that whole path:
 *   `sendEvent` → `not_found` → a new instance `<runId>-r1` → **and the run completes**.
 * - **One 200, one 409.** Two people answering the same approval is normal.
 * - **Resume only when nothing is still pending.** A turn with two gated calls parks once.
 * - **`editedInput` is not taken on trust.** Without `allowEdits` it is a 400; with it, the edit is
 *   re-checked against the tool's stored schema.
 */
import { agentRunSchema, agentRunWithEventsSchema } from '@rocketflare/shared/ai/agents'
import type { AgentInterruptSpec } from '@rocketflare/shared/ai/interrupts'
import { interruptInboxItemSchema } from '@rocketflare/shared/ai/interrupts'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { upsertArtifact } from '@/api/services/agents/artifacts'
import { listInterrupts, requestInterrupt } from '@/api/services/agents/interrupts'
import { AGENTS, type AgentContext, type AnyAgentDefinition } from '@/api/services/agents/registry'
import { enqueueRun, getRun, listEvents, parkRun } from '@/api/services/agents/runs'
import { AiError } from '@/api/services/ai/errors'
import type { ChatClient } from '@/api/services/ai/types'
import { AgentRunWorkflow } from '@/api/workflows/agent-run'
import { agentRunInterrupts, agentRuns } from '@/db/schema'
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
import { createExecutionContext, createTestEnv, stubs, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

const state: { client: ChatClient | null } = { client: null }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      if (!state.client) throw new AiError('auth', 'anthropic_compatible', 'no client scripted')
      return {
        client: state.client,
        provider: 'anthropic_compatible',
        model: 'fake-model',
        source: 'tenant',
        maxOutputTokens: 2048,
      }
    }),
  }
})

const db = setupTestDatabase()

const originals = { ...AGENTS }

afterEach(() => {
  Object.assign(AGENTS, originals)
  state.client = null
})

/** Replace an agent for one test — the kit's own two do not interrupt until phase 8. */
function installAgent(
  key: 'summarize-text' | 'research-topic',
  run: (ctx: AgentContext) => Promise<unknown>,
  meta: Partial<AnyAgentDefinition['meta']> = {}
): void {
  AGENTS[key] = {
    meta: { ...originals[key].meta, inputSchema: z.any(), outputSchema: z.any(), ...meta },
    run,
  } as AnyAgentDefinition
}

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
  return {
    user,
    cookie: sessionCookieHeader(
      await createTestSession(
        db,
        user.id,
        (await linkUserToTenant(db, user.id, tenantId, role), tenantId)
      )
    ),
  }
}

const APPROVAL: AgentInterruptSpec = { kind: 'approval', message: 'Send this email?' }

/**
 * A run parked on one or more asks, through the real transitions: enqueue → running (what `claim`
 * does) → the ask rows → `parkRun`. Nothing here fakes a status.
 */
async function parked(
  env: TestEnv,
  owner: { user: { id: string }; tenant: { id: string } },
  specs: Array<{ key: string; spec: AgentInterruptSpec }> = [{ key: 'send-it', spec: APPROVAL }],
  agentKey: 'summarize-text' | 'research-topic' = 'summarize-text'
) {
  const { run } = await enqueueRun(db, env, {
    tenantId: owner.tenant.id,
    agentKey,
    input:
      agentKey === 'summarize-text'
        ? { text: 'Volcanoes erupt.' }
        : { topic: 'Why volcanoes erupt' },
    userId: owner.user.id,
  })
  await db.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, run.id))
  const interrupts = []
  for (const ask of specs) {
    interrupts.push(
      await requestInterrupt(db, {
        tenantId: owner.tenant.id,
        runId: run.id,
        key: ask.key,
        spec: ask.spec,
      })
    )
  }
  const row = await parkRun(db, owner.tenant.id, run.id)
  if (!row) throw new Error('the run did not park')
  return { run: row, interrupts }
}

const answer = (
  cookie: Record<string, string>,
  env: TestEnv,
  runId: string,
  interruptId: string,
  body: unknown = { status: 'resolved' }
) =>
  request(
    `/api/agents/runs/${runId}/interrupts/${interruptId}`,
    { method: 'POST', headers: cookie },
    { env, json: body }
  )

describe('POST /api/agents/runs/:id/interrupts/:interruptId', () => {
  it('answers the ask, records it in the timeline, resumes the row and wakes the instance', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { run, interrupts } = await parked(env, a)
    const ask = interrupts[0]
    if (!ask) throw new Error('no ask')

    const res = await answer(a.cookie, env, run.id, ask.id, {
      status: 'resolved',
      payload: { note: 'go ahead' },
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({
      id: ask.id,
      status: 'resolved',
      payload: { note: 'go ahead' },
      resolvedByUserId: a.user.id,
    })

    // The answer IS the transition, and it happens BEFORE the wake (decision 2).
    expect((await getRun(db, a.tenant.id, run.id))?.status).toBe('running')
    expect(stubs(env).workflow?.events).toEqual([
      { instanceId: run.id, type: 'agent-resume', payload: { interruptId: ask.id } },
    ])
    const events = await listEvents(db, a.tenant.id, run.id)
    expect(events.map(e => e.type)).toEqual(['interrupt.resolved'])
    expect(events[0]?.data).toMatchObject({ interruptId: ask.id, status: 'resolved' })
  })

  it('a second answer is 409 interrupt_not_pending — one 200, one 409, one side effect', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { run, interrupts } = await parked(env, a)
    const ask = interrupts[0]
    if (!ask) throw new Error('no ask')
    expect((await answer(a.cookie, env, run.id, ask.id)).status).toBe(200)
    const again = await answer(a.cookie, env, run.id, ask.id)
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({
      statusCode: 409,
      code: 'interrupt_not_pending',
      details: { interruptId: ask.id },
    })
    // One resume, not two: the second answer never reached the instance.
    expect(stubs(env).workflow?.events).toHaveLength(1)
  })

  it('does NOT resume while another ask of the same turn is still pending', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { run, interrupts } = await parked(env, a, [
      { key: 'call-1', spec: APPROVAL },
      { key: 'call-2', spec: APPROVAL },
    ])
    const [first, second] = interrupts
    if (!first || !second) throw new Error('no asks')

    expect((await answer(a.cookie, env, run.id, first.id)).status).toBe(200)
    expect((await getRun(db, a.tenant.id, run.id))?.status).toBe('awaiting_input')
    expect(stubs(env).workflow?.events).toEqual([])

    expect((await answer(a.cookie, env, run.id, second.id)).status).toBe(200)
    expect((await getRun(db, a.tenant.id, run.id))?.status).toBe('running')
    expect(stubs(env).workflow?.events).toHaveLength(1)
  })

  it('403s a member when the agent declares approvers: admin, and 200s an admin', async () => {
    const a = await actor('member')
    installAgent('summarize-text', async () => ({}), { approvers: 'admin' })
    const env = createTestEnv()
    const { run, interrupts } = await parked(env, a)
    const ask = interrupts[0]
    if (!ask) throw new Error('no ask')

    // The requester can SEE it (the run is theirs) and cannot answer it.
    const forbidden = await answer(a.cookie, env, run.id, ask.id)
    expect(forbidden.status).toBe(403)
    expect(await json(forbidden)).toMatchObject({ statusCode: 403 })
    const inbox = await json<{ items: Array<{ canAnswer: boolean }> }>(
      await request('/api/agents/interrupts', { headers: a.cookie }, { env })
    )
    expect(inbox.items[0]?.canAnswer).toBe(false)

    const admin = await memberOf(a.tenant.id, 'admin')
    expect((await answer(admin.cookie, env, run.id, ask.id)).status).toBe(200)
  })

  it('another member’s run, another tenant’s run and an unknown ask are all 404', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { run, interrupts } = await parked(env, a)
    const ask = interrupts[0]
    if (!ask) throw new Error('no ask')

    const other = await memberOf(a.tenant.id)
    expect((await answer(other.cookie, env, run.id, ask.id)).status).toBe(404)

    const b = await actor('owner')
    expect((await answer(b.cookie, env, run.id, ask.id)).status).toBe(404)

    // Another tenant's ask id against a run of ours is not this run's question.
    const elsewhere = await parked(env, b)
    const stranger = elsewhere.interrupts[0]
    if (!stranger) throw new Error('no ask')
    expect((await answer(a.cookie, env, run.id, stranger.id)).status).toBe(404)
    expect((await answer(a.cookie, env, run.id, crypto.randomUUID())).status).toBe(404)
    expect(
      (
        await request(
          `/api/agents/runs/${run.id}/interrupts/${ask.id}`,
          { method: 'POST' },
          { env, json: { status: 'resolved' } }
        )
      ).status
    ).toBe(401)
  })

  it('refuses editedInput unless the ask offered it, then re-checks it against the tool’s schema', async () => {
    const a = await actor()
    const env = createTestEnv()
    const locked: AgentInterruptSpec = {
      kind: 'approval',
      message: 'Send it?',
      tool: { name: 'send_email', input: { to: 'a@b.test' }, allowEdits: false },
    }
    const editable: AgentInterruptSpec = {
      kind: 'approval',
      message: 'Send it?',
      tool: {
        name: 'send_email',
        input: { to: 'a@b.test' },
        allowEdits: true,
        inputSchema: {
          type: 'object',
          required: ['to'],
          additionalProperties: false,
          properties: { to: { type: 'string' }, copies: { type: 'number' } },
        },
      },
    }
    const { run, interrupts } = await parked(env, a, [
      { key: 'locked', spec: locked },
      { key: 'editable', spec: editable },
    ])
    const [lockedAsk, editableAsk] = interrupts
    if (!lockedAsk || !editableAsk) throw new Error('no asks')

    const refused = await answer(a.cookie, env, run.id, lockedAsk.id, {
      status: 'resolved',
      payload: { editedInput: { to: 'evil@example.test' } },
    })
    expect(refused.status).toBe(400)
    expect(await json(refused)).toMatchObject({ statusCode: 400, code: 'validation_failed' })

    // Offered, but the edit does not fit the tool: a client that can edit arguments could
    // otherwise call anything.
    const bad = await answer(a.cookie, env, run.id, editableAsk.id, {
      status: 'resolved',
      payload: { editedInput: { copies: 'lots', extra: true } },
    })
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({
      statusCode: 400,
      details: expect.arrayContaining([
        expect.objectContaining({ path: ['editedInput', 'to'], message: 'is required' }),
      ]),
    })

    const good = await answer(a.cookie, env, run.id, editableAsk.id, {
      status: 'resolved',
      payload: { editedInput: { to: 'b@c.test', copies: 2 } },
    })
    expect(good.status).toBe(200)
  })

  it('validates a choice answer against the options the ask actually offered', async () => {
    const a = await actor()
    const env = createTestEnv()
    const spec: AgentInterruptSpec = {
      kind: 'choice',
      message: 'Which customer?',
      options: [{ value: 'acme', label: 'Acme' }],
      allowOther: false,
    }
    const { run, interrupts } = await parked(env, a, [{ key: 'which', spec }])
    const ask = interrupts[0]
    if (!ask) throw new Error('no ask')
    expect(
      (
        await answer(a.cookie, env, run.id, ask.id, {
          status: 'resolved',
          payload: { value: 'nope' },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await answer(a.cookie, env, run.id, ask.id, {
          status: 'resolved',
          payload: { value: 'acme' },
        })
      ).status
    ).toBe(200)
  })

  it('a declined answer is status: cancelled, and still resumes the run', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { run, interrupts } = await parked(env, a)
    const ask = interrupts[0]
    if (!ask) throw new Error('no ask')
    const res = await answer(a.cookie, env, run.id, ask.id, {
      status: 'cancelled',
      payload: { note: 'not this one' },
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({
      status: 'cancelled',
      payload: { note: 'not this one' },
    })
    expect((await getRun(db, a.tenant.id, run.id))?.status).toBe('running')
  })
})

describe('the restart fallback, end to end (T4/T5)', () => {
  it('sendEvent → not_found creates <runId>-r1, and the run then COMPLETES', async () => {
    const env = createTestEnv()
    // The runtime resolves a chat client before it runs the agent; this one never calls it.
    state.client = new FakeChatClient([], 'anthropic_compatible')
    let entries = 0
    installAgent('summarize-text', async ctx => {
      entries += 1
      const decision = await ctx.interrupt({ key: 'send-it', spec: APPROVAL })
      return { entries, answer: decision.payload }
    })
    const a = await actor()
    const { run, interrupts } = await parked(env, a)
    const ask = interrupts[0]
    if (!ask) throw new Error('no ask')

    // The instance is gone — a `wrangler dev` restart, or retention expiring.
    const workflow = stubs(env).workflow
    if (!workflow) throw new Error('no workflow stub')
    workflow.notFoundOnSendEvent = true

    expect((await answer(a.cookie, env, run.id, ask.id)).status).toBe(200)
    expect(workflow.created.map(c => c.id)).toEqual([run.id, `${run.id}-r1`])
    const resumed = await getRun(db, a.tenant.id, run.id)
    // Both halves of the fix: a NEW instance, and a row a narrow `claim` can still take.
    expect(resumed).toMatchObject({ instanceId: `${run.id}-r1`, status: 'running' })

    // Now be that new instance. Its first step is `claim`, which only takes `queued|running`.
    const { step, names } = createFakeWorkflowStep()
    const outcome = await new AgentRunWorkflow(createExecutionContext(), env).run(
      {
        payload: { runId: run.id, tenantId: a.tenant.id },
        timestamp: new Date(),
        instanceId: `${run.id}-r1`,
        workflowName: 'rocketflare-agent-run',
      },
      step as unknown as Parameters<AgentRunWorkflow['run']>[1]
    )
    expect(outcome.status).toBe('succeeded')
    expect(names).toEqual(['claim', 'execute#0', 'finish'])
    // `ctx.interrupt` was create-or-READ: the second ask found the first ask's answer (T2).
    expect(entries).toBe(1)
    const settled = await getRun(db, a.tenant.id, run.id)
    expect(settled).toMatchObject({ status: 'succeeded', error: null })
    expect(await listInterrupts(db, a.tenant.id, run.id, 'pending')).toEqual([])
  })
})

describe('a parked run is still THE active run', () => {
  it('a second enqueue while parked deduplicates, and a cancel expires its asks', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { run, interrupts } = await parked(env, a)
    const ask = interrupts[0]
    if (!ask) throw new Error('no ask')

    const again = await request(
      '/api/agents/runs',
      { method: 'POST', headers: a.cookie },
      { env, json: { agentKey: 'summarize-text', input: { text: 'Something else entirely.' } } }
    )
    expect(again.status).toBe(202)
    expect(await json(again)).toMatchObject({ id: run.id, deduplicated: true })

    const cancelled = await request(
      `/api/agents/runs/${run.id}/cancel`,
      { method: 'POST', headers: a.cookie },
      { env }
    )
    expect(await json(cancelled)).toMatchObject({ status: 'cancelled', error: null })
    // A question whose run is over must never sit in somebody's inbox.
    expect((await listInterrupts(db, a.tenant.id, run.id))[0]?.status).toBe('expired')
    // Answering it afterwards is the same 409 as answering it twice.
    expect((await answer(a.cookie, env, run.id, ask.id)).status).toBe(409)
  })

  it('expireParkedRun settles a park whose asks have all passed their deadline, on read (T6)', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { run } = await parked(env, a)
    // The instance died with the `waitForEvent` that would have expired this; the read path is the
    // only thing left that can free the exclusive slot.
    await db.update(agentRuns).set({ status: 'awaiting_input' }).where(eq(agentRuns.id, run.id))
    await db
      .update(agentRunInterrupts)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(agentRunInterrupts.runId, run.id))
    const detail = agentRunWithEventsSchema.parse(
      await json(await request(`/api/agents/runs/${run.id}`, { headers: a.cookie }, { env }))
    )
    expect(detail).toMatchObject({ status: 'cancelled', error: null })
    expect(detail.interrupts.map(i => i.status)).toEqual(['expired'])
  })
})

describe('POST /api/agents/runs/:id/steering', () => {
  it('appends a note to an active run and 409s a settled one', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { run } = await parked(env, a)

    const res = await request(
      `/api/agents/runs/${run.id}/steering`,
      { method: 'POST', headers: a.cookie },
      { env, json: { text: 'Focus on 2024.' } }
    )
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({
      type: 'steering',
      seq: 1,
      data: { text: 'Focus on 2024.', authorUserId: a.user.id },
    })

    await db
      .update(agentRuns)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(agentRuns.id, run.id))
    const late = await request(
      `/api/agents/runs/${run.id}/steering`,
      { method: 'POST', headers: a.cookie },
      { env, json: { text: 'Too late.' } }
    )
    expect(late.status).toBe(409)
    expect(await json(late)).toMatchObject({ statusCode: 409, details: { status: 'succeeded' } })
  })

  it('is 404 for another member’s run and 400 for an empty note', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { run } = await parked(env, a)
    const other = await memberOf(a.tenant.id)
    expect(
      (
        await request(
          `/api/agents/runs/${run.id}/steering`,
          { method: 'POST', headers: other.cookie },
          { env, json: { text: 'hello' } }
        )
      ).status
    ).toBe(404)
    expect(
      (
        await request(
          `/api/agents/runs/${run.id}/steering`,
          { method: 'POST', headers: a.cookie },
          { env, json: { text: '   ' } }
        )
      ).status
    ).toBe(400)
  })
})

describe('GET /api/agents/interrupts (the inbox)', () => {
  it('lists a member’s own pending asks, an admin’s the tenant’s, and never another tenant’s', async () => {
    const a = await actor('member')
    const env = createTestEnv()
    const mine = await parked(env, a)
    const other = await memberOf(a.tenant.id)
    const theirs = await parked(
      env,
      { user: other.user, tenant: a.tenant },
      undefined,
      'research-topic'
    )
    const elsewhere = await actor('owner')
    await parked(env, elsewhere)

    const parse = (body: unknown) => paginatedResponse(interruptInboxItemSchema).parse(body)

    const asMember = parse(
      await json(await request('/api/agents/interrupts', { headers: a.cookie }, { env }))
    )
    expect(asMember.items.map(i => i.runId)).toEqual([mine.run.id])
    expect(asMember.items[0]).toMatchObject({
      status: 'pending',
      canAnswer: true,
      run: { id: mine.run.id, agentKey: 'summarize-text', status: 'awaiting_input' },
    })

    const admin = await memberOf(a.tenant.id, 'admin')
    const asAdmin = parse(
      await json(await request('/api/agents/interrupts', { headers: admin.cookie }, { env }))
    )
    expect(new Set(asAdmin.items.map(i => i.runId))).toEqual(new Set([mine.run.id, theirs.run.id]))
    expect(asAdmin.pagination.total).toBe(2)

    // `?status=` narrows; an answered ask leaves the pending list.
    const ask = mine.interrupts[0]
    if (!ask) throw new Error('no ask')
    await answer(a.cookie, env, mine.run.id, ask.id)
    const after = parse(
      await json(await request('/api/agents/interrupts', { headers: a.cookie }, { env }))
    )
    expect(after.items).toEqual([])
    const resolved = parse(
      await json(
        await request('/api/agents/interrupts?status=resolved', { headers: a.cookie }, { env })
      )
    )
    expect(resolved.items.map(i => i.id)).toEqual([ask.id])
    expect((await request('/api/agents/interrupts')).status).toBe(401)
  })
})

describe('GET /api/agents/runs/:id', () => {
  it('carries the run’s asks and artifacts for real, and ?events=0 is the bare row', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { run, interrupts } = await parked(env, a)
    await upsertArtifact(db, a.tenant.id, run.id, {
      key: 'draft',
      title: 'Draft reply',
      data: { kind: 'markdown', markdown: 'Hello.' },
    })

    const detail = agentRunWithEventsSchema.parse(
      await json(await request(`/api/agents/runs/${run.id}`, { headers: a.cookie }, { env }))
    )
    expect(detail.interrupts.map(i => i.id)).toEqual([interrupts[0]?.id])
    expect(detail.interrupts[0]).toMatchObject({ spec: { kind: 'approval' }, status: 'pending' })
    expect(detail.artifacts.map(x => x.key)).toEqual(['draft'])

    const bare = agentRunSchema.parse(
      await json(
        await request(`/api/agents/runs/${run.id}?events=0`, { headers: a.cookie }, { env })
      )
    )
    expect(bare).toMatchObject({ id: run.id, status: 'awaiting_input' })
    expect(bare).not.toHaveProperty('events')
  })

  it('projects a parked run as the protocol’s own interrupt outcome', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { run, interrupts } = await parked(env, a)
    const body = await json<{ events: Array<{ type: string; outcome?: unknown }> }>(
      await request(`/api/agents/runs/${run.id}/agui`, { headers: a.cookie }, { env })
    )
    expect(body.events.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      outcome: { type: 'interrupt', interrupts: [{ id: interrupts[0]?.id }] },
    })
  })
})

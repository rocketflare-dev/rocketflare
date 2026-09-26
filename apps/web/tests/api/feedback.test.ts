/**
 * Thumbs feedback and the eval-case export (D33):
 *
 * - a member rates their OWN assistant message; voting again replaces the vote; the same thumb
 *   withdrawn is a DELETE; `GET /mine` draws the thumbs' state;
 * - **tenant isolation**: another tenant's message or run is a 404 exactly like an unknown id, the
 *   admin list only ever returns the caller tenant's rows, and another MEMBER's thread is a 404 too
 *   (D17 — admins included);
 * - a run is rateable by its requester and by admin-level members, nobody else;
 * - the vote lands in the answer's trace as a `feedback` span under the recorded root;
 * - `GET /api/evals/export` builds a valid `EvalCase` from a message (question, history, retrieved
 *   context, tools, observed answer, feedback) and from a run — admin+ only;
 * - spans recorded inside `withEvalScope` carry `rocketflare.eval=true`, and only those.
 */
import {
  evalExportResponseSchema,
  feedbackListResponseSchema,
  feedbackMineResponseSchema,
  feedbackSchema,
} from '@rocketflare/shared/ai/evals'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { withEvalScope } from '@/api/observability/context'
import { databaseSpanStore } from '@/api/observability/span-store'
import { traceIdForRun } from '@/api/observability/trace-ids'
import { tracerFor, withAgentTrace } from '@/api/observability/tracing'
import { loadConfig } from '@/config'
import {
  agentRunEvents,
  agentRuns,
  aiFeedback,
  aiSpans,
  conversations,
  messages,
} from '@/db/schema'
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
const cfg = loadConfig(createTestEnv())

type Role = 'owner' | 'admin' | 'member'

async function actor(role: Role = 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

/** A second person in the same tenant. */
async function colleague(tenantId: string, role: Role = 'member') {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
}

const SEARCH_RESULT = JSON.stringify({
  query: 'refund window',
  documents: [
    {
      documentId: '00000000-0000-4000-8000-000000000001',
      title: 'Refund policy',
      totalPassages: 2,
      matchingPassages: 1,
      passages: [
        { rank: 1, passage: 1, charOffset: 0, score: 0.9, text: 'Refunds within 30 days.' },
      ],
    },
  ],
  passagesReturned: 1,
})

/** A thread with one earlier exchange and a rated turn; returns the assistant answer's id. */
async function thread(tenantId: string, userId: string, traceId: string | null = null) {
  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId, userId, provider: 'anthropic', model: 'claude-test' })
    .returning()
  if (!conversation) throw new Error('no conversation')
  const at = (s: number) => new Date(Date.UTC(2026, 8, 25, 10, 0, s))
  const rows = await db
    .insert(messages)
    .values([
      { tenantId, conversationId: conversation.id, role: 'user', content: 'Hi', createdAt: at(1) },
      {
        tenantId,
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Hello!',
        createdAt: at(2),
      },
      {
        tenantId,
        conversationId: conversation.id,
        role: 'user',
        content: 'What is our refund window?',
        createdAt: at(3),
      },
      {
        tenantId,
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Refunds are accepted within 30 days.',
        toolCalls: [
          {
            id: 'call_1',
            name: 'search_knowledge',
            input: { query: 'refund window' },
            result: SEARCH_RESULT,
          },
        ],
        traceId,
        createdAt: at(4),
      },
    ])
    .returning()
  const answer = rows.at(-1)
  if (!answer) throw new Error('no answer')
  return { conversationId: conversation.id, answerId: answer.id }
}

async function run(tenantId: string, requestedByUserId: string) {
  const [row] = await db
    .insert(agentRuns)
    .values({
      tenantId,
      agentKey: 'research-topic',
      status: 'succeeded',
      input: { question: 'What is the refund window?' },
      output: { answer: 'Thirty days.', citations: [] },
      requestedByUserId,
    })
    .returning()
  if (!row) throw new Error('no run')
  await db.insert(agentRunEvents).values([
    {
      tenantId,
      runId: row.id,
      seq: 1,
      type: 'tool.start',
      data: { name: 'search_knowledge', input: { query: 'refund' } },
    },
    {
      tenantId,
      runId: row.id,
      seq: 2,
      type: 'tool.end',
      data: { name: 'search_knowledge', result: SEARCH_RESULT },
    },
  ])
  return row
}

const rate = (cookie: Record<string, string>, body: unknown) =>
  request('/api/feedback', { method: 'POST', headers: cookie }, { json: body })

describe('POST /api/feedback', () => {
  it('rates your own answer, replaces the vote, withdraws it, and reports it through /mine', async () => {
    const a = await actor()
    const { answerId } = await thread(a.tenant.id, a.user.id)

    const first = await rate(a.cookie, { target: 'message', targetId: answerId, rating: 1 })
    expect(first.status).toBe(201)
    expect(feedbackSchema.parse(await json(first))).toMatchObject({ rating: 1, comment: null })

    const second = await rate(a.cookie, {
      target: 'message',
      targetId: answerId,
      rating: -1,
      comment: 'Cited the wrong policy',
    })
    expect(feedbackSchema.parse(await json(second))).toMatchObject({
      rating: -1,
      comment: 'Cited the wrong policy',
    })
    const stored = await db
      .select()
      .from(aiFeedback)
      .where(and(eq(aiFeedback.tenantId, a.tenant.id), eq(aiFeedback.targetId, answerId)))
    expect(stored).toHaveLength(1)

    const mine = feedbackMineResponseSchema.parse(
      await json(
        await request(`/api/feedback/mine?target=message&targetIds=${answerId}`, {
          headers: a.cookie,
        })
      )
    )
    expect(mine.items.map(f => [f.targetId, f.rating])).toEqual([[answerId, -1]])

    const withdrawn = await request(`/api/feedback/message/${answerId}`, {
      method: 'DELETE',
      headers: a.cookie,
    })
    expect(withdrawn.status).toBe(204)
    expect(
      await db.select().from(aiFeedback).where(eq(aiFeedback.targetId, answerId))
    ).toHaveLength(0)
  })

  it('is tenant-scoped: another tenant’s message or run is a 404 like an unknown id', async () => {
    const a = await actor('admin')
    const b = await actor('admin')
    const { answerId } = await thread(b.tenant.id, b.user.id)
    const foreignRun = await run(b.tenant.id, b.user.id)

    for (const body of [
      { target: 'message', targetId: answerId, rating: -1 },
      { target: 'agent_run', targetId: foreignRun.id, rating: -1 },
      { target: 'message', targetId: '00000000-0000-4000-8000-00000000abcd', rating: 1 },
    ]) {
      const res = await rate(a.cookie, body)
      expect(res.status).toBe(404)
    }
    expect(
      await db.select().from(aiFeedback).where(eq(aiFeedback.tenantId, a.tenant.id))
    ).toHaveLength(0)
  })

  it('refuses another member’s thread — admins included — and a member rating someone else’s run', async () => {
    const owner = await actor('member')
    const { answerId } = await thread(owner.tenant.id, owner.user.id)
    const admin = await colleague(owner.tenant.id, 'admin')
    const member = await colleague(owner.tenant.id, 'member')
    const theirRun = await run(owner.tenant.id, owner.user.id)

    expect(
      (await rate(admin.cookie, { target: 'message', targetId: answerId, rating: 1 })).status
    ).toBe(404)
    expect(
      (await rate(member.cookie, { target: 'agent_run', targetId: theirRun.id, rating: 1 })).status
    ).toBe(404)
    // Admin-level members can read every run, so they can rate one.
    expect(
      (await rate(admin.cookie, { target: 'agent_run', targetId: theirRun.id, rating: -1 })).status
    ).toBe(201)
    expect(
      (await rate(owner.cookie, { target: 'agent_run', targetId: theirRun.id, rating: 1 })).status
    ).toBe(201)
  })

  it('records the vote as a feedback span in the rated answer’s trace', async () => {
    const a = await actor()
    // A recorded chat trace to hang the vote under.
    const tracer = tracerFor(cfg, { store: databaseSpanStore(db) })
    let traceId = ''
    await withAgentTrace('chat', { tracer, tenantId: a.tenant.id, userId: a.user.id }, async t => {
      traceId = t.traceId
    })
    await tracer.flush()
    const { answerId } = await thread(a.tenant.id, a.user.id, traceId)
    await rate(a.cookie, { target: 'message', targetId: answerId, rating: -1, comment: 'wrong' })

    const spans = await db
      .select()
      .from(aiSpans)
      .where(and(eq(aiSpans.tenantId, a.tenant.id), eq(aiSpans.traceId, traceId)))
    const root = spans.find(s => s.parentSpanId === null)
    const vote = spans.find(s => s.name === 'feedback')
    expect(vote?.parentSpanId).toBe(root?.spanId)
    expect(vote?.attributes).toMatchObject({
      'rocketflare.feedback.rating': -1,
      'rocketflare.feedback.target': 'message',
    })

    // A run's root is derived, so its vote needs no recorded root to find its parent.
    const r = await run(a.tenant.id, a.user.id)
    await rate(a.cookie, { target: 'agent_run', targetId: r.id, rating: 1 })
    const runSpans = await db
      .select()
      .from(aiSpans)
      .where(and(eq(aiSpans.tenantId, a.tenant.id), eq(aiSpans.traceId, traceIdForRun(r.id))))
    expect(runSpans.map(s => s.name)).toEqual(['feedback'])
  })
})

describe('GET /api/feedback', () => {
  it('lists only the caller tenant’s votes, filtered by rating — admin+ only', async () => {
    const a = await actor('admin')
    const b = await actor('admin')
    const mineA = await thread(a.tenant.id, a.user.id)
    const mineB = await thread(b.tenant.id, b.user.id)
    await rate(a.cookie, { target: 'message', targetId: mineA.answerId, rating: -1 })
    await rate(b.cookie, { target: 'message', targetId: mineB.answerId, rating: -1 })

    const list = feedbackListResponseSchema.parse(
      await json(await request('/api/feedback?rating=down', { headers: a.cookie }))
    )
    expect(list.items.map(f => f.targetId)).toEqual([mineA.answerId])
    const up = feedbackListResponseSchema.parse(
      await json(await request('/api/feedback?rating=up', { headers: a.cookie }))
    )
    expect(up.items).toHaveLength(0)

    const member = await colleague(a.tenant.id, 'member')
    expect((await request('/api/feedback', { headers: member.cookie })).status).toBe(403)
  })
})

describe('GET /api/evals/export', () => {
  it('drafts a case from a message: question, history, retrieved context, tools, answer, feedback', async () => {
    const a = await actor('admin')
    const { answerId } = await thread(a.tenant.id, a.user.id)
    await rate(a.cookie, {
      target: 'message',
      targetId: answerId,
      rating: -1,
      comment: 'too vague',
    })

    const res = await request(`/api/evals/export?messageId=${answerId}`, { headers: a.cookie })
    expect(res.status).toBe(200)
    const { case: draft, containsTenantData } = evalExportResponseSchema.parse(await json(res))
    expect(containsTenantData).toBe(true)
    expect(draft).toMatchObject({
      input: 'What is our refund window?',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
      context: [{ title: 'Refund policy', text: 'Refunds within 30 days.' }],
      expected: { output: 'Refunds are accepted within 30 days.', tools: ['search_knowledge'] },
      source: { kind: 'message', id: answerId, feedback: { rating: -1, comment: 'too vague' } },
    })
  })

  it('drafts a case from a run, 404s across tenants, and is admin+ only', async () => {
    const a = await actor('admin')
    const b = await actor('admin')
    const r = await run(a.tenant.id, a.user.id)
    const { case: draft } = evalExportResponseSchema.parse(
      await json(await request(`/api/evals/export?runId=${r.id}`, { headers: a.cookie }))
    )
    expect(draft).toMatchObject({
      agentKey: 'research-topic',
      input: { question: 'What is the refund window?' },
      expected: { output: { answer: 'Thirty days.' }, tools: ['search_knowledge'] },
      context: [{ title: 'Refund policy' }],
      source: { kind: 'agent_run', id: r.id },
    })

    expect((await request(`/api/evals/export?runId=${r.id}`, { headers: b.cookie })).status).toBe(
      404
    )
    const member = await colleague(a.tenant.id, 'member')
    expect(
      (await request(`/api/evals/export?runId=${r.id}`, { headers: member.cookie })).status
    ).toBe(403)
    expect((await request('/api/evals/export', { headers: a.cookie })).status).toBe(400)
  })
})

describe('eval scope', () => {
  it('marks traces started inside withEvalScope as rocketflare.eval=true, and no others', async () => {
    const a = await actor()
    const tracer = tracerFor(cfg, { store: databaseSpanStore(db) })
    const ids: Record<string, string> = {}
    await withEvalScope(() =>
      withAgentTrace('chat', { tracer, tenantId: a.tenant.id }, async t => {
        ids.inside = t.traceId
      })
    )
    await withAgentTrace('chat', { tracer, tenantId: a.tenant.id }, async t => {
      ids.outside = t.traceId
    })
    await tracer.flush()
    const spans = await db.select().from(aiSpans).where(eq(aiSpans.tenantId, a.tenant.id))
    const byTrace = (id: string | undefined) => spans.find(s => s.traceId === id)?.attributes ?? {}
    expect(byTrace(ids.inside)['rocketflare.eval']).toBe(true)
    expect(byTrace(ids.outside)['rocketflare.eval']).toBeUndefined()
  })
})

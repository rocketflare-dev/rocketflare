/**
 * The chat inspector (D17): `GET /api/chat/conversations/:id/stats` and
 * `POST /:id/compact`. Three things matter here — the gate (admin+ ON TOP of ownership, so it
 * widens what an owner sees about their own thread and never whose threads are visible), the
 * arithmetic (the panel must agree with the window the next turn will actually send), and the
 * honesty rules (an unpriced model is null and counted, never guessed at today's rate).
 */
import { conversationStatsSchema } from '@rocketflare/shared/ai/chat'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { summariseByModel } from '@/api/services/ai/chat-stats'
import { conversations, messages } from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()

/** A thread whose messages are long enough to control the window from the test. */
async function seedThread(
  role: 'owner' | 'member',
  turns: { role: 'user' | 'assistant'; chars: number; model?: string }[]
) {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId: tenant.id, userId: user.id, provider: 'workers_ai', model: 'seed-model' })
    .returning()
  if (!conversation) throw new Error('no conversation')
  let at = Date.now()
  for (const turn of turns) {
    at += 1000
    await db.insert(messages).values({
      conversationId: conversation.id,
      tenantId: tenant.id,
      role: turn.role,
      content: 'x'.repeat(turn.chars),
      createdAt: new Date(at),
      ...(turn.role === 'assistant'
        ? {
            provider: 'workers_ai' as const,
            model: turn.model ?? '@cf/zai-org/glm-4.7-flash',
            usage: { inputTokens: 100, outputTokens: 20 },
          }
        : {}),
    })
  }
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return { user, tenant, conversation, cookie }
}

describe('GET /api/chat/conversations/:id/stats', () => {
  it("is admin+ only, and never reaches another user's thread", async () => {
    const env = createTestEnv()
    const member = await seedThread('member', [{ role: 'user', chars: 10 }])
    const asMember = await request(
      `/api/chat/conversations/${member.conversation.id}/stats`,
      { headers: member.cookie },
      { env }
    )
    // The member owns this thread and can read it — the inspector is still refused.
    expect(asMember.status).toBe(403)
    expect(await asMember.json()).toMatchObject({ statusCode: 403 })
    expect(
      (
        await request(
          `/api/chat/conversations/${member.conversation.id}`,
          { headers: member.cookie },
          { env }
        )
      ).status
    ).toBe(200)

    // An owner in ANOTHER tenant gets the same 404 the thread itself gives — ownership first.
    const other = await seedThread('owner', [{ role: 'user', chars: 10 }])
    expect(
      (
        await request(
          `/api/chat/conversations/${member.conversation.id}/stats`,
          { headers: other.cookie },
          { env }
        )
      ).status
    ).toBe(404)

    expect(
      (await request(`/api/chat/conversations/${member.conversation.id}/stats`, {}, { env })).status
    ).toBe(401)
  })

  it('reports the window the next turn will send, and the headroom before trimming', async () => {
    const env = createTestEnv()
    const { conversation, cookie } = await seedThread('owner', [
      { role: 'user', chars: 500 },
      { role: 'assistant', chars: 500 },
    ])
    const stats = conversationStatsSchema.parse(
      await json(
        await request(
          `/api/chat/conversations/${conversation.id}/stats`,
          { headers: cookie },
          { env }
        )
      )
    )
    expect(stats.context.windowChars).toBe(1000)
    expect(stats.context.windowMessages).toBe(2)
    expect(stats.context.droppedMessages).toBe(0)
    // Nothing dropped yet, so the honest question is how much more fits.
    expect(stats.context.headroomChars).toBe(stats.context.budgetChars - 1000)
    expect(stats.compaction.pendingMessages).toBe(0)
    expect(stats.turns).toEqual({ user: 1, assistant: 1, toolCalls: 0 })
    // The zero-key floor resolves, so the panel can name what answers next.
    expect(stats.next).toMatchObject({ ready: true, provider: 'workers_ai', source: 'platform' })
    expect(stats.next.knowledgeTools.length).toBeGreaterThan(0)

    // The breakdown is disjoint and complete, and it includes what is sent every turn regardless
    // of the conversation — that is the number people are surprised by.
    const parts = stats.context.composition
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(stats.context.totalChars)
    expect(parts.userMessages + parts.assistantMessages).toBe(stats.context.windowChars)
    expect(parts.toolSchemas).toBeGreaterThan(0)
    expect(parts.systemPrompt).toBeGreaterThan(0)
    expect(parts.summary).toBe(0)
  })

  it('counts what fell out of the window as pending until a summary covers it', async () => {
    const env = createTestEnv()
    const cfgBudget = 24_000
    const { conversation, cookie } = await seedThread('owner', [
      { role: 'user', chars: 9_000 },
      { role: 'assistant', chars: 9_000 },
      { role: 'user', chars: 9_000 },
      { role: 'assistant', chars: 9_000 },
    ])
    const stats = conversationStatsSchema.parse(
      await json(
        await request(
          `/api/chat/conversations/${conversation.id}/stats`,
          { headers: cookie },
          { env }
        )
      )
    )
    expect(stats.context.budgetChars).toBe(cfgBudget)
    // The newest turns that fit; the rest is dropped and owed to the summary.
    expect(stats.context.droppedMessages).toBeGreaterThan(0)
    expect(stats.context.headroomChars).toBe(cfgBudget - stats.context.windowChars)
    expect(stats.compaction.pendingMessages).toBe(stats.context.droppedMessages)
    expect(stats.compaction.pendingChars).toBe(stats.context.droppedChars)
    expect(stats.compaction.summary).toBeNull()
    expect(stats.compaction.summarisedMessages).toBe(0)
  })

  it('prices per model and refuses to guess for one the table does not know', async () => {
    const env = createTestEnv()
    const { conversation, cookie } = await seedThread('owner', [
      { role: 'user', chars: 10 },
      { role: 'assistant', chars: 10, model: '@cf/zai-org/glm-4.7-flash' },
      { role: 'user', chars: 10 },
      { role: 'assistant', chars: 10, model: '@cf/some/unlisted-model' },
    ])
    const stats = conversationStatsSchema.parse(
      await json(
        await request(
          `/api/chat/conversations/${conversation.id}/stats`,
          { headers: cookie },
          { env }
        )
      )
    )
    expect(stats.byModel).toHaveLength(2)
    expect(stats.unpricedTurns).toBe(1)
    // A total that silently omitted the unpriced turn would read as the whole thread's cost.
    expect(stats.costMicrocents).not.toBeNull()
    expect(stats.usage.inputTokens).toBe(200)
  })
})

describe('POST /api/chat/conversations/:id/compact', () => {
  it('enqueues a forced summary for what is pending', async () => {
    const env = createTestEnv()
    const { conversation, cookie } = await seedThread('owner', [
      { role: 'user', chars: 20_000 },
      { role: 'assistant', chars: 20_000 },
    ])
    const res = await request(
      `/api/chat/conversations/${conversation.id}/compact`,
      { method: 'POST', headers: cookie },
      { env }
    )
    expect(res.status).toBe(202)
    // A route enqueues; it never runs a model call.
    const queued = stubs(env).queue.messages.at(-1)?.body as { type: string; payload: unknown }
    expect(queued.type).toBe('chat.compact')
    expect(queued.payload).toMatchObject({ conversationId: conversation.id, force: true })
  })

  it('409s when there is nothing outside the window, rather than queuing a guaranteed no-op', async () => {
    const env = createTestEnv()
    const { conversation, cookie } = await seedThread('owner', [{ role: 'user', chars: 10 }])
    const res = await request(
      `/api/chat/conversations/${conversation.id}/compact`,
      { method: 'POST', headers: cookie },
      { env }
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'nothing_to_compact' })
    expect(stubs(env).queue.messages).toHaveLength(0)
  })

  it('is admin+ like the stats it repairs', async () => {
    const env = createTestEnv()
    const { conversation, cookie } = await seedThread('member', [{ role: 'user', chars: 30_000 }])
    const res = await request(
      `/api/chat/conversations/${conversation.id}/compact`,
      { method: 'POST', headers: cookie },
      { env }
    )
    expect(res.status).toBe(403)
  })
})

describe('summariseByModel', () => {
  it("keeps a turn written before the model was recorded separate from today's model", async () => {
    const { tenant, conversation } = await seedThread('owner', [])
    await db.insert(messages).values([
      {
        conversationId: conversation.id,
        tenantId: tenant.id,
        role: 'assistant',
        content: 'old',
        usage: { inputTokens: 10, outputTokens: 1 },
      },
      {
        conversationId: conversation.id,
        tenantId: tenant.id,
        role: 'assistant',
        content: 'new',
        provider: 'workers_ai',
        model: '@cf/zai-org/glm-4.7-flash',
        usage: { inputTokens: 20, outputTokens: 2 },
      },
    ])
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
    const groups = summariseByModel(rows)
    expect(groups).toHaveLength(2)
    const unknown = groups.find(g => g.model === null)
    // Attributing it to today's model would price a turn at a rate it never paid.
    expect(unknown?.costMicrocents).toBeNull()
    expect(groups.find(g => g.model)?.costMicrocents).not.toBeNull()
  })
})

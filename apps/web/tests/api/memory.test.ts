// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the provider seam), so this file needs its own module registry.
/**
 * Memory (D36): the `memory.retain` job, `recall_memory`, `/api/memory`, and — the part that
 * justifies a whole file — the security boundaries:
 *
 * - a `private` memory is its owner's alone, and the D29 admin bypass does NOT reach it;
 * - only the person's own turns are ever a source (assistant replies, and so whatever the
 *   assistant read from a restricted document, never reach the extraction call);
 * - off means never learned: an opted-out turn is skipped for good, not deferred;
 * - a `supersedes` id outside the partition is dropped, whatever the model says;
 * - provenance cascades (deleting the conversation, or the membership, deletes the memories).
 *
 * The flag is turned on per TENANT with an override row, never by editing the platform row, which
 * every other file in the shared project reads.
 */

import { conversationSchema } from '@rocketflare/shared/ai/chat'
import { MEMORY_TOOLS, memoryListResponseSchema } from '@rocketflare/shared/ai/memory'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleMemoryRetain } from '@/api/queues/handlers/memory-retain'
import type { JobContext } from '@/api/queues/jobs'
import { type AccessScope, countGroupGrants, visibleMemories } from '@/api/services/access'
import { buildAgentTools } from '@/api/services/agents/tools'
import { deterministicEmbedding } from '@/api/services/ai/deterministic-embedding'
import { AiNotConfiguredError } from '@/api/services/ai/errors'
import { recallMemories } from '@/api/services/ai/memory/recall'
import { pendingUserTurns } from '@/api/services/ai/memory/retain'
import { normaliseEntityName } from '@/api/services/ai/memory/store'
import { fuseRankedArms } from '@/api/services/ai/retrieval'
import { loadConfig } from '@/config'
import {
  conversations,
  featureFlags,
  groupMembers,
  groups,
  groupTypes,
  memories,
  memoryEntities,
  memoryEntityLinks,
  memoryGroups,
  messages,
  tenantFeatureOverrides,
} from '@/db/schema'
import { aguiFrames, FakeChatClient } from '../helpers/ai'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, type RecordingQueue, stubs, type TestEnv } from '../mocks/bindings'

const state: { client: FakeChatClient | null } = { client: null }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      if (!state.client) throw new AiNotConfiguredError('chat')
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

beforeEach(() => {
  state.client = null
})

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as JobContext['logger']
}

const jobContext = (env: TestEnv): JobContext => ({
  env,
  config: loadConfig(env),
  logger: fakeLogger(),
  db,
})

/** The flag, on for ONE tenant — an override needs the platform row to exist, at its default. */
async function enableMemory(tenantId: string) {
  await db.insert(featureFlags).values({ key: 'memory', state: 'off' }).onConflictDoNothing()
  await db
    .insert(tenantFeatureOverrides)
    .values({ tenantId, flagKey: 'memory', enabled: true })
    .onConflictDoNothing()
}

interface Fact {
  text: string
  kind?: 'event' | 'preference' | 'fact'
  occurredStart?: string
  occurredEnd?: string
  entities?: string[]
  supersedes?: string[]
}

function extractor(...passes: Fact[][]) {
  state.client = new FakeChatClient(
    passes.map(facts => ({ toolUses: [{ name: 'submit_memories', input: { facts } }] })),
    'anthropic_compatible'
  )
  return state.client
}

async function person(role: 'member' | 'admin' | 'owner' = 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function colleague(tenantId: string, role: 'member' | 'admin' | 'owner' = 'member') {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
}

async function thread(
  tenantId: string,
  userId: string,
  turns: { role: 'user' | 'assistant'; content: string }[]
) {
  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId, userId, provider: 'anthropic_compatible', model: 'fake-model' })
    .returning()
  if (!conversation) throw new Error('no conversation')
  const rows = await db
    .insert(messages)
    .values(
      turns.map((t, i) => ({
        conversationId: conversation.id,
        tenantId,
        role: t.role,
        content: t.content,
        createdAt: new Date(Date.now() - (turns.length - i) * 60_000),
      }))
    )
    .returning()
  return { conversation, rows }
}

async function addTurns(
  tenantId: string,
  conversationId: string,
  turns: { role: 'user' | 'assistant'; content: string }[]
) {
  return db
    .insert(messages)
    .values(
      turns.map((t, i) => ({
        conversationId,
        tenantId,
        role: t.role,
        content: t.content,
        createdAt: new Date(Date.now() + (i + 1) * 1_000),
      }))
    )
    .returning()
}

const retainJob = (tenantId: string, conversationId: string, messageId?: string) =>
  ({
    id: crypto.randomUUID(),
    type: 'memory.retain' as const,
    enqueuedAt: new Date().toISOString(),
    payload: { tenantId, conversationId, messageId },
  }) as never

const ownerScope = (tenantId: string, userId: string, bypass = false): AccessScope => ({
  tenantId,
  userId,
  groupIds: [],
  bypass,
})

const LISBON = 'I moved to Lisbon in March and I now lead the Payments team with Sam.'

async function factsOf(tenantId: string, userId: string) {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.tenantId, tenantId), eq(memories.ownerUserId, userId)))
}

describe('pure pieces', () => {
  it('pendingUserTurns: after the watermark, from the trigger on a first pass, nothing otherwise', () => {
    const rows = [
      { id: 'a', role: 'user' },
      { id: 'b', role: 'assistant' },
      { id: 'c', role: 'user' },
      { id: 'd', role: 'assistant' },
    ] as const
    expect(pendingUserTurns([...rows], 'b', undefined)).toEqual({ pending: [2], through: 3 })
    // First pass: from the turn that triggered it — never the top of an old thread.
    expect(pendingUserTurns([...rows], null, 'c')).toEqual({ pending: [2], through: 3 })
    expect(pendingUserTurns([...rows], null, undefined)).toBeNull()
    expect(pendingUserTurns([...rows], 'd', undefined)).toBeNull()
  })

  it('normaliseEntityName folds case, spacing and surrounding punctuation', () => {
    expect(normaliseEntityName('  "Sam  O’Neil",  ')).toBe('sam o’neil')
    expect(normaliseEntityName('Payments Team')).toBe(normaliseEntityName('payments   team'))
  })

  it('fuseRankedArms sums reciprocal ranks across any number of arms', () => {
    const fused = fuseRankedArms({ dense: ['a', 'b'], lexical: ['b'], entity: ['c', 'b'] }, x => x)
    expect(fused.map(f => f.item)).toEqual(['b', 'a', 'c'])
    expect(fused[0]?.ranks).toEqual({ dense: 2, lexical: 1, entity: 2 })
  })
})

describe('the memory.retain job', () => {
  it('learns dated facts and their entities from the USER turns only, and moves the watermark', async () => {
    const p = await person()
    await enableMemory(p.tenant.id)
    const t = await thread(p.tenant.id, p.user.id, [
      { role: 'user', content: LISBON },
      // What the assistant said — including anything it read from a document — is never a source.
      {
        role: 'assistant',
        content: 'SECRET-FROM-A-RESTRICTED-DOCUMENT: the merger closes Friday.',
      },
    ])
    const client = extractor([
      {
        text: 'Lives in Lisbon',
        kind: 'fact',
        occurredStart: '2026-03-01',
        entities: ['Lisbon'],
      },
      { text: 'Leads the Payments team with Sam', entities: ['Payments', 'Sam'] },
    ])
    await handleMemoryRetain(
      retainJob(p.tenant.id, t.conversation.id, t.rows[0]?.id),
      jobContext(createTestEnv())
    )

    const sent = JSON.stringify(client.calls[0]?.messages)
    expect(sent).toContain('moved to Lisbon')
    expect(sent).not.toContain('SECRET-FROM-A-RESTRICTED-DOCUMENT')

    const rows = await factsOf(p.tenant.id, p.user.id)
    expect(rows.map(r => r.text).sort()).toEqual([
      'Leads the Payments team with Sam',
      'Lives in Lisbon',
    ])
    const lisbon = rows.find(r => r.text === 'Lives in Lisbon')
    expect(lisbon).toMatchObject({ visibility: 'private', sourceConversationId: t.conversation.id })
    expect(lisbon?.occurredStart?.toISOString()).toBe('2026-03-01T00:00:00.000Z')
    expect(lisbon?.sourceMessageIds).toEqual([t.rows[0]?.id])

    const entities = await db
      .select()
      .from(memoryEntities)
      .where(eq(memoryEntities.tenantId, p.tenant.id))
    expect(entities.map(e => e.normalisedName).sort()).toEqual(['lisbon', 'payments', 'sam'])

    const [after] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, t.conversation.id))
    expect(after?.memoryRetainedThroughId).toBe(t.rows[1]?.id)
  })

  it('a second delivery of the same turns is a no-op', async () => {
    const p = await person()
    await enableMemory(p.tenant.id)
    const t = await thread(p.tenant.id, p.user.id, [{ role: 'user', content: LISBON }])
    extractor([{ text: 'Lives in Lisbon' }])
    const job = retainJob(p.tenant.id, t.conversation.id, t.rows[0]?.id)
    await handleMemoryRetain(job, jobContext(createTestEnv()))
    await handleMemoryRetain(job, jobContext(createTestEnv()))
    expect(await factsOf(p.tenant.id, p.user.id)).toHaveLength(1)
  })

  it('supersedes what changed — only within the partition, whatever ids the model names', async () => {
    const p = await person()
    const other = await colleague(p.tenant.id)
    await enableMemory(p.tenant.id)
    const t = await thread(p.tenant.id, p.user.id, [
      { role: 'user', content: 'I live in Porto and I work on the billing platform.' },
    ])
    extractor([{ text: 'Lives in Porto', entities: ['Porto'] }])
    await handleMemoryRetain(
      retainJob(p.tenant.id, t.conversation.id, t.rows[0]?.id),
      jobContext(createTestEnv())
    )
    const [porto] = await factsOf(p.tenant.id, p.user.id)

    // Someone else's memory in the same tenant: a supersede naming it must not touch it.
    const [foreign] = await db
      .insert(memories)
      .values({
        tenantId: p.tenant.id,
        ownerUserId: other.user.id,
        text: 'Lives in Porto',
        embedding: deterministicEmbedding('Lives in Porto'),
      })
      .returning()

    const [next] = await addTurns(p.tenant.id, t.conversation.id, [
      { role: 'user', content: 'Big news: I have just moved to Lisbon for good.' },
    ])
    extractor([
      {
        text: 'Lives in Lisbon',
        entities: ['Lisbon'],
        supersedes: [porto?.id ?? '', foreign?.id ?? ''],
      },
    ])
    await handleMemoryRetain(
      retainJob(p.tenant.id, t.conversation.id, next?.id),
      jobContext(createTestEnv())
    )

    const mine = await factsOf(p.tenant.id, p.user.id)
    const lisbon = mine.find(m => m.text === 'Lives in Lisbon')
    const oldPorto = mine.find(m => m.id === porto?.id)
    expect(oldPorto?.invalidatedAt).toBeInstanceOf(Date)
    expect(oldPorto?.supersededById).toBe(lisbon?.id)
    const [stillForeign] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, foreign?.id ?? ''))
    expect(stillForeign?.invalidatedAt).toBeNull()

    const env = createTestEnv()
    const cfg = loadConfig(env)
    const scope = ownerScope(p.tenant.id, p.user.id)
    const now = await recallMemories(db, cfg, env, scope, { query: 'where do I live', limit: 10 })
    expect(now.map(h => h.memory.text)).toEqual(['Lives in Lisbon'])
    const ever = await recallMemories(db, cfg, env, scope, {
      query: 'where do I live',
      limit: 10,
      includeHistorical: true,
    })
    expect(ever.map(h => h.memory.text).sort()).toEqual(['Lives in Lisbon', 'Lives in Porto'])
  })

  it('drops a near-duplicate of something already remembered', async () => {
    const p = await person()
    await enableMemory(p.tenant.id)
    const t = await thread(p.tenant.id, p.user.id, [{ role: 'user', content: LISBON }])
    extractor([{ text: 'Lives in Lisbon' }], [{ text: 'Lives in Lisbon' }])
    await handleMemoryRetain(
      retainJob(p.tenant.id, t.conversation.id, t.rows[0]?.id),
      jobContext(createTestEnv())
    )
    const [next] = await addTurns(p.tenant.id, t.conversation.id, [
      { role: 'user', content: 'As I said, I live in Lisbon these days, by the river.' },
    ])
    await handleMemoryRetain(
      retainJob(p.tenant.id, t.conversation.id, next?.id),
      jobContext(createTestEnv())
    )
    expect(await factsOf(p.tenant.id, p.user.id)).toHaveLength(1)
  })

  it('off means never learned: an opted-out turn is skipped for good', async () => {
    const p = await person()
    await enableMemory(p.tenant.id)
    const off = await request(
      '/api/memory/settings',
      { method: 'PUT', headers: p.cookie },
      { json: { enabled: false } }
    )
    expect(off.status).toBe(200)
    const t = await thread(p.tenant.id, p.user.id, [{ role: 'user', content: LISBON }])
    const client = extractor([{ text: 'Lives in Lisbon' }])
    await handleMemoryRetain(
      retainJob(p.tenant.id, t.conversation.id, t.rows[0]?.id),
      jobContext(createTestEnv())
    )
    expect(client.calls).toHaveLength(0)
    const [after] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, t.conversation.id))
    expect(after?.memoryRetainedThroughId).toBe(t.rows[0]?.id)

    // Switched back on: the next pass starts AFTER what was said while it was off.
    await request(
      '/api/memory/settings',
      { method: 'PUT', headers: p.cookie },
      { json: { enabled: true } }
    )
    const [next] = await addTurns(p.tenant.id, t.conversation.id, [
      { role: 'user', content: 'My favourite editor is Helix and I use it every day.' },
    ])
    extractor([{ text: 'Prefers the Helix editor', kind: 'preference' }])
    await handleMemoryRetain(
      retainJob(p.tenant.id, t.conversation.id, next?.id),
      jobContext(createTestEnv())
    )
    const sent = JSON.stringify(state.client?.calls[0]?.messages)
    expect(sent).toContain('Helix')
    expect(sent).not.toContain('Lisbon')
  })

  it('with no provider the watermark stays, so the turns are learned once one exists', async () => {
    const p = await person()
    await enableMemory(p.tenant.id)
    const t = await thread(p.tenant.id, p.user.id, [{ role: 'user', content: LISBON }])
    await handleMemoryRetain(
      retainJob(p.tenant.id, t.conversation.id, t.rows[0]?.id),
      jobContext(createTestEnv())
    )
    const [after] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, t.conversation.id))
    expect(after?.memoryRetainedThroughId).toBeNull()
    expect(await factsOf(p.tenant.id, p.user.id)).toHaveLength(0)
  })
})

/** Insert a memory directly — what phase 3's knowledge-derived rows will look like. */
async function seedMemory(values: {
  tenantId: string
  ownerUserId: string | null
  text: string
  visibility?: 'private' | 'groups' | 'tenant'
  occurredStart?: Date
  entities?: string[]
}) {
  const [row] = await db
    .insert(memories)
    .values({
      tenantId: values.tenantId,
      ownerUserId: values.ownerUserId,
      text: values.text,
      visibility: values.visibility ?? 'private',
      occurredStart: values.occurredStart,
      embedding: deterministicEmbedding(values.text),
      textSignals: (values.entities ?? []).join(' '),
    })
    .returning()
  if (!row) throw new Error('no memory')
  for (const name of values.entities ?? []) {
    const [entity] = await db
      .insert(memoryEntities)
      .values({
        tenantId: values.tenantId,
        ownerUserId: values.ownerUserId,
        name,
        normalisedName: normaliseEntityName(name),
        mentionCount: 1,
      })
      .onConflictDoUpdate({
        target: [
          memoryEntities.tenantId,
          memoryEntities.ownerUserId,
          memoryEntities.normalisedName,
        ],
        set: { mentionCount: 2 },
      })
      .returning()
    await db
      .insert(memoryEntityLinks)
      .values({ tenantId: values.tenantId, memoryId: row.id, entityId: entity?.id ?? '' })
  }
  return row
}

describe('recall', () => {
  it('finds facts by meaning, words, entity and time — inside the reader’s partition only', async () => {
    const p = await person()
    const admin = await colleague(p.tenant.id, 'admin')
    const env = createTestEnv()
    const cfg = loadConfig(env)
    await seedMemory({
      tenantId: p.tenant.id,
      ownerUserId: p.user.id,
      text: 'Sam is their manager',
      entities: ['Sam'],
    })
    await seedMemory({
      tenantId: p.tenant.id,
      ownerUserId: p.user.id,
      text: 'Shipped the invoicing rewrite',
      occurredStart: new Date('2025-11-10'),
    })
    await seedMemory({
      tenantId: p.tenant.id,
      ownerUserId: admin.user.id,
      text: 'Sam owes the admin a coffee',
      entities: ['Sam'],
    })

    const mine = ownerScope(p.tenant.id, p.user.id)
    const bySam = await recallMemories(db, cfg, env, mine, { query: 'who is Sam', limit: 10 })
    expect(bySam.map(h => h.memory.text)).toEqual(expect.arrayContaining(['Sam is their manager']))
    expect(bySam.map(h => h.memory.text)).not.toContain('Sam owes the admin a coffee')
    expect(bySam[0]?.ranks.entity).toBe(1)

    const november = await recallMemories(db, cfg, env, mine, {
      query: 'what happened',
      limit: 10,
      from: new Date('2025-11-01'),
      to: new Date('2025-11-30'),
    })
    expect(november.map(h => h.memory.text)).toEqual(['Shipped the invoicing rewrite'])

    // An ADMIN — bypass and all — recalls nothing of another person's private memory.
    const asAdmin = await recallMemories(
      db,
      cfg,
      env,
      ownerScope(p.tenant.id, admin.user.id, true),
      {
        query: 'Sam manager',
        limit: 10,
      }
    )
    expect(asAdmin.map(h => h.memory.text)).toEqual(['Sam owes the admin a coffee'])
  })

  it('visibleMemories: groups and tenant rows follow D29, private rows never bypass', async () => {
    const p = await person()
    const other = await colleague(p.tenant.id)
    const [type] = await db
      .insert(groupTypes)
      .values({ tenantId: p.tenant.id, name: 'Department' })
      .returning()
    const [finance] = await db
      .insert(groups)
      .values({ tenantId: p.tenant.id, groupTypeId: type?.id ?? '', name: 'Finance' })
      .returning()
    await db
      .insert(groupMembers)
      .values({ tenantId: p.tenant.id, groupId: finance?.id ?? '', userId: p.user.id })
    const shared = await seedMemory({
      tenantId: p.tenant.id,
      ownerUserId: null,
      text: 'Quarter closes on the 5th',
      visibility: 'groups',
    })
    await db
      .insert(memoryGroups)
      .values({ tenantId: p.tenant.id, memoryId: shared.id, groupId: finance?.id ?? '' })
    const everyone = await seedMemory({
      tenantId: p.tenant.id,
      ownerUserId: null,
      text: 'Office closes at 6pm',
      visibility: 'tenant',
    })
    const privateToOther = await seedMemory({
      tenantId: p.tenant.id,
      ownerUserId: other.user.id,
      text: 'Allergic to peanuts',
    })

    const visible = async (scope: AccessScope) =>
      (
        await db
          .select({ id: memories.id })
          .from(memories)
          .where(and(eq(memories.tenantId, p.tenant.id), visibleMemories(scope)))
      ).map(r => r.id)

    const inFinance = { ...ownerScope(p.tenant.id, p.user.id), groupIds: [finance?.id ?? ''] }
    expect((await visible(inFinance)).sort()).toEqual([shared.id, everyone.id].sort())
    expect(await visible(ownerScope(p.tenant.id, other.user.id))).toEqual(
      expect.arrayContaining([everyone.id, privateToOther.id])
    )
    expect(await visible(ownerScope(p.tenant.id, other.user.id))).not.toContain(shared.id)
    const asAdmin = await visible(ownerScope(p.tenant.id, p.user.id, true))
    expect(asAdmin).toEqual(expect.arrayContaining([shared.id, everyone.id]))
    expect(asAdmin).not.toContain(privateToOther.id)

    // A group still granting a memory is counted, so deleting it says so (409 group_in_use).
    const usage = await countGroupGrants(db, p.tenant.id, [finance?.id ?? ''])
    expect(usage.memories).toBe(1)
  })

  it('recall_memory is a tool only for a person with memory on', async () => {
    const p = await person()
    const env = createTestEnv()
    const base = { db, cfg: loadConfig(env), env, scope: ownerScope(p.tenant.id, p.user.id) }
    expect((await buildAgentTools(base)).map(t => t.name)).not.toContain(MEMORY_TOOLS.recall)
    expect((await buildAgentTools({ ...base, memory: true })).map(t => t.name)).toContain(
      MEMORY_TOOLS.recall
    )
    // A run with no requester has no memory to recall, whatever the caller says.
    const system = { ...base, scope: { ...base.scope, userId: null }, memory: true }
    expect((await buildAgentTools(system)).map(t => t.name)).not.toContain(MEMORY_TOOLS.recall)

    await seedMemory({
      tenantId: p.tenant.id,
      ownerUserId: p.user.id,
      text: 'Prefers async stand-ups',
    })
    const tool = (await buildAgentTools({ ...base, memory: true })).find(
      t => t.name === MEMORY_TOOLS.recall
    )
    const answer = JSON.parse((await tool?.handler?.({ query: 'stand-ups' })) ?? '{}')
    expect(answer.facts[0]).toMatchObject({ text: 'Prefers async stand-ups', entities: [] })
    expect(answer.facts[0].said).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('/api/memory', () => {
  it('is dark until the organisation has the flag', async () => {
    const p = await person()
    const res = await request('/api/memory', { headers: p.cookie })
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({
      error: expect.any(String),
      statusCode: 404,
      code: 'feature_disabled',
    })
  })

  it('401 without a session', async () => {
    const res = await request('/api/memory')
    expect(res.status).toBe(401)
  })

  it('tenant B never sees tenant A’s memories, even of the same person', async () => {
    const a = await person()
    await enableMemory(a.tenant.id)
    const b = await createTestTenantWithUser(db, 'member')
    await linkUserToTenant(db, a.user.id, b.tenant.id, 'owner')
    await enableMemory(b.tenant.id)
    await seedMemory({ tenantId: a.tenant.id, ownerUserId: a.user.id, text: 'Tenant A secret' })
    const inB = sessionCookieHeader(await createTestSession(db, a.user.id, b.tenant.id))
    const list = memoryListResponseSchema.parse(
      await json(await request('/api/memory', { headers: inB }))
    )
    expect(list.items).toEqual([])
    const env = createTestEnv()
    const hits = await recallMemories(
      db,
      loadConfig(env),
      env,
      ownerScope(b.tenant.id, a.user.id),
      {
        query: 'Tenant A secret',
        limit: 10,
      }
    )
    expect(hits).toEqual([])
  })

  it('lists and forgets your own; another person’s memory is a 404, admins included', async () => {
    const p = await person('owner')
    const member = await colleague(p.tenant.id)
    await enableMemory(p.tenant.id)
    const mine = await seedMemory({
      tenantId: p.tenant.id,
      ownerUserId: member.user.id,
      text: 'Works remotely on Fridays',
      entities: ['Fridays'],
    })

    const list = memoryListResponseSchema.parse(
      await json(await request('/api/memory', { headers: member.cookie }))
    )
    expect(list.items.map(i => i.text)).toEqual(['Works remotely on Fridays'])
    expect(list.items[0]?.entities.map(e => e.name)).toEqual(['Fridays'])

    // The owner of the WORKSPACE sees none of it and cannot delete it.
    const ownersView = memoryListResponseSchema.parse(
      await json(await request('/api/memory', { headers: p.cookie }))
    )
    expect(ownersView.items).toEqual([])
    const refused = await request(`/api/memory/${mine.id}`, { method: 'DELETE', headers: p.cookie })
    expect(refused.status).toBe(404)

    const forgot = await request(`/api/memory/${mine.id}`, {
      method: 'DELETE',
      headers: member.cookie,
    })
    expect(forgot.status).toBe(204)
    // The entity only that fact named goes with it.
    const left = await db
      .select()
      .from(memoryEntities)
      .where(eq(memoryEntities.ownerUserId, member.user.id))
    expect(left).toEqual([])
  })

  it('forget-all, settings, and the cascades', async () => {
    const p = await person('owner')
    const member = await colleague(p.tenant.id)
    await enableMemory(p.tenant.id)
    await seedMemory({ tenantId: p.tenant.id, ownerUserId: member.user.id, text: 'Likes tea' })
    await seedMemory({ tenantId: p.tenant.id, ownerUserId: member.user.id, text: 'Likes cats' })

    const settings = await json(await request('/api/memory/settings', { headers: member.cookie }))
    expect(settings).toEqual({ available: true, enabled: true })

    const all = await request('/api/memory', { method: 'DELETE', headers: member.cookie })
    expect(await json(all)).toEqual({ deleted: 2 })

    // Deleting the conversation deletes what was learned from it.
    const t = await thread(p.tenant.id, member.user.id, [{ role: 'user', content: LISBON }])
    await db.insert(memories).values({
      tenantId: p.tenant.id,
      ownerUserId: member.user.id,
      text: 'Lives in Lisbon',
      embedding: deterministicEmbedding('Lives in Lisbon'),
      sourceConversationId: t.conversation.id,
    })
    const del = await request(`/api/chat/conversations/${t.conversation.id}`, {
      method: 'DELETE',
      headers: member.cookie,
    })
    expect(del.status).toBe(204)
    expect(await factsOf(p.tenant.id, member.user.id)).toHaveLength(0)

    // Leaving the organisation takes the memory with the membership.
    await seedMemory({ tenantId: p.tenant.id, ownerUserId: member.user.id, text: 'Likes jazz' })
    const removed = await request(`/api/members/${member.user.id}`, {
      method: 'DELETE',
      headers: p.cookie,
    })
    expect(removed.status).toBe(204)
    expect(await factsOf(p.tenant.id, member.user.id)).toHaveLength(0)
  })
})

describe('the chat turn', () => {
  it('enqueues memory.retain and offers recall_memory when the organisation has memory on', async () => {
    const p = await person()
    await enableMemory(p.tenant.id)
    const env = createTestEnv()
    state.client = new FakeChatClient([{ text: 'Noted.' }], 'anthropic_compatible')
    const created = await request(
      '/api/chat/conversations',
      { method: 'POST', headers: p.cookie },
      { env }
    )
    const conv = conversationSchema.parse(await json(created))
    const frames = await aguiFrames(
      await request(
        `/api/chat/conversations/${conv.id}/messages`,
        { method: 'POST', headers: p.cookie },
        { env, json: { content: LISBON } }
      )
    )
    const snapshot = frames.find(f => f.type === 'STATE_SNAPSHOT')
    expect(JSON.stringify(snapshot)).toContain(MEMORY_TOOLS.recall)
    const queue = stubs(env).queue as RecordingQueue<{ type: string; payload: unknown }>
    const retain = queue.messages.find(m => m.body.type === 'memory.retain')
    expect(retain?.body.payload).toMatchObject({ tenantId: p.tenant.id, conversationId: conv.id })
  })

  it('does neither without the flag', async () => {
    const p = await person()
    const env = createTestEnv()
    state.client = new FakeChatClient([{ text: 'Noted.' }], 'anthropic_compatible')
    const created = await request(
      '/api/chat/conversations',
      { method: 'POST', headers: p.cookie },
      { env }
    )
    const conv = conversationSchema.parse(await json(created))
    const frames = await aguiFrames(
      await request(
        `/api/chat/conversations/${conv.id}/messages`,
        { method: 'POST', headers: p.cookie },
        { env, json: { content: LISBON } }
      )
    )
    expect(JSON.stringify(frames.find(f => f.type === 'STATE_SNAPSHOT'))).not.toContain(
      MEMORY_TOOLS.recall
    )
    const queue = stubs(env).queue as RecordingQueue<{ type: string }>
    expect(queue.messages.some(m => m.body.type === 'memory.retain')).toBe(false)
  })
})

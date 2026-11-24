/**
 * Contextual chunk prefixes (#148) against real Postgres, with a scripted `FakeChatClient` as the
 * model: when `document.contextualize` is enqueued (flag on, text changed), what the job asks
 * (the document as the cached system prompt, the passage as the user turn), what it writes (the
 * context, its model, a re-embed WITH the context, the keyword index reading it), the gates
 * (flag off, content changed, nothing left, daily cap), a re-index of the same text keeping the
 * contexts and of new text dropping them, metering, and the backfill route (404 flag off, 403
 * member, 401, tenant isolation). The pure halves are `tests/config/knowledge-context.test.ts`.
 */

import {
  type ContextualizeBackfillResponse,
  contextualizeBackfillResponseSchema,
  documentFacetsSchema,
} from '@rocketflare/shared/ai/embeddings'
import type { JobEnvelope } from '@rocketflare/shared/jobs'
import { and, asc, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleDocumentContextualize } from '@/api/queues/handlers/document-contextualize'
import type { JobContext } from '@/api/queues/jobs'
import { contextualizeDocument } from '@/api/services/ai/contextualize'
import { AiNotConfiguredError } from '@/api/services/ai/errors'
import { indexDocument, ingestText } from '@/api/services/ai/ingest'
import { overrideResolveChatForTests } from '@/api/services/ai/resolve'
import { setTenantOverride } from '@/api/services/features'
import { buildJobEnvelope } from '@/api/services/jobs'
import { loadConfig } from '@/config'
import { aiUsage, chunks, documents } from '@/db/schema'
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
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const state: { client: FakeChatClient | null } = { client: null }

overrideResolveChatForTests(async () => {
  if (!state.client) throw new AiNotConfiguredError('chat')
  return {
    client: state.client,
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    source: 'tenant',
    billedToPlatform: false,
    maxOutputTokens: 4096,
  }
})

const db = setupTestDatabase()

/** Three sections, each long enough to be its own passage. */
const section = (heading: string, sentence: string) =>
  `## ${heading}\n\n${`${sentence} `.repeat(Math.ceil(3000 / (sentence.length + 1)))}`
const CONTRACT = [
  '# Winter services agreement',
  section('Scope', 'The provider grits the car park and the side path before eight.'),
  section('Price', 'The fee rises to three hundred pounds from April.'),
  section('Termination', 'Either side may end the agreement with thirty days notice.'),
].join('\n\n')

/** The model answers each passage with a context naming its heading. */
function situating() {
  state.client = new FakeChatClient(params => {
    const passage = JSON.stringify(params.messages)
    const heading = /Price/.test(passage)
      ? 'price'
      : /Termination/.test(passage)
        ? 'termination'
        : 'scope'
    return { text: `“From Brightside Bakery's gritting contract; the ${heading} section.”` }
  })
  return state.client
}

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as JobContext['logger']
}

let env: TestEnv
let cfg: ReturnType<typeof loadConfig>

beforeEach(() => {
  env = createTestEnv()
  cfg = loadConfig(env)
  state.client = null
})

async function world(options: { flag?: boolean } = {}) {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  if (options.flag !== false) {
    await setTenantOverride(db, 'knowledge-context', tenant.id, true, user.id)
  }
  return {
    tenantId: tenant.id,
    userId: user.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function addDoc(w: { tenantId: string; userId: string }, text = CONTRACT) {
  const { document } = await ingestText(
    db,
    cfg,
    env,
    { tenantId: w.tenantId, userId: w.userId, title: 'Gritting contract', text },
    { jobs: env.JOBS_QUEUE }
  )
  return document
}

const chunksOf = (tenantId: string, documentId: string) =>
  db
    .select({
      id: chunks.id,
      text: chunks.text,
      context: chunks.context,
      contextModel: chunks.contextModel,
    })
    .from(chunks)
    .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, documentId)))
    .orderBy(asc(chunks.seq))

const contextMessages = (e: TestEnv) =>
  stubs(e).queue.messages.filter(m => (m.body as JobEnvelope).type === 'document.contextualize')

const run = (w: { tenantId: string }, documentId: string, extra = {}) =>
  contextualizeDocument(
    db,
    cfg,
    env,
    { tenantId: w.tenantId, documentId },
    { jobs: env.JOBS_QUEUE, ...extra }
  )

describe('enqueue', () => {
  it('an index whose text changed enqueues document.contextualize with the content hash', async () => {
    const w = await world()
    const doc = await addDoc(w)
    const [message] = contextMessages(env)
    expect(message).toBeDefined()
    expect((message as { body: JobEnvelope }).body.payload).toEqual({
      tenantId: w.tenantId,
      documentId: doc.id,
      contentHash: doc.contentHash,
    })
  })

  it('nothing is enqueued without the flag, and the job itself skips', async () => {
    const w = await world({ flag: false })
    const doc = await addDoc(w)
    expect(contextMessages(env)).toHaveLength(0)
    situating()
    expect(await run(w, doc.id)).toMatchObject({ status: 'skipped', reason: 'feature_off' })
    expect(state.client?.calls).toHaveLength(0)
  })
})

describe('contextualizeDocument', () => {
  it('writes a context per passage, re-embeds with it and the keyword index reads it', async () => {
    const w = await world()
    const doc = await addDoc(w)
    const before = await chunksOf(w.tenantId, doc.id)
    expect(before.length).toBeGreaterThanOrEqual(3)
    expect(before.every(c => c.context === null)).toBe(true)
    const client = situating()
    stubs(env).ai?.runs.splice(0)

    const report = await run(w, doc.id)
    expect(report).toMatchObject({ status: 'contextualized', written: before.length, empty: 0 })

    const after = await chunksOf(w.tenantId, doc.id)
    expect(after.map(c => c.text)).toEqual(before.map(c => c.text))
    for (const c of after) {
      // Quotes stripped; the model's answer stored as the context, never as the text.
      expect(c.context).toMatch(/^From Brightside Bakery's gritting contract; the \w+ section\.$/)
      expect(c.contextModel).toBe('claude-haiku-5-5')
    }

    // One call per passage: the document as the STABLE (cached) system prompt, the passage the user turn.
    expect(client.calls).toHaveLength(before.length)
    for (const call of client.calls) {
      expect(call.system).toMatchObject({ stable: expect.stringContaining('<document') })
      expect(JSON.stringify(call.system)).toContain('fee rises to three hundred pounds')
      expect(JSON.stringify(call.messages)).toContain('<passage>')
    }

    // Re-embedded with the context in front of the passage.
    const embedded = (stubs(env).ai?.runs ?? [])
      .flatMap(r => (Array.isArray(r.inputs.text) ? (r.inputs.text as string[]) : []))
      .filter(t => t.includes('gritting contract;'))
    expect(embedded).toHaveLength(before.length)

    // "Brightside" appears only in the contexts: the generated tsvector now finds every passage.
    const [hit] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(chunks)
      .where(
        and(
          eq(chunks.tenantId, w.tenantId),
          eq(chunks.documentId, doc.id),
          sql`${chunks.searchVector} @@ to_tsquery('english', 'brightside')`
        )
      )
    expect(hit?.n).toBe(before.length)

    // Metered: one knowledge.context row per call, plus the re-embed.
    const usage = await db
      .select({ feature: aiUsage.feature })
      .from(aiUsage)
      .where(eq(aiUsage.tenantId, w.tenantId))
    expect(usage.filter(u => u.feature === 'knowledge.context')).toHaveLength(before.length)
    expect(usage.some(u => u.feature === 'knowledge.embeddings')).toBe(true)

    // Idempotent: a second run asks nothing.
    expect(await run(w, doc.id)).toMatchObject({ status: 'skipped', reason: 'nothing_to_do' })
    expect(client.calls).toHaveLength(before.length)
  })

  it('an empty answer leaves the passage without a context', async () => {
    const w = await world()
    const doc = await addDoc(w)
    state.client = new FakeChatClient([{ text: '  ""  ' }])
    const report = await run(w, doc.id)
    expect(report.written).toBe(0)
    expect(report.empty).toBe(report.pending)
    expect((await chunksOf(w.tenantId, doc.id)).every(c => c.context === null)).toBe(true)
  })

  it('a document edited since the enqueue is skipped', async () => {
    const w = await world()
    const doc = await addDoc(w)
    situating()
    const report = await contextualizeDocument(db, cfg, env, {
      tenantId: w.tenantId,
      documentId: doc.id,
      contentHash: 'not-the-current-hash',
    })
    expect(report).toMatchObject({ status: 'skipped', reason: 'content_changed' })
    expect(state.client?.calls).toHaveLength(0)
  })

  it('another tenant’s document is a document_missing', async () => {
    const a = await world()
    const b = await world()
    const doc = await addDoc(a)
    situating()
    expect(await run(b, doc.id)).toMatchObject({ status: 'skipped', reason: 'document_missing' })
    expect((await chunksOf(a.tenantId, doc.id)).every(c => c.context === null)).toBe(true)
  })

  it('no chat model skips without failing', async () => {
    const w = await world()
    const doc = await addDoc(w)
    expect(await run(w, doc.id)).toMatchObject({ status: 'skipped', reason: 'no_chat_model' })
  })

  it('the daily cap re-enqueues for the next UTC day and asks nothing', async () => {
    const capped = createTestEnv({ KNOWLEDGE_TENANT_DAILY_COST_USD: '0.01' } as never)
    const cappedCfg = loadConfig(capped)
    const w = await world()
    const doc = await addDoc(w)
    await db.insert(aiUsage).values({
      tenantId: w.tenantId,
      feature: 'knowledge.extraction',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      inputTokens: 1,
      outputTokens: 1,
      costMicrocents: 5_000_000, // $0.05, over the cap
      at: new Date('2026-05-18T22:00:00Z'),
    })
    situating()
    const report = await contextualizeDocument(
      db,
      cappedCfg,
      capped,
      { tenantId: w.tenantId, documentId: doc.id },
      { jobs: capped.JOBS_QUEUE, now: () => new Date('2026-05-18T23:00:00Z') }
    )
    expect(report).toMatchObject({ status: 'paused', reason: 'daily_cap', delaySeconds: 3660 })
    expect(state.client?.calls).toHaveLength(0)
    const [message] = contextMessages(capped)
    expect(message?.options).toMatchObject({ delaySeconds: 3660 })
  })
})

describe('re-indexing', () => {
  it('the same text keeps every context; new text starts with none', async () => {
    const w = await world()
    const doc = await addDoc(w)
    situating()
    await run(w, doc.id)
    const contexts = (await chunksOf(w.tenantId, doc.id)).map(c => c.context)
    expect(contexts.every(Boolean)).toBe(true)

    // A re-embed (same text): contexts survive and are embedded again with the passage.
    stubs(env).ai?.runs.splice(0)
    await indexDocument(db, cfg, env, w.tenantId, doc.id)
    expect((await chunksOf(w.tenantId, doc.id)).map(c => c.context)).toEqual(contexts)
    const reembedded = (stubs(env).ai?.runs ?? []).flatMap(r =>
      Array.isArray(r.inputs.text) ? (r.inputs.text as string[]) : []
    )
    expect(reembedded.filter(t => t.includes('gritting contract;'))).toHaveLength(contexts.length)

    // The text changes: nothing written against the old text is kept.
    const edited = `${CONTRACT}\n\nSigned in Leeds.`
    await db
      .update(documents)
      .set({ content: edited, contentHash: 'edited' })
      .where(and(eq(documents.id, doc.id), eq(documents.tenantId, w.tenantId)))
    await indexDocument(db, cfg, env, w.tenantId, doc.id)
    expect((await chunksOf(w.tenantId, doc.id)).every(c => c.context === null)).toBe(true)
  })
})

describe('the job', () => {
  it('runs through the consumer handler and acks', async () => {
    const w = await world()
    const doc = await addDoc(w)
    situating()
    const envelope = buildJobEnvelope({
      type: 'document.contextualize',
      payload: { tenantId: w.tenantId, documentId: doc.id, contentHash: doc.contentHash ?? '' },
    })
    await handleDocumentContextualize(
      envelope as never,
      {
        db,
        env,
        config: cfg,
        logger: fakeLogger(),
      } as JobContext
    )
    expect((await chunksOf(w.tenantId, doc.id)).every(c => c.context)).toBe(true)
  })
})

describe('POST /api/ai/documents/contextualize', () => {
  const post = (cookie: Record<string, string> | undefined) =>
    request('/api/ai/documents/contextualize', { method: 'POST', headers: cookie }, { env })

  it('enqueues one job per document still missing a context, this tenant only', async () => {
    const a = await world()
    const b = await world()
    const docA = await addDoc(a)
    const docB = await addDoc(b)
    stubs(env).queue.messages.length = 0

    const res = await post(a.cookie)
    expect(res.status).toBe(202)
    const body: ContextualizeBackfillResponse = contextualizeBackfillResponseSchema.parse(
      await json(res)
    )
    expect(body).toEqual({ enqueued: 1, remaining: 0 })
    const ids = contextMessages(env).map(
      m => ((m.body as JobEnvelope).payload as { documentId: string }).documentId
    )
    expect(ids).toEqual([docA.id])
    expect(ids).not.toContain(docB.id)

    // Contextualised documents are not enqueued again.
    situating()
    await run(a, docA.id)
    stubs(env).queue.messages.length = 0
    expect(contextualizeBackfillResponseSchema.parse(await json(await post(a.cookie)))).toEqual({
      enqueued: 0,
      remaining: 0,
    })
  })

  it('the facets count visible documents with no context, 0 without the flag', async () => {
    const facets = async (cookie: Record<string, string>) =>
      documentFacetsSchema.parse(
        await json(await request('/api/ai/documents/facets', { headers: cookie }, { env }))
      ).withoutContext
    const w = await world()
    const doc = await addDoc(w)
    await addDoc(w, `${CONTRACT}\n\nA second copy, signed in York.`)
    expect(await facets(w.cookie)).toBe(2)
    situating()
    await run(w, doc.id)
    expect(await facets(w.cookie)).toBe(1)

    const off = await world({ flag: false })
    await addDoc(off)
    expect(await facets(off.cookie)).toBe(0)
  })

  it('is a 404 feature_disabled without the flag', async () => {
    const w = await world({ flag: false })
    const res = await post(w.cookie)
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ statusCode: 404, code: 'feature_disabled' })
  })

  it('is a 403 for a member and a 401 without a session', async () => {
    const w = await world()
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, w.tenantId, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, member.id, w.tenantId))
    const res = await post(cookie)
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    expect((await post(undefined)).status).toBe(401)
  })
})

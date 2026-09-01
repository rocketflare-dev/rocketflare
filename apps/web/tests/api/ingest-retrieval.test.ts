/**
 * Ingest + retrieval (D18, 00 §1.3) with a deterministic fake embedder (the `AI` stub answers
 * keyword-keyed unit vectors): `POST /api/ai/documents/ingest` → `indexed` with chunks carrying
 * embeddings; `POST /search` returns the matching chunk first with dense + lexical ranks; a
 * `documentId` filter narrows; another tenant's search finds nothing and its reads are 404; > 50
 * chunks → `pending` + a `document.index` job on the queue (and `JobsQueueNotConfiguredError`
 * without the binding); no embeddings provider → 503 `ai_not_configured` and NO row; list /
 * get / delete (cascade, owner-or-admin); 401 anon; member 403 deleting another's.
 */
import { documentSchema, searchResponseSchema } from '@rocketflare/shared/ai/embeddings'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { INLINE_CHUNK_LIMIT, ingestText } from '@/api/services/ai/ingest'
import { JobsQueueNotConfiguredError } from '@/api/services/jobs'
import { loadConfig } from '@/config'
import { chunks, documents } from '@/db/schema'
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

/** A unit vector along axis `i` (1024-dim). */
function axis(i: number): number[] {
  const v = new Array<number>(1024).fill(0)
  v[i] = 1
  return v
}
const TOPICS = ['volcano', 'banana', 'railway'] as const
/** Texts about a topic embed to that topic's axis; anything else to a far-away axis. */
function vectorFor(text: string): number[] {
  const t = text.toLowerCase()
  const idx = TOPICS.findIndex(topic => t.includes(topic))
  return axis(idx === -1 ? 900 : idx)
}

function fakeEmbeddingsEnv(overrides: Record<string, unknown> = {}): TestEnv {
  const env = createTestEnv(overrides)
  const ai = stubs(env).ai
  if (ai) {
    ai.respond = (_model, inputs) => {
      const texts = Array.isArray(inputs.text) ? (inputs.text as string[]) : [String(inputs.text)]
      return { shape: [texts.length, 1024], data: texts.map(vectorFor) }
    }
  }
  return env
}

async function actor(role: 'owner' | 'admin' | 'member' = 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

const ingest = (cookie: Record<string, string>, env: TestEnv, title: string, text: string) =>
  request(
    '/api/ai/documents/ingest',
    { method: 'POST', headers: cookie },
    { env, json: { title, text } }
  )

const search = (cookie: Record<string, string>, env: TestEnv, body: Record<string, unknown>) =>
  request('/api/ai/documents/search', { method: 'POST', headers: cookie }, { env, json: body })

const VOLCANO =
  'A volcano is a rupture in the crust of a planet. Volcano eruptions eject lava and ash.'
const BANANA = 'The banana is an elongated, edible fruit. Bananas are rich in potassium.'
const RAILWAY = 'A railway is a track for trains. Railway signalling keeps trains apart.'

describe('POST /api/ai/documents/ingest + /search', () => {
  it('indexes inline (chunks with embeddings) and search returns the right chunk first with both ranks', async () => {
    const a = await actor()
    const env = fakeEmbeddingsEnv()
    const docs = []
    for (const [title, text] of [
      ['Volcanoes', VOLCANO],
      ['Bananas', BANANA],
      ['Railways', RAILWAY],
    ] as const) {
      const res = await ingest(a.cookie, env, title, text)
      expect(res.status).toBe(201)
      docs.push(documentSchema.parse(await json(res)))
    }
    expect(docs[0]).toMatchObject({
      tenantId: a.tenant.id,
      ownerUserId: a.user.id,
      title: 'Volcanoes',
      source: 'upload',
      contentType: 'text/plain',
      sizeBytes: VOLCANO.length,
      chunkCount: 1,
      status: 'indexed',
      error: null,
    })
    expect(docs[0]).not.toHaveProperty('content')
    const rows = await db
      .select()
      .from(chunks)
      .where(and(eq(chunks.tenantId, a.tenant.id), eq(chunks.documentId, docs[0]?.id as string)))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ seq: 0, text: VOLCANO })
    expect(rows[0]?.embedding).toHaveLength(1024)
    expect(rows[0]?.embedding[0]).toBe(1)
    expect(stubs(env).ai?.runs.length).toBeGreaterThanOrEqual(3)

    const res = await search(a.cookie, env, { query: 'banana potassium', limit: 3 })
    expect(res.status).toBe(200)
    const body = searchResponseSchema.parse(await json(res))
    expect(body.query).toBe('banana potassium')
    expect(body.hits[0]).toMatchObject({
      documentId: docs[1]?.id,
      title: 'Bananas',
      text: BANANA,
      rank: 1,
      denseRank: 1,
      lexicalRank: 1,
    })
    expect(body.hits[0]?.score).toBeGreaterThan(body.hits[1]?.score ?? 0)
    expect(body.hits.map(h => h.rank)).toEqual(body.hits.map((_, i) => i + 1))

    // Filtered to one document: only its chunks come back.
    const only = searchResponseSchema.parse(
      await json(await search(a.cookie, env, { query: 'banana', documentId: docs[0]?.id }))
    )
    expect(only.hits.map(h => h.documentId)).toEqual([docs[0]?.id])

    // Another tenant: nothing to find, and the documents are 404.
    const b = await actor()
    expect(
      searchResponseSchema.parse(await json(await search(b.cookie, env, { query: 'volcano' }))).hits
    ).toEqual([])
    expect(
      (await request(`/api/ai/documents/${docs[0]?.id}`, { headers: b.cookie }, { env })).status
    ).toBe(404)
    const bList = await json<{ items: unknown[] }>(
      await request('/api/ai/documents', { headers: b.cookie }, { env })
    )
    expect(bList.items).toEqual([])
  })

  it('validation 400s, 401 anon, 503 ai_not_configured without any embeddings provider (no row written)', async () => {
    const a = await actor()
    const env = fakeEmbeddingsEnv()
    expect((await ingest(a.cookie, env, '', 'x')).status).toBe(400)
    expect((await search(a.cookie, env, { query: '' })).status).toBe(400)
    expect((await search(a.cookie, env, { query: 'x', limit: 99 })).status).toBe(400)
    expect((await request('/api/ai/documents', {}, { env })).status).toBe(401)
    const bare = createTestEnv({ AI: undefined, EMBEDDINGS_API_KEY: '' })
    const res = await ingest(a.cookie, bare, 'No provider', 'text')
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ statusCode: 503, code: 'ai_not_configured' })
    expect(await db.select().from(documents).where(eq(documents.tenantId, a.tenant.id))).toEqual([])
    expect((await search(a.cookie, bare, { query: 'x' })).status).toBe(503)
  })

  it('> INLINE_CHUNK_LIMIT chunks → pending row + document.index job; no queue → JobsQueueNotConfiguredError', async () => {
    const a = await actor()
    const env = fakeEmbeddingsEnv()
    const big = Array.from(
      { length: INLINE_CHUNK_LIMIT + 5 },
      (_, i) => `Paragraph ${i}. ${'x'.repeat(3100)}`
    ).join('\n\n')
    const res = await ingest(a.cookie, env, 'Big', big)
    expect(res.status).toBe(201)
    const doc = documentSchema.parse(await json(res))
    expect(doc).toMatchObject({ status: 'pending', chunkCount: 0 })
    expect(stubs(env).queue.messages).toHaveLength(1)
    expect(stubs(env).queue.messages[0]?.body).toMatchObject({
      type: 'document.index',
      payload: { tenantId: a.tenant.id, documentId: doc.id },
    })
    expect(await db.select().from(chunks).where(eq(chunks.documentId, doc.id))).toEqual([])

    await expect(
      ingestText(
        db,
        loadConfig(env),
        env,
        { tenantId: a.tenant.id, userId: a.user.id, title: 'Big 2', text: big },
        { jobs: null }
      )
    ).rejects.toBeInstanceOf(JobsQueueNotConfiguredError)
  })
})

describe('GET / GET :id / DELETE', () => {
  it('lists newest first (paginated, status filter), reads one, deletes with cascade; member cannot delete another’s, admin can', async () => {
    const a = await actor()
    const env = fakeEmbeddingsEnv()
    const d1 = documentSchema.parse(await json(await ingest(a.cookie, env, 'One', VOLCANO)))
    const d2 = documentSchema.parse(await json(await ingest(a.cookie, env, 'Two', RAILWAY)))
    const page = await json<{ items: Array<{ id: string }>; pagination: { total: number } }>(
      await request('/api/ai/documents?pageSize=1', { headers: a.cookie }, { env })
    )
    expect(page.pagination.total).toBe(2)
    expect(page.items.map(i => i.id)).toEqual([d2.id])
    const indexed = await json<{ items: Array<{ id: string }> }>(
      await request('/api/ai/documents?status=indexed', { headers: a.cookie }, { env })
    )
    expect(indexed.items).toHaveLength(2)
    expect(
      documentSchema.parse(
        await json(await request(`/api/ai/documents/${d1.id}`, { headers: a.cookie }, { env }))
      ).id
    ).toBe(d1.id)
    expect(
      (await request('/api/ai/documents/not-a-uuid', { headers: a.cookie }, { env })).status
    ).toBe(404)

    const other = await createTestUser(db)
    await linkUserToTenant(db, other.id, a.tenant.id, 'member')
    const oc = sessionCookieHeader(await createTestSession(db, other.id, a.tenant.id))
    const forbidden = await request(
      `/api/ai/documents/${d1.id}`,
      { method: 'DELETE', headers: oc },
      { env }
    )
    expect(forbidden.status).toBe(403)
    expect(await json(forbidden)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    // Members can still read and search everything in the tenant.
    expect((await request(`/api/ai/documents/${d1.id}`, { headers: oc }, { env })).status).toBe(200)

    expect(
      (
        await request(
          `/api/ai/documents/${d1.id}`,
          { method: 'DELETE', headers: a.cookie },
          { env }
        )
      ).status
    ).toBe(204)
    expect(await db.select().from(chunks).where(eq(chunks.documentId, d1.id))).toEqual([])
    expect(
      (await request(`/api/ai/documents/${d1.id}`, { headers: a.cookie }, { env })).status
    ).toBe(404)

    const admin = await createTestUser(db)
    await linkUserToTenant(db, admin.id, a.tenant.id, 'admin')
    const ac = sessionCookieHeader(await createTestSession(db, admin.id, a.tenant.id))
    expect(
      (await request(`/api/ai/documents/${d2.id}`, { method: 'DELETE', headers: ac }, { env }))
        .status
    ).toBe(204)
  })
})

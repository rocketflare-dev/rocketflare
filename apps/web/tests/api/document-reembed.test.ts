/**
 * Knowledge upkeep: `GET /api/ai/documents/health` (counts by status + stale embeddings against
 * today's model), `POST /reembed` (202, a `document.reembed` job only when something is stale; 503
 * with no embedder), the job itself through the real consumer (re-embeds in bounded batches,
 * re-enqueues while more remain, acks a superseded model, keeps the old chunks on a transient
 * failure, marks a refused document failed and moves on), the automatic enqueue when an
 * embeddings DEFAULT changes (and the config save succeeding without a queue), and
 * `POST /:id/retry` (owner or admin; convert vs index; 409 `document_not_failed`; 404 across
 * tenants and for a hidden document). Plus the inline ingest span the embed batches nest under.
 */
import {
  documentsHealthSchema,
  reembedResponseSchema,
  retryDocumentResponseSchema,
} from '@rocketflare/shared/ai/embeddings'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createTracer, type RecordedSpan } from '@/api/observability/recorder'
import { withAgentTrace } from '@/api/observability/tracing'
import { processJobsBatch } from '@/api/queues/jobs'
import { AiError } from '@/api/services/ai/errors'
import { ingestText } from '@/api/services/ai/ingest'
import { REEMBED_BATCH_DOCUMENTS } from '@/api/services/ai/reindex'
import { buildJobEnvelope } from '@/api/services/jobs'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { aiConfigs, chunks, documents } from '@/db/schema'
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
const TODAY = '@cf/baai/bge-m3'
const OTHER = '@cf/baai/bge-large-en-v1.5'

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

async function actor(role: 'owner' | 'admin' | 'member' = 'admin') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function memberOf(tenantId: string) {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, 'member')
  return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
}

/** An indexed document (through the real ingest), its chunks then relabelled as `model`. */
async function indexedDoc(
  env: TestEnv,
  tenantId: string,
  userId: string,
  title: string,
  model: string | null = TODAY
) {
  const { document } = await ingestText(db, loadConfig(env), env, {
    tenantId,
    userId,
    title,
    text: `${title}. ${'Some words about the subject. '.repeat(10)}`,
  })
  if (model !== TODAY) {
    await db
      .update(chunks)
      .set({ embeddingModel: model })
      .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, document.id)))
  }
  return document
}

function message(body: unknown, attempts = 1) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

async function runReembed(env: TestEnv, tenantId: string, model = TODAY, logger = fakeLogger()) {
  const msg = message(buildJobEnvelope({ type: 'document.reembed', payload: { tenantId, model } }))
  const batch = {
    queue: 'rocketflare-jobs',
    messages: [msg],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>
  await processJobsBatch(batch, {
    env,
    config: loadConfig(env),
    logger,
    createDb: () => ({ db, close: async () => {} }),
  })
  return { msg, logger }
}

const modelsOf = async (documentId: string) =>
  (
    await db
      .select({ m: chunks.embeddingModel })
      .from(chunks)
      .where(eq(chunks.documentId, documentId))
  ).map(r => r.m)

const reembedJobs = (env: TestEnv) =>
  stubs(env).queue.messages.filter(m => (m.body as { type: string }).type === 'document.reembed')

// ---- health ----------------------------------------------------------------------------------

describe('GET /api/ai/documents/health', () => {
  it('counts documents by status and the stale ones against today’s model', async () => {
    const a = await actor()
    const env = createTestEnv()
    await indexedDoc(env, a.tenant.id, a.user.id, 'Fresh')
    const stale = await indexedDoc(env, a.tenant.id, a.user.id, 'Old model', OTHER)
    await indexedDoc(env, a.tenant.id, a.user.id, 'No model', null)
    await db.insert(documents).values([
      { tenantId: a.tenant.id, title: 'Broken', status: 'failed', content: 'x' },
      { tenantId: a.tenant.id, title: 'Queued', status: 'pending' },
    ])
    const res = await request('/api/ai/documents/health', { headers: a.cookie }, { env })
    expect(res.status).toBe(200)
    const body = documentsHealthSchema.parse(await json(res))
    const staleChunks = (await modelsOf(stale.id)).length * 2
    expect(body).toEqual({
      documents: { total: 5, pending: 1, indexed: 3, failed: 1 },
      embeddingModel: TODAY,
      staleEmbeddings: 2,
      staleChunks,
    })

    // Another tenant's knowledge base is its own.
    const b = await actor()
    const other = documentsHealthSchema.parse(
      await json(await request('/api/ai/documents/health', { headers: b.cookie }, { env }))
    )
    expect(other.documents.total).toBe(0)
    expect(other.staleEmbeddings).toBe(0)
  })

  it('no embedder: model null and nothing counts as stale', async () => {
    const a = await actor()
    const env = createTestEnv()
    await indexedDoc(env, a.tenant.id, a.user.id, 'Old model', OTHER)
    const noAi = createTestEnv({ AI: undefined, EMBEDDINGS_API_KEY: '' })
    const body = documentsHealthSchema.parse(
      await json(await request('/api/ai/documents/health', { headers: a.cookie }, { env: noAi }))
    )
    expect(body).toMatchObject({ embeddingModel: null, staleEmbeddings: 0, staleChunks: 0 })
  })

  it('is admin-only: 401 anonymous, 403 member with the envelope', async () => {
    const a = await actor()
    expect((await request('/api/ai/documents/health')).status).toBe(401)
    const m = await memberOf(a.tenant.id)
    const res = await request('/api/ai/documents/health', { headers: m.cookie })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, error: expect.any(String) })
  })
})

// ---- POST /reembed ---------------------------------------------------------------------------

describe('POST /api/ai/documents/reembed', () => {
  it('202 and one document.reembed job toward today’s model when something is stale', async () => {
    const a = await actor()
    const env = createTestEnv()
    await indexedDoc(env, a.tenant.id, a.user.id, 'Old', OTHER)
    const res = await request(
      '/api/ai/documents/reembed',
      { method: 'POST', headers: a.cookie },
      { env }
    )
    expect(res.status).toBe(202)
    expect(reembedResponseSchema.parse(await json(res))).toMatchObject({
      embeddingModel: TODAY,
      staleEmbeddings: 1,
      enqueued: true,
    })
    expect(reembedJobs(env).map(m => (m.body as { payload: unknown }).payload)).toEqual([
      { tenantId: a.tenant.id, model: TODAY },
    ])
  })

  it('nothing stale: 202 with enqueued false and no job', async () => {
    const a = await actor()
    const env = createTestEnv()
    await indexedDoc(env, a.tenant.id, a.user.id, 'Fresh')
    const res = await request(
      '/api/ai/documents/reembed',
      { method: 'POST', headers: a.cookie },
      { env }
    )
    expect(res.status).toBe(202)
    expect(await json(res)).toMatchObject({ staleEmbeddings: 0, enqueued: false })
    expect(reembedJobs(env)).toEqual([])
  })

  it('503 ai_not_configured without an embedder; 403 for a member', async () => {
    const a = await actor()
    const noAi = createTestEnv({ AI: undefined, EMBEDDINGS_API_KEY: '' })
    const res = await request(
      '/api/ai/documents/reembed',
      { method: 'POST', headers: a.cookie },
      { env: noAi }
    )
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ code: 'ai_not_configured' })
    const m = await memberOf(a.tenant.id)
    expect(
      (await request('/api/ai/documents/reembed', { method: 'POST', headers: m.cookie })).status
    ).toBe(403)
  })
})

// ---- the job ---------------------------------------------------------------------------------

describe('document.reembed', () => {
  it('re-embeds stale documents with today’s model, leaves the others alone, acks', async () => {
    const a = await actor()
    const env = createTestEnv()
    const fresh = await indexedDoc(env, a.tenant.id, a.user.id, 'Fresh')
    const old = await indexedDoc(env, a.tenant.id, a.user.id, 'Old', OTHER)
    const freshChunkIds = (
      await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.documentId, fresh.id))
    ).map(r => r.id)

    const { msg } = await runReembed(env, a.tenant.id)
    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(msg.retry).not.toHaveBeenCalled()
    expect(new Set(await modelsOf(old.id))).toEqual(new Set([TODAY]))
    // The fresh document was not touched: same chunk rows.
    expect(
      (await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.documentId, fresh.id))).map(
        r => r.id
      )
    ).toEqual(freshChunkIds)
    // Done: nothing re-enqueued.
    expect(reembedJobs(env)).toEqual([])
  })

  it('works in bounded batches and re-enqueues itself while more remain', async () => {
    const a = await actor()
    const env = createTestEnv()
    for (let i = 0; i <= REEMBED_BATCH_DOCUMENTS; i++) {
      await indexedDoc(env, a.tenant.id, a.user.id, `Old ${i}`, OTHER)
    }
    await runReembed(env, a.tenant.id)
    const health = async () =>
      documentsHealthSchema.parse(
        await json(
          await request(
            '/api/ai/documents/health',
            { headers: sessionCookieHeader(await createTestSession(db, a.user.id, a.tenant.id)) },
            { env }
          )
        )
      )
    expect((await health()).staleEmbeddings).toBe(1)
    expect(reembedJobs(env)).toHaveLength(1)
    // The next message finishes the chain.
    stubs(env).queue.clear()
    await runReembed(env, a.tenant.id)
    expect((await health()).staleEmbeddings).toBe(0)
    expect(reembedJobs(env)).toEqual([])
  })

  it('a message for a model the tenant no longer resolves is acked and does nothing', async () => {
    const a = await actor()
    const env = createTestEnv()
    const old = await indexedDoc(env, a.tenant.id, a.user.id, 'Old', OTHER)
    const { msg, logger } = await runReembed(env, a.tenant.id, 'some-retired-model')
    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(new Set(await modelsOf(old.id))).toEqual(new Set([OTHER]))
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'superseded' }),
      'document.reembed: batch done'
    )
  })

  it('a transient provider failure retries and keeps the old chunks searchable', async () => {
    const a = await actor()
    const env = createTestEnv()
    const old = await indexedDoc(env, a.tenant.id, a.user.id, 'Old', OTHER)
    const ai = stubs(env).ai
    if (!ai) throw new Error('no AI stub')
    ai.respond = () => {
      throw new AiError('unavailable', 'workers_ai', 'Workers AI is down')
    }
    const { msg } = await runReembed(env, a.tenant.id)
    expect(msg.retry).toHaveBeenCalledTimes(1)
    const [row] = await db.select().from(documents).where(eq(documents.id, old.id))
    expect(row).toMatchObject({ status: 'indexed', error: null })
    expect(new Set(await modelsOf(old.id))).toEqual(new Set([OTHER]))
  })

  it('a document the provider refuses is marked failed and the batch moves on', async () => {
    const a = await actor()
    const env = createTestEnv()
    const bad = await indexedDoc(env, a.tenant.id, a.user.id, 'Poison', OTHER)
    const good = await indexedDoc(env, a.tenant.id, a.user.id, 'Fine', OTHER)
    const ai = stubs(env).ai
    if (!ai) throw new Error('no AI stub')
    const normal = ai.respond
    ai.respond = (model, inputs) => {
      const texts = inputs.text as string[]
      if (texts.some(t => t.includes('Poison'))) {
        throw new AiError('invalid_request', 'workers_ai', 'Input too long', 400)
      }
      return normal(model, inputs)
    }
    const { msg } = await runReembed(env, a.tenant.id)
    expect(msg.ack).toHaveBeenCalledTimes(1)
    const [badRow] = await db.select().from(documents).where(eq(documents.id, bad.id))
    expect(badRow?.status).toBe('failed')
    expect(new Set(await modelsOf(good.id))).toEqual(new Set([TODAY]))
  })
})

// ---- the config change -----------------------------------------------------------------------

describe('changing the embeddings default enqueues a re-embed', () => {
  const save = (cookie: Record<string, string>, env: TestEnv, model: string, label = 'Vectors') =>
    request(
      '/api/ai/config',
      { method: 'POST', headers: cookie },
      { env, json: { scope: 'embeddings', label, provider: 'workers_ai', model } }
    )

  it('create → a job for the new model; a re-save of the same model → none; delete → back to the platform model', async () => {
    const a = await actor()
    const env = createTestEnv()
    await indexedDoc(env, a.tenant.id, a.user.id, 'Doc')
    expect((await save(a.cookie, env, OTHER)).status).toBe(201)
    expect(reembedJobs(env).map(m => (m.body as { payload: unknown }).payload)).toEqual([
      { tenantId: a.tenant.id, model: OTHER },
    ])

    stubs(env).queue.clear()
    expect((await save(a.cookie, env, OTHER)).status).toBe(200)
    expect(reembedJobs(env)).toEqual([])

    // Re-embed toward OTHER, then deleting the row makes the platform model current again.
    await runReembed(env, a.tenant.id, OTHER)
    stubs(env).queue.clear()
    const [row] = await db.select().from(aiConfigs).where(eq(aiConfigs.tenantId, a.tenant.id))
    const del = await request(
      `/api/ai/config/${row?.id}`,
      { method: 'DELETE', headers: a.cookie },
      { env }
    )
    expect(del.status).toBe(204)
    expect(reembedJobs(env).map(m => (m.body as { payload: unknown }).payload)).toEqual([
      { tenantId: a.tenant.id, model: TODAY },
    ])
  })

  it('a model change with nothing stale enqueues no job', async () => {
    const a = await actor()
    const env = createTestEnv()
    // No documents at all: the model changes, but there is nothing to rebuild.
    expect((await save(a.cookie, env, OTHER)).status).toBe(201)
    expect(reembedJobs(env)).toEqual([])
  })

  it('without JOBS_QUEUE the save still succeeds (and says why in the log)', async () => {
    const a = await actor()
    const seeded = createTestEnv()
    await indexedDoc(seeded, a.tenant.id, a.user.id, 'Doc')
    const env = createTestEnv({ JOBS_QUEUE: undefined })
    const res = await save(a.cookie, env, OTHER)
    expect(res.status).toBe(201)
    const [row] = await db.select().from(aiConfigs).where(eq(aiConfigs.tenantId, a.tenant.id))
    expect(row?.model).toBe(OTHER)
  })
})

// ---- retry -----------------------------------------------------------------------------------

describe('POST /api/ai/documents/:id/retry', () => {
  const retry = (cookie: Record<string, string>, env: TestEnv, id: string) =>
    request(`/api/ai/documents/${id}/retry`, { method: 'POST', headers: cookie }, { env })

  async function failedDoc(
    tenantId: string,
    ownerUserId: string,
    content: string | null,
    extra: Partial<typeof documents.$inferInsert> = {}
  ) {
    const [row] = await db
      .insert(documents)
      .values({
        tenantId,
        ownerUserId,
        title: 'Broken',
        content,
        status: 'failed',
        error: 'It broke',
        ...extra,
      })
      .returning()
    if (!row) throw new Error('insert failed')
    return row
  }

  it('text → document.index, no text → document.convert; 202 with the row pending', async () => {
    const a = await actor('member')
    const env = createTestEnv()
    const text = await failedDoc(a.tenant.id, a.user.id, 'Some text')
    const upload = await failedDoc(a.tenant.id, a.user.id, null, { contentType: 'application/pdf' })

    const r1 = await retry(a.cookie, env, text.id)
    expect(r1.status).toBe(202)
    expect(retryDocumentResponseSchema.parse(await json(r1))).toMatchObject({
      id: text.id,
      status: 'pending',
      error: null,
      job: 'document.index',
    })
    const r2 = await retry(a.cookie, env, upload.id)
    expect(r2.status).toBe(202)
    expect(await json(r2)).toMatchObject({ job: 'document.convert' })
    expect(stubs(env).queue.messages.map(m => m.body)).toEqual([
      expect.objectContaining({
        type: 'document.index',
        payload: { tenantId: a.tenant.id, documentId: text.id },
      }),
      expect.objectContaining({
        type: 'document.convert',
        payload: { tenantId: a.tenant.id, documentId: upload.id },
      }),
    ])

    // Now pending: a second click is the 409, and nothing more is enqueued.
    const again = await retry(a.cookie, env, text.id)
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ statusCode: 409, code: 'document_not_failed' })
    expect(stubs(env).queue.messages).toHaveLength(2)
  })

  it('owner or admin: a member cannot retry someone else’s document (403), an admin can', async () => {
    const admin = await actor('admin')
    const m = await memberOf(admin.tenant.id)
    const env = createTestEnv()
    const doc = await failedDoc(admin.tenant.id, admin.user.id, 'text')
    expect((await retry(m.cookie, env, doc.id)).status).toBe(403)
    const mine = await failedDoc(admin.tenant.id, m.user.id, 'text')
    expect((await retry(admin.cookie, env, mine.id)).status).toBe(202)
  })

  it('another tenant’s document and a hidden one are the same 404; 401 anonymous', async () => {
    const a = await actor()
    const b = await actor()
    const env = createTestEnv()
    const doc = await failedDoc(a.tenant.id, a.user.id, 'text')
    const cross = await retry(b.cookie, env, doc.id)
    expect(cross.status).toBe(404)
    // Restricted to groups (none): only the owner and admins may see it.
    const hidden = await failedDoc(a.tenant.id, a.user.id, 'text', { visibility: 'groups' })
    const m = await memberOf(a.tenant.id)
    expect((await retry(m.cookie, env, hidden.id)).status).toBe(404)
    expect((await request(`/api/ai/documents/${doc.id}/retry`, { method: 'POST' })).status).toBe(
      401
    )
    expect(stubs(env).queue.messages).toEqual([])
  })

  it('without JOBS_QUEUE nothing is written: the row stays failed', async () => {
    const a = await actor()
    const doc = await failedDoc(a.tenant.id, a.user.id, 'text')
    const res = await retry(a.cookie, createTestEnv({ JOBS_QUEUE: undefined }), doc.id)
    expect(res.status).toBeGreaterThanOrEqual(500)
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id))
    expect(row).toMatchObject({ status: 'failed', error: 'It broke' })
  })
})

// ---- the inline ingest span ------------------------------------------------------------------

describe('inline ingest is traced', () => {
  function collectingTracer() {
    const spans: RecordedSpan[] = []
    const tracer = createTracer({
      sinks: [async batch => void spans.push(...batch)],
      captureContent: true,
    })
    return { tracer, spans }
  }

  it('a root `ingest document` span on the request tracer, with the embed batches under it', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { tracer, spans } = collectingTracer()
    const { document, mode } = await ingestText(
      db,
      loadConfig(env),
      env,
      { tenantId: a.tenant.id, userId: a.user.id, title: 'Traced', text: 'A short traced text.' },
      { tracer }
    )
    expect(mode).toBe('inline')
    await tracer.flush()
    const root = spans.find(s => s.name === 'ingest document')
    expect(root).toBeDefined()
    expect(root?.parentSpanId).toBeFalsy()
    const embeds = spans.filter(s => s.kind === 'embedding')
    expect(embeds.length).toBeGreaterThan(0)
    expect(embeds.every(s => s.parentSpanId === root?.spanId)).toBe(true)
    // The span carries the outcome, never the document's text.
    expect(JSON.stringify(root)).not.toContain('A short traced text.')
    expect(document.status).toBe('indexed')
  })

  it('under an active span (an agent run) it nests there instead', async () => {
    const a = await actor()
    const env = createTestEnv()
    const { tracer, spans } = collectingTracer()
    await withAgentTrace('fixture', { tracer, tenantId: a.tenant.id }, () =>
      ingestText(db, loadConfig(env), env, {
        tenantId: a.tenant.id,
        userId: a.user.id,
        title: 'Nested',
        text: 'Nested traced text.',
      })
    )
    await tracer.flush()
    const agent = spans.find(s => s.name === 'invoke_agent fixture')
    const ingest = spans.find(s => s.name === 'ingest document')
    expect(ingest?.parentSpanId).toBe(agent?.spanId)
    expect(
      spans.filter(s => s.kind === 'embedding').every(s => s.parentSpanId === ingest?.spanId)
    ).toBe(true)
  })
})

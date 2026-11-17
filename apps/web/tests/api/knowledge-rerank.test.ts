// @vitest-isolate
// Stubs the global fetch (the Fireworks reranker and the OpenAI embedder), so it needs its own registry.
/**
 * Reranking and knowledge metering, end to end through the real services and database:
 *
 * - the Workers AI reranker (the `AI` stub's `respond`, standing in for bge-reranker-base)
 *   reorders the fused head, each hit carries its `rerankScore` in [0, 1] and `rank` is the new
 *   order; `RERANK_MIN_SCORE` drops what scored under it; `rerank: false`, a failing reranker and
 *   no reranker at all answer the fused order with `rerankScore: null`;
 * - a tenant `rerank` row (`openai_compatible` on Fireworks) wins over the binding and is called
 *   as a Cohere-style `POST {base}/rerank` with the row's bearer key — and its connection test
 *   reranks two documents;
 * - every embedding (ingest and query) and rerank call is an `ai_usage` row under
 *   `knowledge.embeddings` / `knowledge.rerank`, a ledger failure never fails the call, and
 *   `knowledgeSpendToday` / `knowledgeExtractionAllowed` count the three knowledge features over
 *   the UTC day against `KNOWLEDGE_TENANT_DAILY_COST_USD`.
 */
import { KNOWLEDGE_USAGE_FEATURES } from '@rocketflare/shared/ai/usage'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encrypt, requireEncryptionKey } from '@/api/auth/oauth-encryption'
import { fullAccessScope } from '@/api/services/access'
import { testConfig } from '@/api/services/ai/connection-test'
import { ingestText } from '@/api/services/ai/ingest'
import { searchKnowledgeChunks } from '@/api/services/ai/retrieval'
import {
  knowledgeExtractionAllowed,
  knowledgeSpendToday,
  recordKnowledgeUsage,
  recordUsage,
} from '@/api/services/ai/usage'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import { aiConfigs, aiUsage } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

const RERANK_MODEL = '@cf/baai/bge-reranker-base'

/** A unit vector along axis `i` (1024-dim). */
function axis(i: number): number[] {
  const v = new Array<number>(1024).fill(0)
  v[i] = 1
  return v
}
const TOPICS = ['volcano', 'banana', 'railway'] as const
const vectorFor = (text: string) => {
  const idx = TOPICS.findIndex(topic => text.toLowerCase().includes(topic))
  return axis(idx === -1 ? 900 : idx)
}

/**
 * Embeddings by topic; the reranker answers LOGITS that put `prefer` first (bge-reranker-base's
 * raw scores), or throws when `prefer` is `'fail'`.
 */
function env(prefer: string | 'fail', overrides: Record<string, unknown> = {}): TestEnv {
  const e = createTestEnv(overrides)
  const ai = stubs(e).ai
  if (ai) {
    ai.respond = (_model, inputs) => {
      if (Array.isArray(inputs.contexts)) {
        if (prefer === 'fail') throw new Error('3010: model unavailable')
        return {
          response: (inputs.contexts as { text: string }[]).map((c, id) => ({
            id,
            score: c.text.toLowerCase().includes(prefer) ? 6 : -6 + id * 0.01,
          })),
        }
      }
      const texts = Array.isArray(inputs.text) ? (inputs.text as string[]) : [String(inputs.text)]
      return { shape: [texts.length, 1024], data: texts.map(vectorFor) }
    }
  }
  return e
}

const DOCS = {
  volcano: 'A volcano is a rupture in the crust. Volcano eruptions eject lava and ash.',
  banana: 'The banana is an elongated fruit. Bananas are rich in potassium.',
  railway: 'A railway is a track for trains. Railway signalling keeps trains apart.',
}

async function world(e: TestEnv) {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const cfg = loadConfig(e)
  for (const [title, text] of Object.entries(DOCS)) {
    const { document } = await ingestText(
      db,
      cfg,
      e,
      { tenantId: tenant.id, userId: user.id, title, text },
      { jobs: e.JOBS_QUEUE }
    )
    expect(document.status).toBe('indexed')
  }
  return { tenantId: tenant.id, userId: user.id, cfg }
}

/** A query that matches every document lexically, so all three are candidates. */
const QUERY = 'volcano banana railway'

const usageRows = (tenantId: string) =>
  db.query.aiUsage.findMany({ where: eq(aiUsage.tenantId, tenantId) })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reranking', () => {
  it('reorders the fused head by the reranker, scores each hit in [0, 1] and meters both calls', async () => {
    const e = env('railway')
    const w = await world(e)
    stubs(e).ai?.clear()
    const { hits, rerank } = await searchKnowledgeChunks(
      db,
      w.cfg,
      e,
      fullAccessScope(w.tenantId),
      { query: QUERY, limit: 3 }
    )
    expect(rerank).toMatchObject({ applied: true, model: RERANK_MODEL })
    expect(hits[0]?.title).toBe('railway')
    expect(hits.map(h => h.rank)).toEqual([1, 2, 3])
    expect(hits[0]?.rerankScore).toBeGreaterThan(0.99)
    expect(
      hits.every(h => h.rerankScore !== null && h.rerankScore >= 0 && h.rerankScore <= 1)
    ).toBe(true)
    // One embed for the query, one rerank over every fused candidate (title + section in front).
    const runs = stubs(e).ai?.runs ?? []
    const rerankRun = runs.find(r => r.model === RERANK_MODEL)
    expect(rerankRun?.inputs.contexts).toHaveLength(3)
    expect(rerankRun?.inputs.query).toBe(QUERY)

    const rows = await usageRows(w.tenantId)
    const embeds = rows.filter(r => r.feature === KNOWLEDGE_USAGE_FEATURES.embeddings)
    // Three documents indexed + the query, each estimated from characters (Workers AI reports none).
    expect(embeds).toHaveLength(4)
    expect(embeds.every(r => r.provider === 'workers_ai' && r.inputTokens > 0)).toBe(true)
    expect(embeds.every(r => r.costMicrocents !== null)).toBe(true)
    const reranks = rows.filter(r => r.feature === KNOWLEDGE_USAGE_FEATURES.rerank)
    expect(reranks).toHaveLength(1)
    expect(reranks[0]).toMatchObject({ provider: 'workers_ai', model: RERANK_MODEL })
    expect(reranks[0]?.userId).toBeNull()
    expect(reranks[0]?.costMicrocents).not.toBeNull()
  })

  it('RERANK_MIN_SCORE drops what scored under it', async () => {
    const e = env('railway', { RERANK_MIN_SCORE: '0.5' })
    const w = await world(e)
    const { hits, rerank } = await searchKnowledgeChunks(
      db,
      w.cfg,
      e,
      fullAccessScope(w.tenantId),
      { query: QUERY, limit: 3 }
    )
    expect(hits.map(h => h.title)).toEqual(['railway'])
    expect(rerank).toMatchObject({ applied: true, dropped: 2 })
  })

  it('answers the fused order with rerankScore null: rerank false, a failing reranker, no binding', async () => {
    const e = env('railway')
    const w = await world(e)
    const scope = fullAccessScope(w.tenantId)
    stubs(e).ai?.clear()
    const off = await searchKnowledgeChunks(db, w.cfg, e, scope, {
      query: QUERY,
      limit: 3,
      rerank: false,
    })
    expect(off.rerank).toEqual({ applied: false, reason: 'disabled' })
    expect(off.hits.every(h => h.rerankScore === null)).toBe(true)
    expect(stubs(e).ai?.runs.some(r => r.model === RERANK_MODEL)).toBe(false)

    const failing = env('fail')
    const failed = await searchKnowledgeChunks(db, loadConfig(failing), failing, scope, {
      query: QUERY,
      limit: 3,
    })
    expect(failed.rerank).toMatchObject({ applied: false, reason: 'error', model: RERANK_MODEL })
    expect(failed.hits.map(h => h.title)).toEqual(off.hits.map(h => h.title))
    expect(failed.hits.every(h => h.rerankScore === null)).toBe(true)

    // No binding and no row: no reranker. Embeddings come from the platform key here.
    const bare = createTestEnv({ AI: undefined, EMBEDDINGS_API_KEY: 'sk-test-embeddings' })
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] }
      return Response.json({
        data: body.input.map((t, index) => ({ index, embedding: vectorFor(t) })),
        usage: { prompt_tokens: 7, total_tokens: 7 },
      })
    })
    const none = await searchKnowledgeChunks(db, loadConfig(bare), bare, scope, {
      query: QUERY,
      limit: 3,
    })
    expect(none.rerank).toEqual({ applied: false, reason: 'not_configured' })
    expect(none.hits.every(h => h.rerankScore === null)).toBe(true)
    // The provider's own token count, not an estimate.
    const rows = await usageRows(w.tenantId)
    expect(
      rows.some(
        r =>
          r.feature === KNOWLEDGE_USAGE_FEATURES.embeddings &&
          r.provider === 'openai' &&
          r.inputTokens === 7
      )
    ).toBe(true)
  })

  it('a tenant rerank row (Fireworks) wins over the binding, and its connection test reranks two documents', async () => {
    const e = env('banana')
    const w = await world(e)
    await db.insert(aiConfigs).values({
      tenantId: w.tenantId,
      scope: 'rerank',
      provider: 'openai_compatible',
      label: 'Fireworks rerank',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      model: 'fireworks/qwen3-reranker-8b',
      apiKeyEnc: await encrypt('fw-test-key', requireEncryptionKey(w.cfg)),
      isDefault: true,
    })
    const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
    const fireworks = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { documents: string[] }
      calls.push({ url, auth: new Headers(init.headers).get('authorization'), body })
      return Response.json({
        data: body.documents
          .map((d, index) => ({ index, relevance_score: d.includes('volcano') ? 0.97 : 0.05 }))
          .sort((a, b) => b.relevance_score - a.relevance_score),
        usage: { prompt_tokens: 120, total_tokens: 120 },
      })
    }
    vi.stubGlobal('fetch', fireworks)
    const { hits, rerank } = await searchKnowledgeChunks(
      db,
      w.cfg,
      e,
      fullAccessScope(w.tenantId),
      { query: QUERY, limit: 3 }
    )
    expect(rerank).toMatchObject({ applied: true, model: 'fireworks/qwen3-reranker-8b' })
    expect(hits[0]?.title).toBe('volcano')
    expect(hits[0]?.rerankScore).toBe(0.97)
    expect(calls[0]?.url).toBe('https://api.fireworks.ai/inference/v1/rerank')
    expect(calls[0]?.auth).toBe('Bearer fw-test-key')
    expect(calls[0]?.body).toMatchObject({
      model: 'fireworks/qwen3-reranker-8b',
      return_documents: false,
    })
    // The binding's reranker was not asked.
    expect(stubs(e).ai?.runs.some(r => r.model === RERANK_MODEL)).toBe(false)
    const reranks = (await usageRows(w.tenantId)).filter(
      r => r.feature === KNOWLEDGE_USAGE_FEATURES.rerank
    )
    expect(reranks).toHaveLength(1)
    // Fireworks' own count; an `openai_compatible` endpoint is unpriced by design.
    expect(reranks[0]).toMatchObject({ inputTokens: 120, costMicrocents: null })

    const row = await db.query.aiConfigs.findFirst({
      where: and(eq(aiConfigs.tenantId, w.tenantId), eq(aiConfigs.scope, 'rerank')),
    })
    calls.length = 0
    const verdict = await testConfig(db, w.cfg, e, w.tenantId, { configId: row?.id as string })
    expect(verdict).toMatchObject({ ok: true, provider: 'openai_compatible' })
    expect(calls[0]?.body.documents).toHaveLength(2)

    vi.stubGlobal(
      'fetch',
      async () => new Response('{"error":"bad key fw-test-key"}', { status: 401 })
    )
    const refused = await testConfig(db, w.cfg, e, w.tenantId, { configId: row?.id as string })
    expect(refused).toMatchObject({ ok: false, code: 'auth' })
    expect(JSON.stringify(refused)).not.toContain('fw-test-key')

    // An unsaved Workers AI rerank candidate probes through the binding.
    const binding = await testConfig(db, w.cfg, e, w.tenantId, {
      scope: 'rerank',
      provider: 'workers_ai',
      model: RERANK_MODEL,
    })
    expect(binding).toMatchObject({ ok: true, model: RERANK_MODEL })
  })
})

describe('knowledge metering and the daily cap', () => {
  it('a ledger failure is swallowed, never thrown', async () => {
    const broken = {
      insert: () => {
        throw new Error('connection reset')
      },
    } as unknown as Database
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      recordKnowledgeUsage(broken, [
        {
          tenantId: '00000000-0000-0000-0000-000000000000',
          feature: KNOWLEDGE_USAGE_FEATURES.embeddings,
          provider: 'workers_ai',
          model: '@cf/baai/bge-m3',
          inputTokens: 10,
        },
      ])
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('counts the three knowledge features over the UTC day; extraction stops at the cap', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const other = await createTestTenantWithUser(db, 'owner')
    const row = (feature: string, costMicrocents: number, tenantId = tenant.id) =>
      recordUsage(db, {
        tenantId,
        feature,
        provider: 'openai',
        model: 'text-embedding-3-small',
        usage: { inputTokens: 1, outputTokens: 0 },
        costMicrocents,
      })
    const USD = 100_000_000
    await row(KNOWLEDGE_USAGE_FEATURES.embeddings, 0.25 * USD)
    await row(KNOWLEDGE_USAGE_FEATURES.rerank, 0.25 * USD)
    await row(KNOWLEDGE_USAGE_FEATURES.extraction, 0.25 * USD)
    // Not knowledge, another tenant, or yesterday: none of them count.
    await row('chat', 5 * USD)
    await row(KNOWLEDGE_USAGE_FEATURES.extraction, 5 * USD, other.tenant.id)
    const [old] = await db
      .insert(aiUsage)
      .values({
        tenantId: tenant.id,
        feature: KNOWLEDGE_USAGE_FEATURES.extraction,
        provider: 'openai',
        model: 'x',
        inputTokens: 1,
        outputTokens: 0,
        costMicrocents: 5 * USD,
        at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      })
      .returning()
    expect(old).toBeDefined()

    expect(await knowledgeSpendToday(db, tenant.id)).toBe(0.75 * USD)
    // No cap: always allowed.
    expect(await knowledgeExtractionAllowed(db, {}, tenant.id)).toBe(true)
    expect(
      await knowledgeExtractionAllowed(db, { KNOWLEDGE_TENANT_DAILY_COST_USD: 1 }, tenant.id)
    ).toBe(true)
    expect(
      await knowledgeExtractionAllowed(db, { KNOWLEDGE_TENANT_DAILY_COST_USD: 0.75 }, tenant.id)
    ).toBe(false)
    // Tomorrow (UTC) the day starts again.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    expect(
      await knowledgeExtractionAllowed(
        db,
        { KNOWLEDGE_TENANT_DAILY_COST_USD: 0.75 },
        tenant.id,
        tomorrow
      )
    ).toBe(true)
  })

  it('parses the two new vars: unset = off, blank = off, out of range refused', () => {
    expect(loadConfig(createTestEnv()).KNOWLEDGE_TENANT_DAILY_COST_USD).toBeUndefined()
    expect(loadConfig(createTestEnv()).RERANK_MIN_SCORE).toBeUndefined()
    const set = loadConfig(
      createTestEnv({ KNOWLEDGE_TENANT_DAILY_COST_USD: '2.5', RERANK_MIN_SCORE: '0.3' })
    )
    expect(set.KNOWLEDGE_TENANT_DAILY_COST_USD).toBe(2.5)
    expect(set.RERANK_MIN_SCORE).toBe(0.3)
    expect(loadConfig(createTestEnv({ RERANK_MIN_SCORE: '' })).RERANK_MIN_SCORE).toBeUndefined()
    expect(() => loadConfig(createTestEnv({ RERANK_MIN_SCORE: '1.5' }))).toThrow()
  })
})

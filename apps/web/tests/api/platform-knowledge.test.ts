// @vitest-isolate
// Stubs the global fetch (the platform OpenAI embedder), so this file needs its own module registry.
/**
 * PLATFORM documents (`documents.tenant_id` NULL — knowledge about the app itself), end to end on
 * real Postgres:
 *
 * - RLS: on a scoped app-role connection, tenant A and tenant B both READ a platform document and
 *   its chunks, neither reads the other's tenant documents, and neither can insert, update or
 *   delete a null-tenant row (the policy pair `tenantIsolation` + `platformReadable`).
 * - `ingestPlatformDocument`: only from a job or a cron task; refuses an unnamespaced source and
 *   one not namespaced with an installed plugin; FAILS with nothing written without a platform
 *   embedder; idempotent on `(source, externalId)` (same text = no embeddings call, changed text =
 *   re-indexed in place); `prunePlatformDocuments` deletes what is not kept.
 * - `searchKnowledge` / `searchChunks`: platform passages only when their source is named; one
 *   corpus per embeddings model when tenant and platform models differ; `semantic` reporting.
 * - Every tenant document view (list, read, the `/search` route, `list_documents`, `get_document`)
 *   never shows a platform document; `search_knowledge` shows it only with `platformSources`.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fullAccessScope } from '@/api/services/access'
import {
  getDocumentTool,
  listDocumentsTool,
  searchKnowledgeTool,
} from '@/api/services/agents/tools'
import { ingestText } from '@/api/services/ai/ingest'
import { searchChunks } from '@/api/services/ai/retrieval'
import { loadConfig } from '@/config'
import { affected, rows } from '@/db/client'
import { chunks, documents } from '@/db/schema'
import { APP_ROLE } from '@/db/schema/rls'
import {
  ingestPlatformDocument,
  PlatformEmbeddingsError,
  prunePlatformDocuments,
  searchKnowledge,
} from '@/plugins/api'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { makeCronCtx, makeEmailCtx, makeJobCtx, makeRequestCtx } from '../kit/unit'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()

/** A source of the vendored reference plugin, unique per test (platform rows are not per-tenant). */
const aSource = () => `example-feature:guide-${crypto.randomUUID().slice(0, 8)}`

/** A unit vector along axis `i` (1024-dim) — a fake embedding a test controls exactly. */
function axis(i: number): number[] {
  const v = new Array<number>(1024).fill(0)
  v[i] = 1
  return v
}

const GUIDE =
  'Inviting a teammate: open Members, choose Invite, enter their email address. The invitation expires after seven days.'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function platformRows(source: string) {
  return db
    .select()
    .from(documents)
    .where(and(isNull(documents.tenantId), eq(documents.source, source)))
}

describe('RLS on platform documents (scoped app-role connection)', () => {
  /** Run `fn` as the app role with `app.tenant_id` set, inside one rolled-back transaction. */
  async function asTenant<T>(tenantId: string, fn: (tx: typeof db) => Promise<T>): Promise<T> {
    let out: T | undefined
    await db
      .transaction(async tx => {
        await tx.execute(sql.raw(`set local role ${APP_ROLE}`))
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`)
        out = await fn(tx)
        throw new RollBack()
      })
      .catch(err => {
        if (!(err instanceof RollBack)) throw err
      })
    return out as T
  }
  class RollBack extends Error {}

  it('both tenants read a platform document; neither reads the other; neither writes a null-tenant row', async () => {
    const a = await createTestTenantWithUser(db, 'owner')
    const b = await createTestTenantWithUser(db, 'owner')
    const source = aSource()
    const platform = await ingestPlatformDocument(makeJobCtx({ db }), {
      source,
      externalId: 'members/invite',
      title: 'Inviting a teammate',
      text: GUIDE,
    })
    const cfg = loadConfig(createTestEnv())
    const env = createTestEnv()
    const docA = await ingestText(db, cfg, env, {
      tenantId: a.tenant.id,
      userId: a.user.id,
      title: 'A only',
      text: 'Tenant A private notes.',
    })
    const docB = await ingestText(db, cfg, env, {
      tenantId: b.tenant.id,
      userId: b.user.id,
      title: 'B only',
      text: 'Tenant B private notes.',
    })

    for (const [self, other] of [
      [a.tenant.id, docB.document.id],
      [b.tenant.id, docA.document.id],
    ] as const) {
      const seen = await asTenant(self, async tx => ({
        docs: (await tx.select({ id: documents.id }).from(documents)).map(r => r.id),
        platformChunks: (
          await tx
            .select({ id: chunks.id })
            .from(chunks)
            .where(eq(chunks.documentId, platform.documentId))
        ).length,
        otherChunks: (
          await tx.select({ id: chunks.id }).from(chunks).where(eq(chunks.documentId, other))
        ).length,
      }))
      expect(seen.docs).toContain(platform.documentId)
      expect(seen.docs).not.toContain(other)
      expect(seen.platformChunks).toBeGreaterThan(0)
      expect(seen.otherChunks).toBe(0)
    }

    // INSERT a null-tenant document: refused by tenantIsolation's WITH CHECK.
    await expect(
      asTenant(a.tenant.id, tx =>
        tx.insert(documents).values({
          tenantId: null,
          title: 'Forged guide page',
          source,
          externalId: 'forged',
          content: 'x',
        })
      )
    ).rejects.toThrow()
    // INSERT a null-tenant chunk onto the platform document: refused the same way.
    await expect(
      asTenant(a.tenant.id, tx =>
        tx.insert(chunks).values({
          documentId: platform.documentId,
          tenantId: null,
          seq: 99,
          text: 'forged',
          embedding: axis(7),
        })
      )
    ).rejects.toThrow()
    // Move one's own row INTO the platform corpus: refused (the new row fails WITH CHECK).
    await expect(
      asTenant(a.tenant.id, tx =>
        tx.update(documents).set({ tenantId: null }).where(eq(documents.id, docA.document.id))
      )
    ).rejects.toThrow()
    // UPDATE / DELETE the platform rows: no UPDATE or DELETE policy covers them — nothing moves.
    const touched = await asTenant(a.tenant.id, async tx => ({
      updated: affected(
        await tx
          .update(documents)
          .set({ title: 'Defaced' })
          .where(eq(documents.id, platform.documentId))
      ),
      deletedChunks: affected(
        await tx.delete(chunks).where(eq(chunks.documentId, platform.documentId))
      ),
      deleted: affected(await tx.delete(documents).where(eq(documents.id, platform.documentId))),
    }))
    expect(touched).toEqual({ updated: 0, deletedChunks: 0, deleted: 0 })
    const [after] = await platformRows(source)
    expect(after?.title).toBe('Inviting a teammate')
  })

  it('the CHECK refuses a platform document without a source and external id', async () => {
    await expect(
      db.insert(documents).values({ tenantId: null, title: 'Orphan', content: 'x' })
    ).rejects.toThrow()
  })
})

describe('ingestPlatformDocument / prunePlatformDocuments', () => {
  it('embeds with the platform embedder, and is a no-op for the same text', async () => {
    const env = createTestEnv()
    const ctx = makeJobCtx({ db, env })
    const source = aSource()
    const first = await ingestPlatformDocument(ctx, {
      source,
      externalId: 'members/invite',
      title: 'Inviting a teammate',
      text: GUIDE,
    })
    expect(first.status).toBe('created')
    expect(first.chunkCount).toBeGreaterThan(0)
    const [row] = await platformRows(source)
    expect(row).toMatchObject({ status: 'indexed', embeddingModel: '@cf/baai/bge-m3' })
    const vectors = await db
      .select({ embedding: chunks.embedding, tenantId: chunks.tenantId })
      .from(chunks)
      .where(eq(chunks.documentId, first.documentId))
    expect(vectors.every(c => c.tenantId === null && c.embedding.length === 1024)).toBe(true)

    const runs = stubs(env).ai?.runs.length ?? 0
    const again = await ingestPlatformDocument(ctx, {
      source,
      externalId: 'members/invite',
      title: 'Inviting a teammate',
      text: GUIDE,
    })
    expect(again).toEqual({ ...first, status: 'unchanged' })
    expect(stubs(env).ai?.runs.length).toBe(runs)
  })

  it('re-indexes the same row when the text changes', async () => {
    const ctx = makeCronCtx({ db })
    const source = aSource()
    const first = await ingestPlatformDocument(ctx, {
      source,
      externalId: 'p',
      title: 'Page',
      text: 'The old wording about volcanoes.',
    })
    const second = await ingestPlatformDocument(ctx, {
      source,
      externalId: 'p',
      title: 'Page',
      text: 'The new wording about railways.',
    })
    expect(second).toMatchObject({ documentId: first.documentId, status: 'updated' })
    const texts = await db
      .select({ text: chunks.text })
      .from(chunks)
      .where(eq(chunks.documentId, first.documentId))
    expect(texts.map(t => t.text).join(' ')).toContain('railways')
    expect(texts.map(t => t.text).join(' ')).not.toContain('volcanoes')
    expect(await platformRows(source)).toHaveLength(1)
  })

  it('fails with nothing written when no platform embedder exists', async () => {
    const source = aSource()
    const ctx = makeJobCtx({ db, env: createTestEnv({ AI: undefined }) })
    await expect(
      ingestPlatformDocument(ctx, { source, externalId: 'x', title: 'X', text: GUIDE })
    ).rejects.toBeInstanceOf(PlatformEmbeddingsError)
    expect(await platformRows(source)).toEqual([])
  })

  it('fails with the previous revision intact when the embedder errors', async () => {
    const env = createTestEnv()
    const ctx = makeJobCtx({ db, env })
    const source = aSource()
    await ingestPlatformDocument(ctx, { source, externalId: 'x', title: 'X', text: GUIDE })
    const ai = stubs(env).ai
    if (!ai) throw new Error('no AI stub')
    ai.respond = () => {
      throw new Error('provider down')
    }
    await expect(
      ingestPlatformDocument(ctx, { source, externalId: 'x', title: 'X', text: 'Rewritten.' })
    ).rejects.toThrow()
    const [row] = await platformRows(source)
    expect(row?.content).toBe(GUIDE)
  })

  it('refuses a source that is not namespaced with an installed plugin id', async () => {
    const ctx = makeJobCtx({ db })
    for (const source of ['guide', 'kit:guide', 'not-installed:guide', ':x']) {
      await expect(
        ingestPlatformDocument(ctx, { source, externalId: 'x', title: 'X', text: GUIDE })
      ).rejects.toMatchObject({ code: 'invalid_source' })
    }
  })

  it('runs only from a job or a cron context', async () => {
    const email = makeEmailCtx({ db })
    await expect(
      // @ts-expect-error — an EmailCtx carries no `kind`: refused at compile time AND at run time
      ingestPlatformDocument(email, { source: aSource(), externalId: 'x', title: 'X', text: GUIDE })
    ).rejects.toThrow(/JobCtx or a CronCtx/)
  })

  it('prunes what is not kept, within one source only', async () => {
    const ctx = makeJobCtx({ db })
    const source = aSource()
    const other = aSource()
    for (const id of ['a', 'b', 'c']) {
      await ingestPlatformDocument(ctx, {
        source,
        externalId: id,
        title: id,
        text: `${id} ${GUIDE}`,
      })
    }
    await ingestPlatformDocument(ctx, { source: other, externalId: 'a', title: 'a', text: GUIDE })
    expect(await prunePlatformDocuments(ctx, { source, keepExternalIds: ['b'] })).toBe(2)
    expect((await platformRows(source)).map(r => r.externalId)).toEqual(['b'])
    expect(await platformRows(other)).toHaveLength(1)
    expect(await prunePlatformDocuments(ctx, { source, keepExternalIds: [] })).toBe(1)
  })
})

describe('searching platform documents', () => {
  async function seeded() {
    const source = aSource()
    await ingestPlatformDocument(makeJobCtx({ db }), {
      source,
      externalId: 'members/invite',
      title: 'Inviting a teammate',
      text: GUIDE,
    })
    const { tenant, user } = await createTestTenantWithUser(db, 'member')
    const env = createTestEnv()
    const cfg = loadConfig(env)
    await ingestText(db, cfg, env, {
      tenantId: tenant.id,
      userId: user.id,
      title: 'Our onboarding',
      text: 'Our own onboarding: invite new hires on their first day.',
      source: 'upload',
    })
    return { source, tenant, user, env, cfg }
  }

  it('finds platform passages only when the source is named, beside the tenant’s own', async () => {
    const { source, tenant, env, cfg } = await seeded()
    const scope = fullAccessScope(tenant.id)
    const without = await searchChunks(db, cfg, env, scope, { query: 'invite teammate', limit: 10 })
    expect(without.map(h => h.title)).toEqual(['Our onboarding'])

    const ctx = makeRequestCtx({ db, env, tenantId: tenant.id, role: 'member' })
    const both = await searchKnowledge(ctx, { query: 'invite teammate', platformSources: [source] })
    expect(both.semantic).toBe('used')
    const platformHit = both.hits.find(h => h.platform)
    expect(platformHit).toMatchObject({
      source,
      externalId: 'members/invite',
      title: 'Inviting a teammate',
      charOffset: 0,
    })
    expect(platformHit?.denseRank).not.toBeNull()
    expect(both.hits.some(h => h.title === 'Our onboarding' && !h.platform)).toBe(true)

    const platformOnly = await searchKnowledge(ctx, {
      query: 'invite teammate',
      sources: [],
      platformSources: [source],
    })
    expect(platformOnly.hits.map(h => h.platform)).toEqual([true])
    const narrowed = await searchKnowledge(ctx, { query: 'invite', sources: ['nothing:here'] })
    expect(narrowed.hits).toEqual([])
  })

  it('refuses an unnamespaced platform source', async () => {
    const { tenant, env } = await seeded()
    const ctx = makeRequestCtx({ db, env, tenantId: tenant.id })
    await expect(
      searchKnowledge(ctx, { query: 'invite', platformSources: ['guide'] })
    ).rejects.toMatchObject({ code: 'invalid_source' })
  })

  it('embeds the query once per model when the platform and tenant embedders differ', async () => {
    // Platform: OpenAI (EMBEDDINGS_API_KEY) in its OWN vector space — anything about inviting is
    // axis 5, everything else axis 700 — so a platform passage is only near a query embedded by it.
    const openAiCalls: string[][] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] }
      openAiCalls.push(body.input)
      return new Response(
        JSON.stringify({
          data: body.input.map((t, index) => ({
            index,
            embedding: axis(/invit/i.test(t) ? 5 : 700),
          })),
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    })
    const env = createTestEnv({ EMBEDDINGS_API_KEY: 'sk-test-platform' })
    const source = aSource()
    await ingestPlatformDocument(makeJobCtx({ db, env }), {
      source,
      externalId: 'members/invite',
      title: 'Inviting a teammate',
      text: GUIDE,
    })
    const [row] = await platformRows(source)
    expect(row?.embeddingModel).toBe('text-embedding-3-small')

    const { tenant } = await createTestTenantWithUser(db, 'member')
    const ctx = makeRequestCtx({ db, env, tenantId: tenant.id })
    const aiRuns = stubs(env).ai?.runs.length ?? 0
    openAiCalls.length = 0
    const result = await searchKnowledge(ctx, {
      query: 'inviting a teammate members invite',
      platformSources: [source],
    })
    // The tenant's query vector came from Workers AI, the platform's from OpenAI: once each.
    expect(stubs(env).ai?.runs.length).toBe(aiRuns + 1)
    expect(openAiCalls).toEqual([['inviting a teammate members invite']])
    expect(result.semantic).toBe('used')
    expect(result.hits[0]).toMatchObject({ platform: true, denseRank: 1 })
  })

  it('reports semantic unavailable and still answers by keyword when there is no embedder', async () => {
    const { source, tenant } = await seeded()
    const env = createTestEnv({ AI: undefined })
    const ctx = makeRequestCtx({ db, env, tenantId: tenant.id })
    const result = await searchKnowledge(ctx, { query: 'teammate', platformSources: [source] })
    expect(result.semantic).toBe('unavailable')
    expect(result.hits.map(h => [h.title, h.denseRank])).toEqual([['Inviting a teammate', null]])
  })
})

describe('tenant document views never show a platform document', () => {
  it('list, read, /search, list_documents and get_document stay tenant-only', async () => {
    const source = aSource()
    const platform = await ingestPlatformDocument(makeJobCtx({ db }), {
      source,
      externalId: 'members/invite',
      title: 'Inviting a teammate',
      text: GUIDE,
    })
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const env = createTestEnv()
    const cfg = loadConfig(env)

    const list = await json<{ items: { id: string }[] }>(
      await request('/api/ai/documents', { headers: cookie }, { env })
    )
    expect(list.items.map(d => d.id)).not.toContain(platform.documentId)
    for (const path of ['', '/content', '/passages', '/card']) {
      const res = await request(
        `/api/ai/documents/${platform.documentId}${path}`,
        { headers: cookie },
        { env }
      )
      expect(res.status, path).toBe(404)
    }
    const searched = await json<{ hits: { documentId: string }[] }>(
      await request(
        '/api/ai/documents/search',
        { method: 'POST', headers: cookie },
        // A client cannot widen its own search: extra keys are not part of the contract.
        { env, json: { query: 'invite teammate', platformSources: [source] } }
      )
    )
    expect(searched.hits.map(h => h.documentId)).not.toContain(platform.documentId)
    const del = await request(
      `/api/ai/documents/${platform.documentId}`,
      { method: 'DELETE', headers: cookie },
      { env }
    )
    expect(del.status).toBe(404)
    expect(await platformRows(source)).toHaveLength(1)

    const tool = { db, cfg, env, scope: fullAccessScope(tenant.id) }
    const listed = JSON.parse((await listDocumentsTool(tool).handler?.({})) ?? '{}') as {
      documents: { documentId: string }[]
    }
    expect(listed.documents.map(d => d.documentId)).not.toContain(platform.documentId)
    const read = JSON.parse(
      (await getDocumentTool(tool).handler?.({ documentId: platform.documentId })) ?? '{}'
    ) as { error?: string; text?: string }
    expect(read.text).toBeUndefined()
    expect(read.error).toBeDefined()

    const plain = JSON.parse(
      (await searchKnowledgeTool(tool).handler?.({ query: 'invite teammate' })) ?? '{}'
    ) as { documents: { documentId: string }[] }
    expect(plain.documents.map(d => d.documentId)).not.toContain(platform.documentId)
    const withPlatform = JSON.parse(
      (await searchKnowledgeTool(tool, { platformSources: [source] }).handler?.({
        query: 'invite teammate',
      })) ?? '{}'
    ) as { documents: { documentId: string; platform?: true }[]; hint?: string }
    expect(withPlatform.documents).toEqual([
      expect.objectContaining({ documentId: platform.documentId, platform: true }),
    ])
    expect(withPlatform.hint).toMatch(/get_document cannot open them/)
  })

  it('raw platform rows carry no tenant (the fixture really is a platform row)', async () => {
    const source = aSource()
    await ingestPlatformDocument(makeJobCtx({ db }), {
      source,
      externalId: 'x',
      title: 'X',
      text: GUIDE,
    })
    const [r] = rows<{ n: string }>(
      await db.execute(
        sql`select count(*)::text as n from documents where tenant_id is null and source = ${source}`
      )
    )
    expect(r?.n).toBe('1')
  })
})

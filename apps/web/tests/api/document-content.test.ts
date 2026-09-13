/**
 * Reading a document (D18): `GET /api/ai/documents/:id/{content,passages,card}`. The windows are
 * cut in Postgres, so the arithmetic is asserted against real rows rather than a JS slice:
 * offsets, `hasMore`/`nextOffset`, a clamped over-ask, the last window. Then the properties that
 * are security rather than behaviour — an unknown id and another tenant's id answer with the SAME
 * body (no existence oracle), no passage item carries an `embedding`, and a document with no text
 * is a 409 rather than an empty window.
 */
import {
  DOCUMENT_EXCERPT_CHARS,
  DOCUMENT_WINDOW_MAX_CHARS,
  documentCardSchema,
  documentContentSchema,
  documentPassageSchema,
} from '@rocketflare/shared/ai/embeddings'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { chunks, documents } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()
const passagesResponseSchema = paginatedResponse(documentPassageSchema)

async function actor(role: 'owner' | 'admin' | 'member' = 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

/** A `documents` row written directly — this file tests reading, not ingesting. */
async function seedDocument(
  tenantId: string,
  ownerUserId: string,
  values: Partial<typeof documents.$inferInsert> = {}
) {
  const [row] = await db
    .insert(documents)
    .values({
      tenantId,
      ownerUserId,
      title: 'Handbook',
      source: 'upload',
      contentType: 'text/plain',
      sizeBytes: 0,
      content: null,
      chunkCount: 0,
      status: 'indexed',
      ...values,
    })
    .returning()
  return row as typeof documents.$inferSelect
}

const TEXT = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about railways.`).join('\n\n')

describe('GET /api/ai/documents/:id/content', () => {
  it('windows the text in Postgres: offsets, hasMore/nextOffset, and a clamped over-ask', async () => {
    const a = await actor()
    const doc = await seedDocument(a.tenant.id, a.user.id, {
      content: TEXT,
      sizeBytes: TEXT.length,
      chunkCount: 3,
    })

    const first = await request(`/api/ai/documents/${doc.id}/content?maxChars=100`, {
      headers: a.cookie,
    })
    expect(first.status).toBe(200)
    const head = documentContentSchema.parse(await json(first))
    expect(head).toMatchObject({
      documentId: doc.id,
      title: 'Handbook',
      status: 'indexed',
      passages: 3,
      totalChars: TEXT.length,
      offset: 0,
      returnedChars: 100,
      hasMore: true,
      nextOffset: 100,
    })
    expect(head.text).toBe(TEXT.slice(0, 100))

    const next = await request(
      `/api/ai/documents/${doc.id}/content?offset=${head.nextOffset}&maxChars=100`,
      { headers: a.cookie }
    )
    const second = documentContentSchema.parse(await json(next))
    expect(second.text).toBe(TEXT.slice(100, 200))

    // The last window reports no more, and an offset past the end is an empty (not failed) read.
    const tail = documentContentSchema.parse(
      await json(
        await request(`/api/ai/documents/${doc.id}/content?offset=${TEXT.length - 10}`, {
          headers: a.cookie,
        })
      )
    )
    expect(tail).toMatchObject({ returnedChars: 10, hasMore: false, nextOffset: null })
    const past = documentContentSchema.parse(
      await json(
        await request(`/api/ai/documents/${doc.id}/content?offset=${TEXT.length + 500}`, {
          headers: a.cookie,
        })
      )
    )
    expect(past).toMatchObject({ text: '', offset: TEXT.length, hasMore: false })
  })

  it('refuses a maxChars above the cap (the cap is declared, not discovered)', async () => {
    const a = await actor()
    const doc = await seedDocument(a.tenant.id, a.user.id, { content: TEXT })
    const res = await request(
      `/api/ai/documents/${doc.id}/content?maxChars=${DOCUMENT_WINDOW_MAX_CHARS + 1}`,
      { headers: a.cookie }
    )
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'validation_failed', statusCode: 400 })
  })

  it('409s a document with no text, distinguishing pending from failed', async () => {
    const a = await actor()
    const pending = await seedDocument(a.tenant.id, a.user.id, {
      status: 'pending',
      contentType: 'application/pdf',
    })
    const failed = await seedDocument(a.tenant.id, a.user.id, {
      status: 'failed',
      contentType: 'application/pdf',
      error: 'conversion returned an error',
    })
    const pendingRes = await request(`/api/ai/documents/${pending.id}/content`, {
      headers: a.cookie,
    })
    expect(pendingRes.status).toBe(409)
    expect(await json(pendingRes)).toMatchObject({ code: 'document_not_converted' })
    const failedRes = await request(`/api/ai/documents/${failed.id}/content`, { headers: a.cookie })
    expect(failedRes.status).toBe(409)
    expect(await json(failedRes)).toMatchObject({ code: 'document_conversion_failed' })
  })

  it('answers an unknown id and another tenant’s id with the same 404 body', async () => {
    const a = await actor()
    const b = await actor()
    const theirs = await seedDocument(b.tenant.id, b.user.id, { content: TEXT })
    const unknown = await request(`/api/ai/documents/${crypto.randomUUID()}/content`, {
      headers: a.cookie,
    })
    const crossTenant = await request(`/api/ai/documents/${theirs.id}/content`, {
      headers: a.cookie,
    })
    expect(unknown.status).toBe(404)
    expect(crossTenant.status).toBe(404)
    expect(await json(crossTenant)).toEqual(await json(unknown))
  })

  it('401s anonymously and 403s a session with no tenant', async () => {
    const a = await actor()
    const doc = await seedDocument(a.tenant.id, a.user.id, { content: TEXT })
    const anon = await request(`/api/ai/documents/${doc.id}/content`)
    expect(anon.status).toBe(401)
    // A user with no membership at all — a member's tenant-less session just resolves to theirs.
    const stranger = await createTestUser(db)
    const tenantless = sessionCookieHeader(await createTestSession(db, stranger.id))
    const res = await request(`/api/ai/documents/${doc.id}/content`, { headers: tenantless })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: 'no_tenant' })
  })
})

describe('GET /api/ai/documents/:id/passages', () => {
  it('lists passages by seq, never carries an embedding, and nulls an unlocatable offset', async () => {
    const a = await actor()
    const doc = await seedDocument(a.tenant.id, a.user.id, { content: TEXT, chunkCount: 3 })
    const embedding = new Array(1024).fill(0)
    await db.insert(chunks).values([
      // Inserted out of order on purpose: the route orders, the insert does not.
      {
        tenantId: a.tenant.id,
        documentId: doc.id,
        seq: 1,
        text: TEXT.slice(200, 320),
        tokenCount: 30,
        embedding,
      },
      {
        tenantId: a.tenant.id,
        documentId: doc.id,
        seq: 0,
        text: TEXT.slice(0, 120),
        tokenCount: 30,
        embedding,
      },
      // Text that is not in `content` — a re-chunked document; its offset must be null, not 0.
      {
        tenantId: a.tenant.id,
        documentId: doc.id,
        seq: 2,
        text: 'a passage that no longer appears in the stored text',
        tokenCount: 12,
        embedding,
      },
    ])

    const res = await request(`/api/ai/documents/${doc.id}/passages`, { headers: a.cookie })
    expect(res.status).toBe(200)
    const body = await json(res)
    const page = passagesResponseSchema.parse(body)
    expect(page.items.map(p => p.seq)).toEqual([0, 1, 2])
    expect(page.pagination.total).toBe(3)
    expect(page.items[0]).toMatchObject({ charOffset: 0, tokenCount: 30 })
    expect(page.items[1]?.charOffset).toBe(200)
    expect(page.items[2]?.charOffset).toBeNull()
    // The guard that matters: 1024 floats per row must never reach the wire.
    expect(JSON.stringify(body)).not.toContain('embedding')
  })

  it('404s across tenants and for an unknown id', async () => {
    const a = await actor()
    const b = await actor()
    const theirs = await seedDocument(b.tenant.id, b.user.id, { content: TEXT })
    const res = await request(`/api/ai/documents/${theirs.id}/passages`, { headers: a.cookie })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/ai/documents/:id/card', () => {
  it('carries an excerpt of the text, capped and whitespace-collapsed', async () => {
    const a = await actor()
    const doc = await seedDocument(a.tenant.id, a.user.id, {
      title: 'Railway handbook',
      contentType: 'application/pdf',
      content: TEXT,
      sizeBytes: 4096,
      chunkCount: 3,
    })
    const card = documentCardSchema.parse(
      await json(await request(`/api/ai/documents/${doc.id}/card`, { headers: a.cookie }))
    )
    expect(card).toMatchObject({
      id: doc.id,
      title: 'Railway handbook',
      typeLabel: 'PDF',
      status: 'indexed',
      passages: 3,
      sizeBytes: 4096,
      href: `/documents/${doc.id}`,
    })
    expect(card.excerpt).not.toBeNull()
    expect((card.excerpt as string).length).toBeLessThanOrEqual(DOCUMENT_EXCERPT_CHARS)
    expect(card.excerpt).not.toContain('\n')
    expect(card.excerpt?.startsWith('Paragraph 0 about railways.')).toBe(true)
  })

  it('has no excerpt while a document is pending', async () => {
    const a = await actor()
    const doc = await seedDocument(a.tenant.id, a.user.id, {
      status: 'pending',
      contentType: 'application/pdf',
    })
    const card = documentCardSchema.parse(
      await json(await request(`/api/ai/documents/${doc.id}/card`, { headers: a.cookie }))
    )
    expect(card).toMatchObject({ status: 'pending', excerpt: null })
  })
})

describe('the documents list still hides the text', () => {
  it('never returns `content` from GET /api/ai/documents/:id', async () => {
    const a = await actor()
    const doc = await seedDocument(a.tenant.id, a.user.id, { content: TEXT })
    const body = await json(await request(`/api/ai/documents/${doc.id}`, { headers: a.cookie }))
    expect(body).not.toHaveProperty('content')
    await db.delete(documents).where(eq(documents.id, doc.id))
  })
})

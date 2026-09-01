/**
 * `POST /api/ai/documents/upload` (D18) end to end over the in-memory R2 bucket and the AI stub:
 * a Markdown file (declared type empty, as browsers send `.md`) is decoded and indexed inline —
 * object under `tenants/<t>/documents/`, `files` row scope `documents`, `fileId` on the document,
 * chunks present; a PDF returns `pending` with a `document.convert` job on the queue and no
 * conversion from the route; a PDF on a Worker without the `AI` binding → 503
 * `conversion_not_configured` and NOTHING written; no embeddings provider → 503, nothing written;
 * 415 / 413 / 400 envelopes; title defaults to the filename; deleting the document removes chunks,
 * the object and the `files` row; `DELETE /api/files/:id` on the original → 409 `owned_by_document`;
 * cross-tenant 404; anon 401.
 */
import { documentSchema } from '@rocketflare/shared/ai/embeddings'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { chunks, documents, files } from '@/db/schema'
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

async function actor(role: 'owner' | 'admin' | 'member' = 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

interface Part {
  bytes: BufferSource | string
  name: string
  type: string
}

function upload(
  env: TestEnv,
  cookie: Record<string, string>,
  file: Part,
  fields: Record<string, string> = {}
) {
  const form = new FormData()
  form.append('file', new Blob([file.bytes], { type: file.type }), file.name)
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return request(
    '/api/ai/documents/upload',
    { method: 'POST', headers: cookie, body: form },
    { env }
  )
}

const MD = '# Handbook\n\nThe volcano erupted.\r\n\r\nBananas are yellow.'
const md = (name = 'handbook.md', type = ''): Part => ({ bytes: MD, name, type })
const pdf = (name = 'report.pdf'): Part => ({
  bytes: 'Quarterly report: the railway opened in May.',
  name,
  type: 'application/pdf',
})

describe('POST /api/ai/documents/upload', () => {
  it('a Markdown file (empty declared type) → 201 indexed, object + files row + fileId + chunks', async () => {
    const { tenant, user, cookie } = await actor()
    const env = createTestEnv()
    const res = await upload(env, cookie, md())
    expect(res.status).toBe(201)
    const doc = documentSchema.parse(await json(res))
    expect(doc).toMatchObject({
      tenantId: tenant.id,
      ownerUserId: user.id,
      title: 'handbook',
      source: 'handbook.md',
      contentType: 'text/markdown',
      status: 'indexed',
      sizeBytes: MD.length,
    })
    expect(doc.chunkCount).toBeGreaterThan(0)
    expect(doc.fileId).toBeTruthy()

    const [file] = await db
      .select()
      .from(files)
      .where(eq(files.id, doc.fileId as string))
    expect(file).toMatchObject({
      tenantId: tenant.id,
      ownerUserId: user.id,
      scope: 'documents',
      filename: 'handbook.md',
      contentType: 'text/markdown',
    })
    expect(file?.key.startsWith(`tenants/${tenant.id}/documents/`)).toBe(true)
    const object = stubs(env).files.objects.get(file?.key ?? '')
    expect(object).toBeDefined()
    expect(object?.httpMetadata?.contentType).toBe('text/markdown')

    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id))
    // Decoded, CRLF normalised, never returned by the API.
    expect(row?.content).toBe(MD.replace(/\r\n/g, '\n'))
    const pieces = await db.select().from(chunks).where(eq(chunks.documentId, doc.id))
    expect(pieces).toHaveLength(doc.chunkCount)
    // No conversion for a text type.
    expect(stubs(env).ai?.conversions).toEqual([])
    // And it is searchable.
    const search = await request(
      '/api/ai/documents/search',
      { method: 'POST', headers: cookie },
      { env, json: { query: 'volcano' } }
    )
    expect(search.status).toBe(200)
    expect((await json<{ hits: { documentId: string }[] }>(search)).hits[0]?.documentId).toBe(
      doc.id
    )
  })

  it('explicit title and source win over the filename defaults', async () => {
    const { cookie } = await actor()
    const res = await upload(createTestEnv(), cookie, md('notes.txt', 'text/plain'), {
      title: '  Team notes ',
      source: 'wiki',
    })
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({
      title: 'Team notes',
      source: 'wiki',
      contentType: 'text/plain',
    })
  })

  it('a PDF → 201 pending, object stored, a document.convert job queued, nothing converted yet', async () => {
    const { tenant, cookie } = await actor()
    const env = createTestEnv()
    const res = await upload(env, cookie, pdf())
    expect(res.status).toBe(201)
    const doc = documentSchema.parse(await json(res))
    expect(doc).toMatchObject({
      title: 'report',
      contentType: 'application/pdf',
      status: 'pending',
      chunkCount: 0,
    })
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id))
    expect(row?.content).toBeNull()
    expect(row?.fileId).toBeTruthy()
    expect(stubs(env).queue.messages.map(m => m.body)).toEqual([
      expect.objectContaining({
        type: 'document.convert',
        payload: { tenantId: tenant.id, documentId: doc.id },
      }),
    ])
    expect(stubs(env).ai?.conversions).toEqual([])
    expect(stubs(env).ai?.runs).toEqual([])
  })

  it('a PDF without the AI binding → 503 conversion_not_configured and nothing written', async () => {
    const { tenant, cookie } = await actor()
    const env = createTestEnv({ AI: undefined, EMBEDDINGS_API_KEY: 'sk-test-embeddings' })
    const res = await upload(env, cookie, pdf())
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ code: 'conversion_not_configured' })
    expect(await db.select().from(documents).where(eq(documents.tenantId, tenant.id))).toEqual([])
    expect(await db.select().from(files).where(eq(files.tenantId, tenant.id))).toEqual([])
    expect(stubs(env).files.objects.size).toBe(0)
    // A text type still works on that Worker (embeddings via the key).
    const ok = await upload(env, cookie, md())
    expect(ok.status).toBe(201)
  })

  it('no embeddings provider at all → 503 ai_not_configured and nothing written', async () => {
    const { tenant, cookie } = await actor()
    const env = createTestEnv({ AI: undefined, EMBEDDINGS_API_KEY: undefined })
    const res = await upload(env, cookie, md())
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ code: 'ai_not_configured' })
    expect(await db.select().from(files).where(eq(files.tenantId, tenant.id))).toEqual([])
    expect(stubs(env).files.objects.size).toBe(0)
  })

  it('415 for a type outside the allowlist (images, executables), 413 over the cap, 400 without a file', async () => {
    const { cookie } = await actor()
    const env = createTestEnv()
    const png = await upload(env, cookie, { bytes: 'x', name: 'a.png', type: 'image/png' })
    expect(png.status).toBe(415)
    expect(await json(png)).toMatchObject({ code: 'unsupported_media_type' })
    const exe = await upload(env, cookie, {
      bytes: 'x',
      name: 'a.exe',
      type: 'application/octet-stream',
    })
    expect(exe.status).toBe(415)

    const big = await upload(env, cookie, {
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
      name: 'big.txt',
      type: 'text/plain',
    })
    expect(big.status).toBe(413)
    expect(await json(big)).toMatchObject({ code: 'payload_too_large' })

    const empty = await upload(env, cookie, { bytes: '', name: 'empty.txt', type: 'text/plain' })
    expect(empty.status).toBe(400)
    expect(await json(empty)).toMatchObject({ code: 'file_empty' })

    const form = new FormData()
    form.append('title', 'no file')
    const none = await request(
      '/api/ai/documents/upload',
      { method: 'POST', headers: cookie, body: form },
      { env }
    )
    expect(none.status).toBe(400)
    expect(await json(none)).toMatchObject({ code: 'file_required' })
    expect(stubs(env).files.objects.size).toBe(0)
  })

  it('anon → 401; another tenant cannot read the document or the file', async () => {
    const env = createTestEnv()
    expect((await upload(env, {}, md())).status).toBe(401)

    const a = await actor()
    const doc = documentSchema.parse(await json(await upload(env, a.cookie, md())))
    const b = await actor()
    const read = await request(`/api/ai/documents/${doc.id}`, { headers: b.cookie }, { env })
    expect(read.status).toBe(404)
    const file = await request(`/api/files/${doc.fileId}`, { headers: b.cookie }, { env })
    expect(file.status).toBe(404)
    // The owner can download the original.
    const mine = await request(`/api/files/${doc.fileId}`, { headers: a.cookie }, { env })
    expect(mine.status).toBe(200)
    expect(mine.headers.get('Content-Disposition')).toContain('attachment')
  })

  it('deleting the document removes chunks, the object and the files row; the file alone is 409', async () => {
    const { tenant, cookie } = await actor()
    const env = createTestEnv()
    const doc = documentSchema.parse(await json(await upload(env, cookie, md())))
    const fileId = doc.fileId as string
    const [file] = await db.select().from(files).where(eq(files.id, fileId))

    const viaFiles = await request(
      `/api/files/${fileId}`,
      { method: 'DELETE', headers: cookie },
      { env }
    )
    expect(viaFiles.status).toBe(409)
    expect(await json(viaFiles)).toMatchObject({ code: 'owned_by_document' })
    expect(stubs(env).files.objects.has(file?.key ?? '')).toBe(true)

    const res = await request(
      `/api/ai/documents/${doc.id}`,
      { method: 'DELETE', headers: cookie },
      { env }
    )
    expect(res.status).toBe(204)
    expect(await db.select().from(documents).where(eq(documents.id, doc.id))).toEqual([])
    expect(await db.select().from(chunks).where(eq(chunks.documentId, doc.id))).toEqual([])
    expect(await db.select().from(files).where(eq(files.id, fileId))).toEqual([])
    expect(stubs(env).files.objects.has(file?.key ?? '')).toBe(false)
    expect(
      await db
        .select()
        .from(files)
        .where(and(eq(files.tenantId, tenant.id), eq(files.scope, 'documents')))
    ).toEqual([])
  })

  it('a member may delete their own upload but not another member’s; admin may', async () => {
    const { tenant, cookie: ownerCookie } = await actor('owner')
    const env = createTestEnv()
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, tenant.id, 'member')
    const memberCookie = sessionCookieHeader(await createTestSession(db, member.id, tenant.id))
    const other = await createTestUser(db)
    await linkUserToTenant(db, other.id, tenant.id, 'member')
    const otherCookie = sessionCookieHeader(await createTestSession(db, other.id, tenant.id))

    const mine = documentSchema.parse(await json(await upload(env, memberCookie, md())))
    const theirs = documentSchema.parse(await json(await upload(env, otherCookie, md())))
    expect(
      (
        await request(
          `/api/ai/documents/${theirs.id}`,
          { method: 'DELETE', headers: memberCookie },
          { env }
        )
      ).status
    ).toBe(403)
    expect(
      (
        await request(
          `/api/ai/documents/${mine.id}`,
          { method: 'DELETE', headers: memberCookie },
          { env }
        )
      ).status
    ).toBe(204)
    expect(
      (
        await request(
          `/api/ai/documents/${theirs.id}`,
          { method: 'DELETE', headers: ownerCookie },
          { env }
        )
      ).status
    ).toBe(204)
    expect(stubs(env).files.objects.size).toBe(0)
  })
})

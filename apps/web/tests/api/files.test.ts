/**
 * `/api/files` (D23) end to end over the in-memory R2 bucket: avatar upload sets `users.avatarUrl`
 * and stores the object; MIME allowlist (415) and size cap (413); download streams the bytes with
 * Content-Type / Cache-Control / ETag; tenant isolation (404); delete = owner or admin+.
 */
import { uploadResponseSchema } from '@gmgo/shared/files'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { activityEvents, files, users } from '@/db/schema'
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

/** A real 1×1 PNG so the declared type and the bytes agree. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

async function tenantWithOwner() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  return {
    owner: user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function memberOf(tenantId: string, role: 'member' | 'admin' = 'member') {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
}

function upload(
  env: TestEnv,
  cookie: Record<string, string>,
  file: { bytes: BufferSource | string; name: string; type: string },
  scope = 'avatars'
) {
  const form = new FormData()
  form.append('file', new Blob([file.bytes], { type: file.type }), file.name)
  return request(
    `/api/files?scope=${scope}`,
    { method: 'POST', headers: cookie, body: form },
    { env }
  )
}

const png = (name = 'me.png') => ({ bytes: PNG_BYTES, name, type: 'image/png' })

describe('POST /api/files?scope=avatars', () => {
  it('201 → row, object in R2, users.avatarUrl = /api/files/<id>, activity recorded', async () => {
    const { owner, tenant, cookie } = await tenantWithOwner()
    const env = createTestEnv()
    const res = await upload(env, cookie, png('My Photo.png'))
    expect(res.status).toBe(201)
    const body = uploadResponseSchema.parse(await json(res))
    expect(body).toMatchObject({
      tenantId: tenant.id,
      ownerUserId: owner.id,
      scope: 'avatars',
      filename: 'My_Photo.png',
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
      url: `/api/files/${body.id}`,
    })

    const row = await db.query.files.findFirst({ where: eq(files.id, body.id) })
    expect(row?.key).toMatch(
      new RegExp(`^tenants/${tenant.id}/avatars/[0-9a-f-]{36}-My_Photo.png$`)
    )
    const stored = stubs(env).files.objects.get(row?.key ?? '')
    expect(stored).toBeDefined()
    expect(Buffer.from(stored?.body ?? new Uint8Array()).equals(PNG_BYTES)).toBe(true)
    expect(stored?.httpMetadata?.contentType).toBe('image/png')
    expect(stored?.customMetadata).toMatchObject({ tenantId: tenant.id, ownerUserId: owner.id })

    const [user] = await db.select().from(users).where(eq(users.id, owner.id))
    expect(user?.avatarUrl).toBe(`/api/files/${body.id}`)

    const activity = await db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.tenantId, tenant.id), eq(activityEvents.subjectId, body.id)))
    expect(activity.map(a => a.type)).toEqual(['file.uploaded'])
  })

  it('members may upload (create File) — 401 without a session', async () => {
    const { tenant } = await tenantWithOwner()
    const env = createTestEnv()
    const { cookie } = await memberOf(tenant.id)
    expect((await upload(env, cookie, png())).status).toBe(201)
    const anon = await upload(env, {}, png())
    expect(anon.status).toBe(401)
    expect(await json(anon)).toMatchObject({ error: expect.any(String), statusCode: 401 })
  })

  it('415 unsupported_media_type for a non-image avatar; 400 file_required without a file', async () => {
    const { cookie } = await tenantWithOwner()
    const env = createTestEnv()
    const bad = await upload(env, cookie, { bytes: 'hello', name: 'notes.txt', type: 'text/plain' })
    expect(bad.status).toBe(415)
    expect(await json(bad)).toMatchObject({
      error: expect.any(String),
      statusCode: 415,
      code: 'unsupported_media_type',
    })
    expect(stubs(env).files.objects.size).toBe(0)

    const form = new FormData()
    form.append('other', 'x')
    const missing = await request(
      '/api/files?scope=avatars',
      { method: 'POST', headers: cookie, body: form },
      { env }
    )
    expect(missing.status).toBe(400)
    expect(await json(missing)).toMatchObject({ statusCode: 400, code: 'file_required' })

    const notMultipart = await request(
      '/api/files?scope=avatars',
      { method: 'POST', headers: cookie },
      { env, json: { file: 'x' } }
    )
    expect(notMultipart.status).toBe(400)
  })

  it('413 payload_too_large above MAX_UPLOAD_BYTES (any scope)', async () => {
    const { cookie } = await tenantWithOwner()
    const env = createTestEnv()
    const big = new Uint8Array(6 * 1024 * 1024)
    const res = await upload(
      env,
      cookie,
      { bytes: big, name: 'big.bin', type: 'application/octet-stream' },
      'uploads'
    )
    expect(res.status).toBe(413)
    expect(await json(res)).toMatchObject({ statusCode: 413, code: 'payload_too_large' })
    expect(stubs(env).files.objects.size).toBe(0)
  })

  it('400 validation_failed for an unknown scope', async () => {
    const { cookie } = await tenantWithOwner()
    const res = await upload(createTestEnv(), cookie, png(), 'secrets')
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ statusCode: 400, code: 'validation_failed' })
  })
})

describe('GET /api/files/:id', () => {
  it('streams the bytes with Content-Type, Cache-Control: private and an ETag (304 on match)', async () => {
    const { cookie } = await tenantWithOwner()
    const env = createTestEnv()
    const { id } = uploadResponseSchema.parse(await json(await upload(env, cookie, png())))

    const res = await request(`/api/files/${id}`, { headers: cookie }, { env })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(res.headers.get('content-length')).toBe(String(PNG_BYTES.byteLength))
    expect(res.headers.get('content-disposition')).toBe('inline')
    const etag = res.headers.get('etag')
    expect(etag).toMatch(/^".+"$/)
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true)

    const cached = await request(
      `/api/files/${id}`,
      { headers: { ...cookie, 'If-None-Match': etag ?? '' } },
      { env }
    )
    expect(cached.status).toBe(304)
    expect(cached.headers.get('etag')).toBe(etag)
  })

  it('non-image uploads are served as attachments (no same-origin HTML execution)', async () => {
    const { cookie } = await tenantWithOwner()
    const env = createTestEnv()
    const up = await upload(
      env,
      cookie,
      { bytes: '<script>alert(1)</script>', name: 'evil.html', type: 'text/html' },
      'uploads'
    )
    expect(up.status).toBe(201)
    const { id } = uploadResponseSchema.parse(await json(up))
    const res = await request(`/api/files/${id}`, { headers: cookie }, { env })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="evil.html"')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('is tenant-scoped: another tenant gets 404; a bad id is 404; no session is 401', async () => {
    const a = await tenantWithOwner()
    const b = await tenantWithOwner()
    const env = createTestEnv()
    const { id } = uploadResponseSchema.parse(await json(await upload(env, a.cookie, png())))

    const cross = await request(`/api/files/${id}`, { headers: b.cookie }, { env })
    expect(cross.status).toBe(404)
    expect(await json(cross)).toMatchObject({ statusCode: 404, code: 'not_found' })
    expect((await request('/api/files/not-a-uuid', { headers: a.cookie }, { env })).status).toBe(
      404
    )
    expect((await request(`/api/files/${id}`, {}, { env })).status).toBe(401)
  })
})

describe('DELETE /api/files/:id', () => {
  it('uploader deletes own file (204, object gone, avatarUrl cleared); other member 403; admin 204', async () => {
    const { tenant, cookie: ownerCookie } = await tenantWithOwner()
    const env = createTestEnv()
    const uploader = await memberOf(tenant.id)
    const other = await memberOf(tenant.id)
    const admin = await memberOf(tenant.id, 'admin')

    // Own avatar → delete clears avatarUrl
    const mine = uploadResponseSchema.parse(await json(await upload(env, uploader.cookie, png())))
    const denied = await request(
      `/api/files/${mine.id}`,
      { method: 'DELETE', headers: other.cookie },
      { env }
    )
    expect(denied.status).toBe(403)
    expect(await json(denied)).toMatchObject({ statusCode: 403, code: 'forbidden' })

    const ok = await request(
      `/api/files/${mine.id}`,
      { method: 'DELETE', headers: uploader.cookie },
      { env }
    )
    expect(ok.status).toBe(204)
    expect(await db.query.files.findFirst({ where: eq(files.id, mine.id) })).toBeUndefined()
    expect(stubs(env).files.objects.size).toBe(0)
    const [me] = await db.select().from(users).where(eq(users.id, uploader.user.id))
    expect(me?.avatarUrl).toBeNull()
    expect(
      (await request(`/api/files/${mine.id}`, { headers: uploader.cookie }, { env })).status
    ).toBe(404)

    // Someone else's upload → admin and owner may delete (manage File)
    const theirs = uploadResponseSchema.parse(
      await json(await upload(env, uploader.cookie, png('doc.png'), 'uploads'))
    )
    expect(
      (
        await request(
          `/api/files/${theirs.id}`,
          { method: 'DELETE', headers: admin.cookie },
          { env }
        )
      ).status
    ).toBe(204)
    const again = uploadResponseSchema.parse(
      await json(await upload(env, uploader.cookie, png('doc2.png'), 'uploads'))
    )
    expect(
      (await request(`/api/files/${again.id}`, { method: 'DELETE', headers: ownerCookie }, { env }))
        .status
    ).toBe(204)
    const activity = await db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.tenantId, tenant.id), eq(activityEvents.type, 'file.deleted')))
    expect(activity.length).toBe(3)
  })

  it('cannot delete across tenants (404)', async () => {
    const a = await tenantWithOwner()
    const b = await tenantWithOwner()
    const env = createTestEnv()
    const { id } = uploadResponseSchema.parse(await json(await upload(env, a.cookie, png())))
    expect(
      (await request(`/api/files/${id}`, { method: 'DELETE', headers: b.cookie }, { env })).status
    ).toBe(404)
    expect(stubs(env).files.objects.size).toBe(1)
  })
})

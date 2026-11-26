/**
 * `/api/uploads` — the upload flow itself, over the in-memory R2 bucket and the Worker's own
 * stand-in for R2's presigned `PUT` (what a Worker without the R2 key pair hands out). The targets' own rules are `files.test.ts` and
 * `document-upload.test.ts`; this file is what every target shares:
 *
 *   - presign: the signed R2 URL when the key pair is set (the four signed headers, no payload hash),
 *     the Worker's own URL without it — capped at `MAX_WORKER_UPLOAD_BYTES` once deployed — and
 *     401 without a session;
 *   - the Worker PUT holds the store's rules — token, type, length, expiry, write-once;
 *   - confirm: a type or size other than the one declared is refused and the object deleted;
 *     another tenant's or another person's upload id is a 404; a second confirm is a 404; an
 *     expired upload is 410; confirming before the PUT is 400 `upload_missing` and can be retried;
 *   - the nightly prune deletes an unconfirmed object and leaves a confirmed one;
 *   - a plugin's target: its key under `tenants/<t>/<id>/`, `prepare` then `confirm`, its
 *     `contentTypes` 415, no `fields` without a schema, a key outside the tenant refused.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { prunePendingUploadsTask, SCHEDULED_TASKS } from '@/api/scheduled'
import {
  MAX_WORKER_UPLOAD_BYTES,
  prunePendingUploads,
  UPLOAD_CONFIRM_GRACE_SECONDS,
} from '@/api/services/uploads/service'
import { pendingUploads } from '@/db/schema'
import type { PluginUploadTarget } from '@/plugins/api'
import type { AnyServerPlugin } from '@/plugins/server'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json } from '../helpers/request'
import { withServerPlugins } from '../helpers/server-plugins'
import {
  confirmUploadRequest,
  createUploadRequest,
  directUpload,
  putUpload,
  ticketOf,
} from '../helpers/uploads'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const confirmed: { key: string; state: Record<string, unknown>; size: number }[] = []
const receipts: PluginUploadTarget<{ note: string }> = {
  id: 'uptest.receipt',
  maxBytes: 64,
  contentTypes: ['text/plain'],
  fields: z.object({ note: z.string() }),
  async prepare(_ctx, input) {
    return { state: { note: input.fields.note } }
  },
  async confirm(_ctx, upload) {
    confirmed.push({ key: upload.key, state: upload.state, size: upload.size })
    return { body: { ok: true, key: upload.key } }
  },
}
const plain: PluginUploadTarget = {
  id: 'uptest.plain',
  maxBytes: 64,
  async confirm() {
    return { status: 200, body: { ok: true } }
  },
}
const big: PluginUploadTarget = {
  id: 'uptest.big',
  maxBytes: 50 * 1024 * 1024,
  async confirm() {
    return { body: {} }
  },
}
const escaping: PluginUploadTarget = {
  id: 'uptest.escape',
  maxBytes: 64,
  async prepare() {
    return { key: 'tenants/someone-else/uptest/x' }
  },
  async confirm() {
    return { body: {} }
  },
}
withServerPlugins([
  { shared: { id: 'uptest' }, uploadTargets: [receipts, plain, big, escaping] },
] as unknown as AnyServerPlugin[])

const db = setupTestDatabase()

async function actor(role: 'owner' | 'member' = 'owner') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

const text = (body = 'hello world', name = 'notes.txt') => ({
  bytes: body,
  name,
  type: 'text/plain',
})

async function ticket(env: TestEnv, cookie: Record<string, string>, file = text()) {
  return ticketOf(await createUploadRequest(env, cookie, 'uploads', file))
}

async function pendingRow(id: string) {
  return db.query.pendingUploads.findFirst({ where: eq(pendingUploads.id, id) })
}

describe('POST /api/uploads', () => {
  it('signs an R2 PUT with type, length and write-once in the signature when the keys are set', async () => {
    const { cookie } = await actor()
    const env = createTestEnv({
      R2_ACCOUNT_ID: 'acct123',
      R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      R2_SECRET_ACCESS_KEY: 'secret',
      FILES_BUCKET_NAME: 'rf-files',
    })
    const t = await ticket(env, cookie)
    const url = new URL(t.url)
    expect(url.host).toBe('acct123.r2.cloudflarestorage.com')
    expect(url.pathname).toMatch(
      /^\/rf-files\/tenants\/[0-9a-f-]{36}\/uploads\/[0-9a-f-]{36}-notes\.txt$/
    )
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match'
    )
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(
      /^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/
    )
    expect(url.search).not.toContain('secret')
    expect(t.headers).toEqual({ 'Content-Type': 'text/plain', 'If-None-Match': '*' })
    expect((await pendingRow(t.uploadId))?.tokenHash).toBeNull()
  })

  it('a deployed Worker without the R2 keys takes the upload itself, the same three steps', async () => {
    const { cookie } = await actor()
    const env = createTestEnv({ APP_ENV: 'staging' })
    const t = await ticket(env, cookie)
    expect(new URL(t.url).pathname).toBe(`/api/upload-content/${t.uploadId}`)
    expect(t.headers).toEqual({ 'Content-Type': 'text/plain', 'If-None-Match': '*' })
    expect((await putUpload(env, t, 'hello world')).status).toBe(200)
    expect((await confirmUploadRequest(env, cookie, t.uploadId)).status).toBe(201)
  })

  it('through the Worker a deployed target is capped at MAX_WORKER_UPLOAD_BYTES; development and direct uploads are not', async () => {
    const { cookie } = await actor()
    const file = { bytes: new Uint8Array(MAX_WORKER_UPLOAD_BYTES + 1), name: 'big.bin', type: '' }
    const deployed = await createUploadRequest(
      createTestEnv({ APP_ENV: 'staging' }),
      cookie,
      'uptest.big',
      file
    )
    expect(deployed.status).toBe(413)
    expect(await json(deployed)).toMatchObject({
      code: 'payload_too_large',
      details: { maxBytes: MAX_WORKER_UPLOAD_BYTES, directUploads: false },
    })
    expect((await createUploadRequest(createTestEnv(), cookie, 'uptest.big', file)).status).toBe(
      201
    )
    const direct = createTestEnv({
      APP_ENV: 'staging',
      R2_ACCOUNT_ID: 'acct123',
      R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      R2_SECRET_ACCESS_KEY: 'secret',
      FILES_BUCKET_NAME: 'rf-files',
    })
    expect((await createUploadRequest(direct, cookie, 'uptest.big', file)).status).toBe(201)
  })

  it('401 without a session', async () => {
    const res = await createUploadRequest(createTestEnv(), {}, 'uploads', text())
    expect(res.status).toBe(401)
    expect(await json(res)).toMatchObject({ error: expect.any(String), statusCode: 401 })
  })
})

describe('the local PUT holds the store rules', () => {
  it('refuses a bad token, another type or length, a second write, and an expired URL', async () => {
    const { cookie } = await actor()
    const env = createTestEnv()
    const t = await ticket(env, cookie)

    const forged = { ...t, url: t.url.replace(/token=[^&]+/, 'token=nope') }
    expect((await putUpload(env, forged, 'hello world')).status).toBe(403)
    expect(
      (await putUpload(env, t, 'hello world', { ...t.headers, 'Content-Type': 'text/html' })).status
    ).toBe(403)
    expect((await putUpload(env, t, 'hello', t.headers)).status).toBe(403)
    expect((await putUpload(env, t, 'hello world', { 'Content-Type': 'text/plain' })).status).toBe(
      403
    )
    expect(stubs(env).files.objects.size).toBe(0)

    expect((await putUpload(env, t, 'hello world')).status).toBe(200)
    expect((await putUpload(env, t, 'HELLO WORLD')).status).toBe(412)

    const late = await ticket(env, cookie)
    await db
      .update(pendingUploads)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pendingUploads.id, late.uploadId))
    const res = await putUpload(env, late, 'hello world')
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: ERROR_CODES.uploadExpired })
  })
})

describe('POST /api/uploads/:id/confirm', () => {
  it('refuses an object of another size or type than declared, deletes it, and leaves the row for the prune', async () => {
    const { cookie } = await actor()
    const env = createTestEnv()
    for (const [body, type] of [
      ['hello', 'text/plain'],
      ['hello world', 'text/html'],
    ] as const) {
      const t = await ticket(env, cookie)
      const row = await pendingRow(t.uploadId)
      // What a store that did not hold the signature would have let through.
      await env.FILES?.put(row?.key ?? '', body, { httpMetadata: { contentType: type } })
      const res = await confirmUploadRequest(env, cookie, t.uploadId)
      expect(res.status).toBe(400)
      expect(await json(res)).toMatchObject({ statusCode: 400, code: ERROR_CODES.uploadMismatch })
      expect(stubs(env).files.objects.has(row?.key ?? '')).toBe(false)
      expect((await pendingRow(t.uploadId))?.confirmedAt).toBeNull()
    }
  })

  it('another tenant, another person and a second confirm all get the same 404', async () => {
    const a = await actor()
    const env = createTestEnv()
    const t = await ticket(env, a.cookie)
    expect((await putUpload(env, t, 'hello world')).status).toBe(200)

    const b = await actor()
    const other = await confirmUploadRequest(env, b.cookie, t.uploadId)
    expect(other.status).toBe(404)
    expect(await json(other)).toMatchObject({ statusCode: 404 })

    const colleague = await createTestUser(db)
    await linkUserToTenant(db, colleague.id, a.tenant.id, 'admin')
    const colleagueCookie = sessionCookieHeader(
      await createTestSession(db, colleague.id, a.tenant.id)
    )
    expect((await confirmUploadRequest(env, colleagueCookie, t.uploadId)).status).toBe(404)

    expect((await confirmUploadRequest(env, a.cookie, t.uploadId)).status).toBe(201)
    expect((await confirmUploadRequest(env, a.cookie, t.uploadId)).status).toBe(404)
  })

  it('an expired upload is 410 and its object is gone', async () => {
    const { cookie } = await actor()
    const env = createTestEnv()
    const t = await ticket(env, cookie)
    expect((await putUpload(env, t, 'hello world')).status).toBe(200)
    const key = (await pendingRow(t.uploadId))?.key ?? ''
    await db
      .update(pendingUploads)
      .set({ expiresAt: new Date(Date.now() - (UPLOAD_CONFIRM_GRACE_SECONDS + 1) * 1000) })
      .where(eq(pendingUploads.id, t.uploadId))
    const res = await confirmUploadRequest(env, cookie, t.uploadId)
    expect(res.status).toBe(410)
    expect(await json(res)).toMatchObject({ statusCode: 410, code: ERROR_CODES.uploadExpired })
    expect(stubs(env).files.objects.has(key)).toBe(false)
  })

  it('confirming before the PUT is 400 upload_missing, and the upload can still be finished', async () => {
    const { cookie } = await actor()
    const env = createTestEnv()
    const t = await ticket(env, cookie)
    const early = await confirmUploadRequest(env, cookie, t.uploadId)
    expect(early.status).toBe(400)
    expect(await json(early)).toMatchObject({ code: ERROR_CODES.uploadMissing })
    expect((await putUpload(env, t, 'hello world')).status).toBe(200)
    expect((await confirmUploadRequest(env, cookie, t.uploadId)).status).toBe(201)
  })
})

describe('the nightly prune', () => {
  it('deletes an unconfirmed upload with its object, and only the row of a confirmed one', async () => {
    const { cookie, tenant } = await actor()
    const env = createTestEnv()
    const abandoned = await ticket(env, cookie)
    expect((await putUpload(env, abandoned, 'hello world')).status).toBe(200)
    const abandonedKey = (await pendingRow(abandoned.uploadId))?.key ?? ''
    const kept = await ticket(env, cookie, text('kept bytes!', 'kept.txt'))
    expect((await putUpload(env, kept, 'kept bytes!')).status).toBe(200)
    expect((await confirmUploadRequest(env, cookie, kept.uploadId)).status).toBe(201)
    const keptKey = (await pendingRow(kept.uploadId))?.key ?? ''

    // Backdate THIS file's rows rather than pruning at a future `now`: the prune is cross-tenant,
    // and a future `now` would delete other files' uploads in flight.
    await db
      .update(pendingUploads)
      .set({ expiresAt: new Date(Date.now() - (UPLOAD_CONFIRM_GRACE_SECONDS + 60) * 1000) })
      .where(eq(pendingUploads.tenantId, tenant.id))
    await prunePendingUploads(db, env, new Date())

    expect(stubs(env).files.objects.has(abandonedKey)).toBe(false)
    expect(stubs(env).files.objects.has(keptKey)).toBe(true)
    const left = await db
      .select()
      .from(pendingUploads)
      .where(and(eq(pendingUploads.tenantId, tenant.id)))
    expect(left).toEqual([])
  })

  it('runs nightly', () => {
    expect(SCHEDULED_TASKS['0 4 * * *']).toContain(prunePendingUploadsTask)
  })
})

describe("a plugin's upload target", () => {
  it('keys the object under the tenant and plugin, carries prepare state to confirm', async () => {
    const { cookie, tenant } = await actor('member')
    const env = createTestEnv()
    const res = await directUpload(env, cookie, 'uptest.receipt', text('a receipt'), {
      note: 'lunch',
    })
    expect(res.status).toBe(201)
    const body = (await json(res)) as { key: string }
    expect(body.key).toMatch(new RegExp(`^tenants/${tenant.id}/uptest/[0-9a-f-]{36}-notes\\.txt$`))
    expect(confirmed.at(-1)).toEqual({ key: body.key, state: { note: 'lunch' }, size: 9 })
    expect(stubs(env).files.objects.has(body.key)).toBe(true)
  })

  it('415 outside its contentTypes, 413 above maxBytes, 400 for bad or unexpected fields', async () => {
    const { cookie } = await actor()
    const env = createTestEnv()
    const html = await createUploadRequest(
      env,
      cookie,
      'uptest.receipt',
      {
        bytes: '<p>',
        name: 'a.html',
        type: 'text/html',
      },
      { note: 'x' }
    )
    expect(html.status).toBe(415)
    const big = await createUploadRequest(env, cookie, 'uptest.receipt', text('x'.repeat(65)), {
      note: 'x',
    })
    expect(big.status).toBe(413)
    expect(await json(big)).toMatchObject({ code: 'payload_too_large', details: { maxBytes: 64 } })
    const bad = await createUploadRequest(env, cookie, 'uptest.receipt', text(), { note: 1 })
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ code: 'validation_failed' })
    const extra = await createUploadRequest(env, cookie, 'uptest.plain', text(), { anything: 1 })
    expect(extra.status).toBe(400)
    expect((await directUpload(env, cookie, 'uptest.plain', text())).status).toBe(200)
  })

  it('a key outside the tenant prefix is refused and nothing is recorded', async () => {
    const { cookie, tenant } = await actor()
    const env = createTestEnv()
    const res = await createUploadRequest(env, cookie, 'uptest.escape', text())
    expect(res.status).toBe(500)
    const rows = await db
      .select()
      .from(pendingUploads)
      .where(
        and(eq(pendingUploads.tenantId, tenant.id), eq(pendingUploads.target, 'uptest.escape'))
      )
    expect(rows).toEqual([])
  })
})

/**
 * `/api/uploads` — the upload flow itself, over the in-memory R2 bucket and the Worker's own
 * stand-in for R2's presigned `PUT` (what a Worker without the R2 key pair hands out). The targets' own rules are `files.test.ts` and
 * `document-upload.test.ts`; this file is what every target shares:
 *
 *   - presign: the signed R2 URL when the key pair is set (the four signed headers, no payload hash),
 *     the Worker's own URL without it — capped at `MAX_WORKER_UPLOAD_BYTES` once deployed — and
 *     401 without a session;
 *   - the Worker PUT holds the store's rules — token, type, length, expiry, write-once (two
 *     concurrent PUTs write once) — and is spent once the upload is confirmed;
 *   - confirm: a type or size other than the one declared is refused and the object deleted;
 *     another tenant's or another person's upload id is a 404; a second confirm is a 404; an
 *     expired upload is 410; confirming before the PUT is 400 `upload_missing` and can be retried;
 *     a target or bucket that is gone refuses before the claim, so the row is left unclaimed;
 *   - the nightly prune deletes an unconfirmed object, a confirmed core object no `files` row
 *     records, and the object of a person deleted mid-upload; it leaves a recorded one;
 *   - a plugin's target: its declared permission, its key under `tenants/<t>/<id>/` naming the
 *     upload, `prepare` then `confirm`, its `contentTypes` 415, no `fields` without a schema; no
 *     URL for a key that already holds an object.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { and, eq, isNotNull } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { prunePendingUploadsTask, SCHEDULED_TASKS } from '@/api/scheduled'
import {
  MAX_WORKER_UPLOAD_BYTES,
  prunePendingUploads,
  UPLOAD_CONFIRM_GRACE_SECONDS,
} from '@/api/services/uploads/service'
import { pendingUploads, users } from '@/db/schema'
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
import { json, request } from '../helpers/request'
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
  permission: { action: 'create', subject: 'File' },
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
  permission: { action: 'create', subject: 'File' },
  maxBytes: 64,
  async confirm() {
    return { status: 200, body: { ok: true } }
  },
}
const big: PluginUploadTarget = {
  id: 'uptest.big',
  permission: { action: 'create', subject: 'File' },
  maxBytes: 50 * 1024 * 1024,
  async confirm() {
    return { body: {} }
  },
}
/** A target answering whatever key `keyFor` builds — the key rule's test cases. */
let keyFor: (tenantId: string, uploadId: string) => string = () => ''
const keyed: PluginUploadTarget = {
  id: 'uptest.keyed',
  permission: { action: 'create', subject: 'File' },
  maxBytes: 64,
  async prepare(ctx, input) {
    return { key: keyFor(ctx.tenantId, input.uploadId) }
  },
  async confirm() {
    return { body: {} }
  },
}
/** Something is already stored at the key this target answers when it is presigned. */
let occupy: TestEnv | null = null
const occupied: PluginUploadTarget = {
  id: 'uptest.occupied',
  permission: { action: 'create', subject: 'File' },
  maxBytes: 64,
  async prepare(ctx, input) {
    const key = `tenants/${ctx.tenantId}/uptest/${input.uploadId}-${input.filename}`
    await occupy?.FILES?.put(key, 'already here')
    return { key }
  },
  async confirm() {
    return { body: {} }
  },
}
/** No `prepare`: the declared permission is the only gate — one a member does not hold. */
const adminsOnly: PluginUploadTarget = {
  id: 'uptest.admins',
  permission: { action: 'create', subject: 'Invitation' },
  maxBytes: 64,
  async confirm() {
    return { body: { ok: true } }
  },
}
withServerPlugins([
  {
    shared: { id: 'uptest' },
    uploadTargets: [receipts, plain, big, keyed, occupied, adminsOnly],
  },
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

/**
 * Put THIS tenant's uploads past their confirm window (and any claim past the grace), rather than
 * pruning at a future `now`: the prune is cross-tenant, and a future `now` would delete other
 * files' uploads in flight.
 */
async function backdate(tenantId: string) {
  const past = new Date(Date.now() - (UPLOAD_CONFIRM_GRACE_SECONDS + 60) * 1000)
  await db
    .update(pendingUploads)
    .set({ expiresAt: past })
    .where(eq(pendingUploads.tenantId, tenantId))
  await db
    .update(pendingUploads)
    .set({ confirmedAt: past })
    .where(and(eq(pendingUploads.tenantId, tenantId), isNotNull(pendingUploads.confirmedAt)))
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

  it('is spent once confirmed, even after the confirmed file is deleted', async () => {
    const { cookie } = await actor()
    const env = createTestEnv()
    const t = await ticket(env, cookie)
    expect((await putUpload(env, t, 'hello world')).status).toBe(200)
    const confirmedRes = await confirmUploadRequest(env, cookie, t.uploadId)
    expect(confirmedRes.status).toBe(201)
    const { id } = (await json(confirmedRes)) as { id: string }
    const key = (await pendingRow(t.uploadId))?.key ?? ''
    // The file is deleted, so its key is free again while the URL is still live.
    const deleted = await request(
      `/api/files/${id}`,
      { method: 'DELETE', headers: cookie },
      { env }
    )
    expect(deleted.status).toBeLessThan(300)
    expect(stubs(env).files.objects.has(key)).toBe(false)

    expect((await putUpload(env, t, 'HELLO WORLD')).status).toBe(403)
    expect(stubs(env).files.objects.has(key)).toBe(false)
  })

  it('two concurrent PUTs to one URL write once', async () => {
    const { cookie } = await actor()
    const env = createTestEnv()
    const t = await ticket(env, cookie)
    // Hold every write until both requests have reached theirs, so neither can see the other's
    // object first: only a write that is itself conditional refuses the second.
    const bucket = stubs(env).files
    const write = bucket.put.bind(bucket)
    let arrived = 0
    let release: () => void = () => {}
    const bothArrived = new Promise<void>(resolve => {
      release = resolve
    })
    bucket.put = async (...args: Parameters<typeof write>) => {
      if (++arrived === 2) release()
      await bothArrived
      return write(...args)
    }
    const statuses = await Promise.all([
      putUpload(env, t, 'hello world').then(r => r.status),
      putUpload(env, t, 'HELLO WORLD').then(r => r.status),
    ])
    expect(statuses.sort()).toEqual([200, 412])
    expect(bucket.objects.size).toBe(1)
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

describe('a confirm that cannot proceed', () => {
  it('a target or bucket that is gone refuses before the claim, so the row stays confirmable', async () => {
    const { cookie } = await actor()
    const env = createTestEnv()
    const t = await ticket(env, cookie)
    expect((await putUpload(env, t, 'hello world')).status).toBe(200)
    const key = (await pendingRow(t.uploadId))?.key ?? ''

    // A plugin since uninstalled: its target id no longer resolves.
    await db
      .update(pendingUploads)
      .set({ target: 'uptest.uninstalled' })
      .where(eq(pendingUploads.id, t.uploadId))
    const gone = await confirmUploadRequest(env, cookie, t.uploadId)
    expect(gone.status).toBe(400)
    expect(await json(gone)).toMatchObject({ code: ERROR_CODES.unknownUploadTarget })
    expect((await pendingRow(t.uploadId))?.confirmedAt).toBeNull()

    // A bucket since unbound.
    await db
      .update(pendingUploads)
      .set({ target: 'uploads', bucket: 'UNBOUND_BUCKET' })
      .where(eq(pendingUploads.id, t.uploadId))
    expect((await confirmUploadRequest(env, cookie, t.uploadId)).status).toBe(503)
    expect((await pendingRow(t.uploadId))?.confirmedAt).toBeNull()

    // Put right, the same upload confirms: nothing was left claimed.
    await db
      .update(pendingUploads)
      .set({ bucket: 'FILES' })
      .where(eq(pendingUploads.id, t.uploadId))
    expect((await confirmUploadRequest(env, cookie, t.uploadId)).status).toBe(201)
    expect(stubs(env).files.objects.has(key)).toBe(true)
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

    await backdate(tenant.id)
    await prunePendingUploads(db, env, new Date())

    expect(stubs(env).files.objects.has(abandonedKey)).toBe(false)
    expect(stubs(env).files.objects.has(keptKey)).toBe(true)
    const left = await db
      .select()
      .from(pendingUploads)
      .where(and(eq(pendingUploads.tenantId, tenant.id)))
    expect(left).toEqual([])
  })

  it("deletes a confirmed core object no files row records, and keeps a plugin's", async () => {
    const { cookie, tenant } = await actor()
    const env = createTestEnv()
    const t = await ticket(env, cookie)
    expect((await putUpload(env, t, 'hello world')).status).toBe(200)
    const confirmedRes = await confirmUploadRequest(env, cookie, t.uploadId)
    const { id } = (await json(confirmedRes)) as { id: string }
    const key = (await pendingRow(t.uploadId))?.key ?? ''
    await request(`/api/files/${id}`, { method: 'DELETE', headers: cookie }, { env })
    // Written again after the file's deletion, the way a still-live R2 URL would let it be.
    await env.FILES?.put(key, 'hello world', { httpMetadata: { contentType: 'text/plain' } })

    const pluginRes = await directUpload(env, cookie, 'uptest.receipt', text('a receipt'), {
      note: 'kept',
    })
    const pluginKey = ((await json(pluginRes)) as { key: string }).key

    await backdate(tenant.id)
    await prunePendingUploads(db, env, new Date())
    expect(stubs(env).files.objects.has(key)).toBe(false)
    expect(stubs(env).files.objects.has(pluginKey)).toBe(true)
  })

  it('deletes the object of a person deleted mid-upload: their row outlives them', async () => {
    const { cookie, tenant, user } = await actor()
    const env = createTestEnv()
    const t = await ticket(env, cookie)
    expect((await putUpload(env, t, 'hello world')).status).toBe(200)
    const key = (await pendingRow(t.uploadId))?.key ?? ''
    await db.delete(users).where(eq(users.id, user.id))
    expect((await pendingRow(t.uploadId))?.userId).toBeNull()

    await backdate(tenant.id)
    await prunePendingUploads(db, env, new Date())
    expect(stubs(env).files.objects.has(key)).toBe(false)
    expect(await pendingRow(t.uploadId)).toBeUndefined()
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

  it('refuses a member the declared permission, with or without a prepare', async () => {
    const member = await actor('member')
    const env = createTestEnv()
    const refused = await createUploadRequest(env, member.cookie, 'uptest.admins', text())
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ statusCode: 403 })
    const owner = await actor('owner')
    expect((await directUpload(env, owner.cookie, 'uptest.admins', text())).status).toBe(201)
  })

  it('a key outside its own prefix, or not naming the upload, is refused and nothing recorded', async () => {
    const { cookie, tenant } = await actor()
    const env = createTestEnv()
    const cases: [string, (t: string, u: string) => string][] = [
      ['another tenant', (_t, u) => `tenants/someone-else/uptest/${u}-x`],
      ["the tenant's prefix, not the plugin's", (t, u) => `tenants/${t}/uploads/${u}-x`],
      ["another plugin's prefix", (t, u) => `tenants/${t}/uptest-other/${u}-x`],
      ['no upload id', t => `tenants/${t}/uptest/fixed-name.txt`],
      ['a `..` segment', (t, u) => `tenants/${t}/uptest/../other/${u}-x`],
    ]
    for (const [label, build] of cases) {
      keyFor = build
      const res = await createUploadRequest(env, cookie, 'uptest.keyed', text())
      expect(res.status, label).toBe(500)
      expect(await json(res), label).toMatchObject({ code: ERROR_CODES.uploadKeyInvalid })
    }
    const rows = await db
      .select()
      .from(pendingUploads)
      .where(and(eq(pendingUploads.tenantId, tenant.id), eq(pendingUploads.target, 'uptest.keyed')))
    expect(rows).toEqual([])

    keyFor = (t, u) => `tenants/${t}/uptest/receipts/${u}.txt`
    expect((await createUploadRequest(env, cookie, 'uptest.keyed', text())).status).toBe(201)
  })

  it('no URL for a key that already holds an object, which is left as it was', async () => {
    const { cookie, tenant } = await actor()
    const env = createTestEnv()
    occupy = env
    const res = await createUploadRequest(env, cookie, 'uptest.occupied', text())
    occupy = null
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: ERROR_CODES.uploadKeyExists })
    const [object] = [...stubs(env).files.objects.values()]
    expect(new TextDecoder().decode(object?.body)).toBe('already here')
    const rows = await db
      .select()
      .from(pendingUploads)
      .where(
        and(eq(pendingUploads.tenantId, tenant.id), eq(pendingUploads.target, 'uptest.occupied'))
      )
    expect(rows).toEqual([])
  })
})

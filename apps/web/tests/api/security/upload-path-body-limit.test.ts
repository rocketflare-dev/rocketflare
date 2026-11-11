/**
 * Nothing under an upload prefix is uncapped: a JSON body there gets the same 1 MB cap as anywhere
 * else in `/api`, and any other body the largest upload cap the kit allows, while each upload
 * route's own tighter limit still applies to its file.
 */
import { MAX_UPLOAD_BYTES } from '@rocketflare/shared/files'
import { describe, expect, it } from 'vitest'
import { MAX_JSON_BODY_BYTES, MAX_UPLOAD_PATH_BODY_BYTES } from '@/api/middleware/body-limit'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()

async function memberCookie() {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  return sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
}

describe('body caps beneath an upload prefix', () => {
  it('a 2 MiB JSON body to a parameterised JSON route under the prefix is 413', async () => {
    const res = await request('/api/ai/documents/upload/visibility', {
      method: 'PUT',
      headers: { ...(await memberCookie()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'tenant', pad: 'x'.repeat(2 * 1024 * 1024) }),
    })
    expect(res.status).toBe(413)
    expect(await json(res)).toMatchObject({ statusCode: 413, code: 'payload_too_large' })
  })

  it('a JSON body just over 1 MB under the prefix is 413, before auth', async () => {
    const res = await request('/api/files/anything', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: 'x'.repeat(MAX_JSON_BODY_BYTES + 1),
    })
    expect(res.status).toBe(413)
  })

  it('a non-JSON body past the largest upload cap under the prefix is 413, before auth', async () => {
    const res = await request('/api/files/anything', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(MAX_UPLOAD_PATH_BODY_BYTES + 1),
    })
    expect(res.status).toBe(413)
    expect(await json(res)).toMatchObject({ code: 'payload_too_large' })
  })

  it('the document upload route still takes a file near its own limit', async () => {
    const form = new FormData()
    const bytes = new Uint8Array(MAX_UPLOAD_BYTES - 1024).fill(0x41)
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'large.pdf')
    const res = await request(
      '/api/ai/documents/upload',
      { method: 'POST', headers: await memberCookie(), body: form },
      { env: createTestEnv() }
    )
    expect(res.status).toBeLessThan(300)
  })

  it("the upload route's own tighter limit still refuses a file past it", async () => {
    const form = new FormData()
    const bytes = new Uint8Array(MAX_UPLOAD_BYTES + 128 * 1024).fill(0x41)
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'too-large.pdf')
    const res = await request(
      '/api/ai/documents/upload',
      { method: 'POST', headers: await memberCookie(), body: form },
      { env: createTestEnv() }
    )
    expect(res.status).toBe(413)
  })
})

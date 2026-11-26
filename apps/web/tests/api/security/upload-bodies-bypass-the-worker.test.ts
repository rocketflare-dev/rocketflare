/**
 * No authed `/api/*` path takes a body above the 1 MB cap any more — the old multipart paths
 * included, which once let 10 MB + 64 KB through. The one larger door is the Worker's own upload
 * URL (what it hands out without the R2 key pair): the largest target's `maxBytes` in
 * `development`, `MAX_WORKER_UPLOAD_BYTES` deployed.
 */
import { describe, expect, it } from 'vitest'
import { MAX_JSON_BODY_BYTES } from '@/api/middleware/body-limit'
import { MAX_WORKER_UPLOAD_BYTES } from '@/api/services/uploads/service'
import { uploadTargets } from '@/api/services/uploads/targets'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()

describe('upload bodies never pass through the Worker', () => {
  it('the former multipart paths refuse a body above the JSON cap with 413', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const body = new Uint8Array(MAX_JSON_BODY_BYTES + 1)
    for (const path of ['/api/files?scope=avatars', '/api/ai/documents/upload', '/api/uploads']) {
      const res = await request(
        path,
        {
          method: 'POST',
          headers: {
            ...cookie,
            'Content-Type': 'multipart/form-data; boundary=x',
            'Content-Length': String(body.byteLength),
          },
          body,
        },
        { env: createTestEnv() }
      )
      expect(res.status, path).toBe(413)
      expect(await json(res)).toMatchObject({ statusCode: 413, code: 'payload_too_large' })
    }
  })

  it('the Worker upload URL refuses more than the largest target in development, and than MAX_WORKER_UPLOAD_BYTES deployed', async () => {
    const largest = Math.max(...[...uploadTargets().values()].map(t => t.maxBytes))
    const body = new Uint8Array(largest + 1)
    const res = await request(
      `/api/upload-content/${crypto.randomUUID()}?token=x`,
      { method: 'PUT', headers: { 'Content-Length': String(body.byteLength) }, body },
      { env: createTestEnv() }
    )
    expect(res.status).toBe(413)

    const deployedCap = Math.min(largest, MAX_WORKER_UPLOAD_BYTES)
    const over = new Uint8Array(deployedCap + 1)
    const deployed = await request(
      `/api/upload-content/${crypto.randomUUID()}?token=x`,
      { method: 'PUT', headers: { 'Content-Length': String(over.byteLength) }, body: over },
      { env: createTestEnv({ APP_ENV: 'staging' }) }
    )
    expect(deployed.status).toBe(413)
  })
})

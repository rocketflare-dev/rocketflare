/**
 * The connection test's verdict is a sentence built from the failure's status. Whatever the
 * upstream answered with stays out of it.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const BODY = 'UPSTREAM-PAGE-TEXT from the configured host'
let server: Server
let endpoint: string
let status = 405

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(BODY)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
})

async function probe(code: number) {
  status = code
  const env = createTestEnv()
  const { user, tenant } = await createTestTenantWithUser(db, 'admin')
  const headers = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  const res = await request(
    '/api/ai/config/test',
    { method: 'POST', headers },
    {
      env,
      json: {
        provider: 'openai_compatible',
        baseUrl: endpoint,
        model: 'probe-model',
        apiKey: 'test-key',
      },
    }
  )
  expect(res.status).toBe(200)
  return json<{ ok: boolean; error?: string; code?: string }>(res)
}

describe('POST /api/ai/config/test verdict', () => {
  it.each([405, 402, 418])('an unmapped %i answers without the upstream body', async code => {
    const verdict = await probe(code)
    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBe('unknown')
    expect(verdict.error).toMatch(/provider/i)
    expect(verdict.error).toContain(String(code))
    expect(verdict.error).not.toContain('UPSTREAM-PAGE-TEXT')
  })

  it('a mapped status keeps its specific sentence', async () => {
    const verdict = await probe(401)
    expect(verdict.code).toBe('auth')
    expect(verdict.error).not.toContain('UPSTREAM-PAGE-TEXT')
  })
})

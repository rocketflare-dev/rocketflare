/**
 * A stored provider key belongs to the provider AND the endpoint it was entered for. Re-saving a
 * row with a different endpoint needs the key again; the stored one is never sent to the new host.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { aiConfigSchema } from '@rocketflare/shared/ai/config'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { aiConfigs } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const received: string[] = []
let server: Server
let endpoint: string

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push(`${req.headers.authorization ?? ''}|${req.headers['x-api-key'] ?? ''}`)
    req.resume()
    req.on('end', () => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/alt`
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
})

const KEY = 'test-stored-provider-key'

async function savedRow(row: { provider: string; scope: string; baseUrl?: string; model: string }) {
  const env = createTestEnv()
  const { user: owner, tenant } = await createTestTenantWithUser(db, 'owner')
  const admin = await createTestUser(db)
  await linkUserToTenant(db, admin.id, tenant.id, 'admin')
  const ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenant.id))
  const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id, tenant.id))
  const body = { ...row, label: `${row.provider}-${row.scope}` }
  const saved = await request(
    '/api/ai/config',
    { method: 'POST', headers: ownerCookie },
    { env, json: { ...body, apiKey: KEY } }
  )
  expect(saved.status).toBe(201)
  const { id } = aiConfigSchema.parse(await json(saved))
  const [before] = await db.select().from(aiConfigs).where(eq(aiConfigs.id, id))
  const save = (over: Record<string, unknown>) =>
    request(
      '/api/ai/config',
      { method: 'POST', headers: adminCookie },
      { env, json: { ...body, ...over } }
    )
  const test = () =>
    request(
      '/api/ai/config/test',
      { method: 'POST', headers: adminCookie },
      { env, json: { configId: id } }
    )
  const current = async () => (await db.select().from(aiConfigs).where(eq(aiConfigs.id, id)))[0]
  return { id, before, save, test, current }
}

const COMPATIBLE = {
  provider: 'openai_compatible',
  scope: 'chat',
  baseUrl: 'https://vendor.example/v1',
  model: 'some-model',
}

describe('re-saving an AI config without a key', () => {
  it.each([
    COMPATIBLE,
    { provider: 'anthropic', scope: 'chat', model: 'claude-sonnet-4-5' },
    { provider: 'openai', scope: 'embeddings', model: 'text-embedding-3-small' },
    { provider: 'typesafe', scope: 'decisions', model: 'jev-latest' },
  ])('$provider/$scope: a new endpoint needs the key again', async row => {
    const { save, test, current, before } = await savedRow(row)
    const res = await save({ baseUrl: endpoint })
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'api_key_required' })
    expect(await current()).toMatchObject({
      baseUrl: before?.baseUrl ?? null,
      apiKeyEnc: before?.apiKeyEnc,
    })
    const count = received.length
    await test()
    expect(received.slice(count).filter(h => h.includes(KEY))).toEqual([])
  })

  it('keeps the key while the endpoint is unchanged, trailing slash and host case aside', async () => {
    const { save, current, before } = await savedRow(COMPATIBLE)
    expect((await save({ model: 'other-model' })).status).toBe(200)
    expect((await save({ baseUrl: 'https://VENDOR.example/v1/' })).status).toBe(200)
    expect((await current())?.apiKeyEnc).toBe(before?.apiKeyEnc)
  })

  it('takes a new endpoint together with a new key', async () => {
    const { save, current, before } = await savedRow(COMPATIBLE)
    const res = await save({ baseUrl: endpoint, apiKey: 'test-replacement-key' })
    expect(res.status).toBe(200)
    const row = await current()
    expect(row?.baseUrl).toBe(endpoint)
    expect(row?.apiKeyEnc).not.toBe(before?.apiKeyEnc)
  })

  it('clears the stored key when a provider that does not need one changes endpoint', async () => {
    const { save, current, before } = await savedRow({
      provider: 'workers_ai',
      scope: 'embeddings',
      model: '@cf/baai/bge-m3',
    })
    expect(before?.apiKeyEnc).toBeTruthy()
    expect((await save({ baseUrl: endpoint })).status).toBe(200)
    expect((await current())?.apiKeyEnc).toBeNull()
  })
})

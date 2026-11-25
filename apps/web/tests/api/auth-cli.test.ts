/**
 * `GET /auth/cli`: loopback-only redirect_uri and the login/select-tenant redirects;
 * `POST /auth/cli/confirm`: key minting and the hand-off URL.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, inject, it } from 'vitest'
import { validateCliRedirectUri } from '@/api/routes/auth/cli'
import { API_KEY_PREFIX_LENGTH } from '@/api/utils/core/hash'
import { apiKeys } from '@/db/schema'
import {
  bearerHeader,
  createTestSession,
  createTestUser,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()
const seed = inject('seed')
const GOOD = 'http://127.0.0.1:53211/callback'

describe('validateCliRedirectUri', () => {
  it.each([
    ['http://127.0.0.1:53211/callback', true],
    ['http://localhost:8000/callback', true],
    ['http://localhost/callback', true],
    ['https://127.0.0.1:1/callback', false],
    ['http://127.0.0.1:1/other', false],
    ['http://127.0.0.1:1/callback?x=1', false],
    ['http://evil.example/callback', false],
    ['http://127.0.0.1.evil.example/callback', false],
    ['rocketflare://callback', false],
    ['not a url', false],
    ['', false],
  ])('%s → %s', (uri, ok) => {
    expect(validateCliRedirectUri(uri) !== null).toBe(ok)
  })
})

describe('GET /auth/cli', () => {
  it('400 invalid_redirect_uri for a non-loopback target and when missing', async () => {
    const res = await request(
      `/auth/cli?redirect_uri=${encodeURIComponent('https://evil.example/callback')}`
    )
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ statusCode: 400, code: 'invalid_redirect_uri' })
    expect((await request('/auth/cli')).status).toBe(400)
  })

  it('no session → 302 /login?returnUrl=/auth/cli?redirect_uri=…', async () => {
    const res = await request(`/auth/cli?redirect_uri=${encodeURIComponent(GOOD)}`)
    expect(res.status).toBe(302)
    const target = new URL(res.headers.get('location') as string, 'http://localhost:3001')
    expect(target.pathname).toBe('/login')
    const returnUrl = new URL(
      target.searchParams.get('returnUrl') as string,
      'http://localhost:3001'
    )
    expect(returnUrl.pathname).toBe('/auth/cli')
    expect(returnUrl.searchParams.get('redirect_uri')).toBe(GOOD)
  })

  it('session without a tenant → 302 /select-tenant?returnUrl=…', async () => {
    const user = await createTestUser(db)
    const token = await createTestSession(db, user.id)
    const res = await request(`/auth/cli?redirect_uri=${encodeURIComponent(GOOD)}`, {
      headers: sessionCookieHeader(token),
    })
    expect(res.status).toBe(302)
    const target = new URL(res.headers.get('location') as string, 'http://localhost:3001')
    expect(target.pathname).toBe('/select-tenant')
    expect(target.searchParams.get('returnUrl')).toContain('/auth/cli?redirect_uri=')
  })

  it('with a session and a tenant → 302 /cli/confirm, carrying the query along', async () => {
    const res = await request(
      `/auth/cli?redirect_uri=${encodeURIComponent(GOOD)}&hostname=My-Laptop.local`,
      { headers: sessionCookieHeader(seed.sessionToken) }
    )
    expect(res.status).toBe(302)
    const target = new URL(res.headers.get('location') as string, 'http://localhost:3001')
    expect(target.pathname).toBe('/cli/confirm')
    expect(target.searchParams.get('redirect_uri')).toBe(GOOD)
    expect(target.searchParams.get('hostname')).toBe('My-Laptop.local')
  })
})

describe('POST /auth/cli/confirm', () => {
  const confirm = (body: unknown) =>
    request(
      '/auth/cli/confirm',
      { method: 'POST', headers: sessionCookieHeader(seed.sessionToken) },
      { json: body }
    )

  it('mints a cli:<hostname> key with scopes [*] and answers the URL with key, tenant_id, tenant_name', async () => {
    const res = await confirm({ redirectUri: GOOD, hostname: 'My-Laptop.local' })
    expect(res.status).toBe(200)
    const target = new URL((await json<{ redirectTo: string }>(res)).redirectTo)
    expect(`${target.origin}${target.pathname}`).toBe(GOOD)
    const key = target.searchParams.get('key') as string
    expect(key).toMatch(/^rocketflare_/)
    expect(target.searchParams.get('tenant_id')).toBe(seed.tenant.id)
    expect(target.searchParams.get('tenant_name')).toBe(seed.tenant.name)

    const [row] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyPrefix, key.slice(0, API_KEY_PREFIX_LENGTH)))
    expect(row).toMatchObject({
      name: 'cli:my-laptop.local',
      scopes: ['*'],
      tenantId: seed.tenant.id,
    })
    expect(row?.keyHash).not.toBe(key)

    // the minted key works as a Bearer credential
    const me = await request('/api/tenant', { headers: bearerHeader(key) })
    expect(me.status).toBe(200)
    expect(await json(me)).toMatchObject({ id: seed.tenant.id })
  })

  it('defaults the key name to cli:cli without a hostname', async () => {
    const res = await confirm({ redirectUri: 'http://localhost:4242/callback' })
    const key = new URL((await json<{ redirectTo: string }>(res)).redirectTo).searchParams.get(
      'key'
    ) as string
    const [row] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyPrefix, key.slice(0, API_KEY_PREFIX_LENGTH)))
    expect(row?.name).toBe('cli:cli')
  })
})

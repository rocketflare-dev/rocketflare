/**
 * CLI sign-in: the GET only leads to the confirmation page and never creates a credential, whatever
 * the request looks like; the key is minted by the confirming POST, which the cross-site checks
 * guard and whose answer carries the loopback target.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { apiKeys } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const APP = 'https://app.example'
const LOOPBACK = 'http://127.0.0.1:53682/callback'
const STATE = 'state-value-from-the-cli-0123456789'
const env = () => createTestEnv({ APP_ENV: 'production', APP_URL: APP })

async function member() {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const token = await createTestSession(db, user.id, tenant.id)
  return { user, tenant, cookie: sessionCookieHeader(token) }
}

const keysOf = (tenantId: string) =>
  db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId)))

const cliUrl = (extra = '') =>
  `/auth/cli?redirect_uri=${encodeURIComponent(LOOPBACK)}&hostname=laptop&state=${STATE}${extra}`

describe('CLI sign-in confirmation', () => {
  it.each([
    ['a plain navigation', {}],
    [
      'a cross-site navigation',
      {
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        Referer: 'https://other.example/',
      },
    ],
    [
      'a same-origin image load',
      { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' },
    ],
  ])('GET after %s redirects to the confirmation page and creates no key', async (_, headers) => {
    const { tenant, cookie } = await member()
    const res = await request(cliUrl(), { headers: { ...cookie, ...headers } }, { env: env() })
    expect(res.status).toBe(302)
    const target = new URL(res.headers.get('location') as string, APP)
    expect(target.origin).toBe(APP)
    expect(target.pathname).toBe('/cli/confirm')
    expect(target.searchParams.get('redirect_uri')).toBe(LOOPBACK)
    expect(target.searchParams.get('hostname')).toBe('laptop')
    expect(target.searchParams.get('state')).toBe(STATE)
    expect(res.headers.get('location')).not.toContain('key=')
    expect(await keysOf(tenant.id)).toHaveLength(0)
  })

  it('a signed-out GET keeps state and hostname through the login redirect', async () => {
    const res = await request(cliUrl(), {}, { env: env() })
    const target = new URL(res.headers.get('location') as string, APP)
    const back = new URL(target.searchParams.get('returnUrl') as string, APP)
    expect(back.pathname).toBe('/auth/cli')
    expect(back.searchParams.get('state')).toBe(STATE)
    expect(back.searchParams.get('hostname')).toBe('laptop')
  })

  it('POST /auth/cli/confirm mints the key and answers the loopback target', async () => {
    const { tenant, cookie } = await member()
    const res = await request(
      '/auth/cli/confirm',
      { method: 'POST', headers: { ...cookie, Origin: APP, 'Sec-Fetch-Site': 'same-origin' } },
      { env: env(), json: { redirectUri: LOOPBACK, hostname: 'laptop', state: STATE } }
    )
    expect(res.status).toBe(200)
    const body = await json<{ redirectTo: string }>(res)
    const target = new URL(body.redirectTo)
    expect(`${target.origin}${target.pathname}`).toBe(LOOPBACK)
    expect(target.searchParams.get('state')).toBe(STATE)
    expect(target.searchParams.get('tenant_id')).toBe(tenant.id)
    expect(target.searchParams.get('key')).toBeTruthy()
    const keys = await keysOf(tenant.id)
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ name: 'cli:laptop', scopes: ['*'] })
  })

  it('a cross-site POST is refused and creates no key', async () => {
    const { tenant, cookie } = await member()
    const res = await request(
      '/auth/cli/confirm',
      {
        method: 'POST',
        headers: { ...cookie, Origin: 'https://other.example', 'Sec-Fetch-Site': 'cross-site' },
      },
      { env: env(), json: { redirectUri: LOOPBACK } }
    )
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: 'csrf_failed' })
    expect(await keysOf(tenant.id)).toHaveLength(0)
  })

  it('POST without a session is 401 and a non-loopback target is 400', async () => {
    const unauthenticated = await request(
      '/auth/cli/confirm',
      { method: 'POST', headers: { Origin: APP } },
      { env: env(), json: { redirectUri: LOOPBACK } }
    )
    expect(unauthenticated.status).toBe(401)
    const { tenant, cookie } = await member()
    const res = await request(
      '/auth/cli/confirm',
      { method: 'POST', headers: { ...cookie, Origin: APP } },
      { env: env(), json: { redirectUri: 'https://other.example/callback' } }
    )
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'invalid_redirect_uri' })
    expect(await keysOf(tenant.id)).toHaveLength(0)
  })

  it('an over-long state is refused', async () => {
    const { cookie } = await member()
    const res = await request(
      '/auth/cli/confirm',
      { method: 'POST', headers: { ...cookie, Origin: APP } },
      { env: env(), json: { redirectUri: LOOPBACK, state: 'x'.repeat(600) } }
    )
    expect(res.status).toBe(400)
  })
})

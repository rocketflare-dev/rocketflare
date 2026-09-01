/**
 * `GET /ws` upgrade auth (D8, D12): 426 without `Upgrade: websocket`, 401 without a cookie, 403 for
 * a tenant the user is not a member of, and the happy path forwards the upgrade to the per-tenant
 * DO stub with the identity headers (the stub's `fetch` answers 501, which passes straight through).
 */
import { describe, expect, it, vi } from 'vitest'
import { HUB_HEADERS } from '@/api/durable-objects/notifications-hub'
import { UPGRADE_REQUIRED_CODE } from '@/api/routes/ws'
import {
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const UPGRADE = { Upgrade: 'websocket', Connection: 'Upgrade' }

/** Capture what the route forwarded to the DO without changing the bindings mock. */
function spyHub(env: ReturnType<typeof createTestEnv>) {
  const hub = stubs(env).hub
  const forwarded: { idName: string; request: Request }[] = []
  const realGet = hub.get.bind(hub)
  vi.spyOn(hub, 'get').mockImplementation((id: { name: string }) => {
    const stub = realGet(id)
    return new Proxy(stub, {
      get: (target, prop: string) =>
        prop === 'fetch'
          ? async (input: Request | string, init?: RequestInit) => {
              const req = input instanceof Request ? input : new Request(input, init)
              forwarded.push({ idName: id.name, request: req })
              return (target.fetch as () => Promise<Response>)()
            }
          : target[prop],
    })
  })
  return forwarded
}

async function memberWithCookie() {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const token = await createTestSession(db, user.id, tenant.id)
  return { user, tenant, cookie: sessionCookieHeader(token) }
}

describe('GET /ws', () => {
  it('426 envelope when the request is not a WebSocket upgrade', async () => {
    const { cookie } = await memberWithCookie()
    const res = await request('/ws', { headers: cookie })
    expect(res.status).toBe(426)
    expect(await json(res)).toMatchObject({ statusCode: 426, code: UPGRADE_REQUIRED_CODE })
  })

  it('401 envelope without a session cookie', async () => {
    const res = await request('/ws', { headers: UPGRADE })
    expect(res.status).toBe(401)
    expect(await json(res)).toMatchObject({ statusCode: 401, code: 'unauthorized' })
  })

  it('403 for a tenant the user does not belong to', async () => {
    const { cookie } = await memberWithCookie()
    const other = await createTestTenant(db)
    const env = createTestEnv()
    const forwarded = spyHub(env)
    const res = await request(
      `/ws?tenantId=${other.id}`,
      { headers: { ...cookie, ...UPGRADE } },
      { env }
    )
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    expect(forwarded).toHaveLength(0)
  })

  it('forwards the upgrade to idFromName(tenantId) with the identity headers', async () => {
    const { user, tenant, cookie } = await memberWithCookie()
    const env = createTestEnv()
    const forwarded = spyHub(env)
    const res = await request(
      `/ws?tenantId=${tenant.id}`,
      { headers: { ...cookie, ...UPGRADE } },
      { env }
    )
    // The bindings stub answers 501 — reaching it IS the assertion; a real DO answers 101.
    expect(res.status).toBe(501)
    expect(forwarded).toHaveLength(1)
    const [{ idName, request: req }] = forwarded
    expect(idName).toBe(tenant.id)
    expect(req.headers.get('Upgrade')).toBe('websocket')
    expect(req.headers.get(HUB_HEADERS.tenantId)).toBe(tenant.id)
    expect(req.headers.get(HUB_HEADERS.userId)).toBe(user.id)
    expect(req.headers.get(HUB_HEADERS.sessionId)).toMatch(/^[0-9a-f-]{36}$/)
    expect(req.headers.get('Cookie')).toBeNull()
  })

  it('falls back to the session tenant when ?tenantId is omitted', async () => {
    const { tenant, cookie } = await memberWithCookie()
    const env = createTestEnv()
    const forwarded = spyHub(env)
    const res = await request('/ws', { headers: { ...cookie, ...UPGRADE } }, { env })
    expect(res.status).toBe(501)
    expect(forwarded[0]?.idName).toBe(tenant.id)
  })
})

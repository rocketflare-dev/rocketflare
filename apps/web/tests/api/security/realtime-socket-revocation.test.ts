// @vitest-isolate
// Stubs the WebSocketPair / WebSocketRequestResponsePair / Response globals around the hub.
/**
 * A socket the hub admitted is closed when the membership or session that admitted it goes away:
 * removal from the tenant, sign-out, a block, a suspension, and the identity provider's own
 * removals. Drives the real routes and the real `NotificationsHub`; only the 101 primitives
 * (`WebSocketPair`, the Response) are stand-ins, since Node cannot carry a 101.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NotificationsHub } from '@/api/durable-objects/notifications-hub'
import { applyIdentityEvent } from '@/api/services/idp-tenancy'
import type { Realtime } from '@/api/services/realtime'
import { loadConfig } from '@/config'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const APP = 'https://app.example'
const UPGRADE = { Upgrade: 'websocket', Connection: 'Upgrade' }

interface FakeSocket {
  tags: string[]
  attachment: unknown
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  serializeAttachment: ReturnType<typeof vi.fn>
  deserializeAttachment: () => unknown
}

function fakeSocket(): FakeSocket {
  const s: FakeSocket = {
    tags: [],
    attachment: undefined,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => s.attachment,
  }
  s.serializeAttachment.mockImplementation((a: unknown) => {
    s.attachment = a
  })
  return s
}

/** One real hub per tenant behind a namespace shaped like the binding. */
function realHubs() {
  const byTenant = new Map<string, { instance: NotificationsHub; sockets: FakeSocket[] }>()
  const hubFor = (tenantId: string) => {
    const existing = byTenant.get(tenantId)
    if (existing) return existing
    const sockets: FakeSocket[] = []
    const ctx = {
      setWebSocketAutoResponse: vi.fn(),
      acceptWebSocket: (ws: FakeSocket, tags: string[]) => {
        ws.tags = tags
        sockets.push(ws)
      },
      getWebSockets: (tag?: string) =>
        tag ? sockets.filter(s => s.tags.includes(tag)) : [...sockets],
    }
    const instance = new NotificationsHub(
      ctx as unknown as DurableObjectState,
      createTestEnv() as unknown as Cloudflare.Env
    )
    const created = { instance, sockets }
    byTenant.set(tenantId, created)
    return created
  }
  const hubFetch = async (instance: NotificationsHub, req: Request) => {
    const RealResponse = globalThis.Response
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = fakeSocket()
        1 = fakeSocket()
      }
    )
    vi.stubGlobal(
      'Response',
      class {
        status: number
        constructor(_body: unknown, init: { status: number }) {
          this.status = init.status
        }
      }
    )
    let status: number
    try {
      status = (await instance.fetch(req)).status
    } finally {
      vi.stubGlobal('Response', RealResponse)
    }
    return new RealResponse(String(status), { status: 200 })
  }
  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => {
      const { instance } = hubFor(id.name)
      return new Proxy(instance as unknown as Record<string, unknown>, {
        get: (target, prop: string) => {
          if (prop === 'fetch') return (req: Request) => hubFetch(instance, req)
          const value = target[prop]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
  return { namespace, socketsOf: (tenantId: string) => hubFor(tenantId).sockets }
}

async function setup() {
  const hubs = realHubs()
  const env = createTestEnv({
    APP_ENV: 'production',
    APP_URL: APP,
    NOTIFICATIONS_HUB: hubs.namespace as unknown as Cloudflare.Env['NOTIFICATIONS_HUB'],
  })
  const { user: owner, tenant } = await createTestTenantWithUser(db, 'owner')
  const member = await createTestUser(db)
  await linkUserToTenant(db, member.id, tenant.id, 'member')
  const ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenant.id))
  const memberCookie = sessionCookieHeader(await createTestSession(db, member.id, tenant.id))
  const open = await request(
    `/ws?tenantId=${tenant.id}`,
    { headers: { ...memberCookie, ...UPGRADE } },
    { env }
  )
  expect(await open.text()).toBe('101')
  const socket = hubs.socketsOf(tenant.id)[0] as FakeSocket
  return { hubs, env, tenant, owner, member, ownerCookie, memberCookie, socket }
}

const withOrigin = (cookie: Record<string, string>) => ({ ...cookie, Origin: APP })

beforeAll(() => {
  vi.stubGlobal(
    'WebSocketRequestResponsePair',
    class {
      constructor(
        public request: string,
        public response: string
      ) {}
    }
  )
})
afterAll(() => vi.unstubAllGlobals())

describe('sockets are closed on revocation', () => {
  it('stays open while the member stays a member', async () => {
    const { env, ownerCookie, socket } = await setup()
    const res = await request(
      '/api/tenant',
      { method: 'PATCH', headers: withOrigin(ownerCookie) },
      { env, json: { name: `Renamed ${Date.now()}` } }
    )
    expect(res.status).toBe(200)
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('member removal closes that member socket', async () => {
    const { env, member, ownerCookie, socket } = await setup()
    const removed = await request(
      `/api/members/${member.id}`,
      { method: 'DELETE', headers: withOrigin(ownerCookie) },
      { env }
    )
    expect(removed.status).toBeLessThan(300)
    expect(socket.close).toHaveBeenCalled()
  })

  it('sign-out closes that session socket, not another session of the same person', async () => {
    const { env, memberCookie, tenant, member, socket, hubs } = await setup()
    const otherCookie = sessionCookieHeader(await createTestSession(db, member.id, tenant.id))
    await request(`/ws?tenantId=${tenant.id}`, { headers: { ...otherCookie, ...UPGRADE } }, { env })
    const other = hubs.socketsOf(tenant.id)[1] as FakeSocket
    const out = await request(
      '/auth/logout',
      { method: 'POST', headers: withOrigin(memberCookie) },
      { env }
    )
    expect(out.status).toBe(204)
    expect(socket.close).toHaveBeenCalled()
    expect(other.close).not.toHaveBeenCalled()
  })

  it('blocking a person closes their sockets in every tenant', async () => {
    const { env, member, socket, hubs } = await setup()
    const { tenant: second } = await createTestTenantWithUser(db, 'owner')
    await linkUserToTenant(db, member.id, second.id, 'member')
    const memberCookie2 = sessionCookieHeader(await createTestSession(db, member.id, second.id))
    await request(
      `/ws?tenantId=${second.id}`,
      { headers: { ...memberCookie2, ...UPGRADE } },
      { env }
    )
    const socket2 = hubs.socketsOf(second.id)[0] as FakeSocket
    const admin = await createTestUser(db, { isGlobalAdmin: true })
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id))
    const res = await request(
      `/api/admin/users/${member.id}/block`,
      { method: 'POST', headers: withOrigin(adminCookie) },
      { env, json: { blocked: true } }
    )
    expect(res.status).toBe(200)
    expect(socket.close).toHaveBeenCalled()
    expect(socket2.close).toHaveBeenCalled()
  })

  it('suspending a tenant closes every socket in it', async () => {
    const { env, tenant, socket } = await setup()
    const admin = await createTestUser(db, { isGlobalAdmin: true })
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id))
    const res = await request(
      `/api/admin/tenants/${tenant.id}/suspend`,
      { method: 'POST', headers: withOrigin(adminCookie) },
      { env, json: { suspended: true } }
    )
    expect(res.status).toBe(200)
    expect(socket.close).toHaveBeenCalled()
  })

  it('an identity-provider person suspension closes that person sockets', async () => {
    const { env, member, socket } = await setup()
    const cfg = loadConfig(
      createTestEnv({
        OIDC_MANAGED_TENANCY: 'true',
        OIDC_ISSUER: 'https://issuer.example/realms/test',
        OIDC_CLIENT_ID: 'test-client',
      })
    ) as never
    const realtime: Realtime = { defer: work => void work(), env }
    await applyIdentityEvent(
      db,
      cfg,
      {
        id: uniqueId(),
        type: 'person.suspended',
        occurredAt: new Date().toISOString(),
        data: { email: member.email },
      } as never,
      realtime
    )
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalled())
  })
})

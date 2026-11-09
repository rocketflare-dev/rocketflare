/**
 * The WebSocket handshake carries the session cookie, so its `Origin` is checked against the
 * same allowlist as CORS and CSRF. A client that sends no `Origin` (not a browser) is unaffected.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv, stubs } from '../../mocks/bindings'

const db = setupTestDatabase()
const APP = 'https://app.example'
const UPGRADE = { Upgrade: 'websocket', Connection: 'Upgrade' }

async function setup() {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  const env = createTestEnv({ APP_ENV: 'production', APP_URL: APP })
  const hub = vi.spyOn(stubs(env).hub, 'get')
  return { tenant, cookie, env, hub }
}

describe('GET /ws origin check', () => {
  it.each(['https://sibling.app.example', 'https://other.example', 'null'])(
    'a handshake from %s is refused before it reaches the hub',
    async origin => {
      const { tenant, cookie, env, hub } = await setup()
      const res = await request(
        `/ws?tenantId=${tenant.id}`,
        { headers: { ...cookie, ...UPGRADE, Origin: origin } },
        { env }
      )
      expect(res.status).toBe(403)
      expect(await json(res)).toMatchObject({ code: 'csrf_failed' })
      expect(hub).not.toHaveBeenCalled()
    }
  )

  it('a handshake from the app origin reaches the hub', async () => {
    const { tenant, cookie, env, hub } = await setup()
    await request(
      `/ws?tenantId=${tenant.id}`,
      { headers: { ...cookie, ...UPGRADE, Origin: APP } },
      { env }
    )
    expect(hub).toHaveBeenCalled()
  })

  it('a handshake with no Origin header reaches the hub', async () => {
    const { tenant, cookie, env, hub } = await setup()
    await request(`/ws?tenantId=${tenant.id}`, { headers: { ...cookie, ...UPGRADE } }, { env })
    expect(hub).toHaveBeenCalled()
  })
})

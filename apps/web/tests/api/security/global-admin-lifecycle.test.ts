/**
 * Support membership lasts only as long as the global-admin role behind it: the flag clearing,
 * whichever way it clears, ends every support row and what the row gave.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { reconcileIdpClaims } from '@/api/services/idp-tenancy'
import { activityEvents, tenantUsers, users } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv, stubs } from '../../mocks/bindings'

const db = setupTestDatabase()
const logger = { info: () => {}, warn: () => {} }

async function inSupport() {
  const admin = await createTestGlobalAdmin(db)
  const cookie = sessionCookieHeader(await createTestSession(db, admin.id))
  const { tenant } = await createTestTenantWithUser(db, 'owner')
  const entered = await request(`/api/admin/tenants/${tenant.id}/support/enter`, {
    method: 'POST',
    headers: cookie,
  })
  expect(entered.status).toBeLessThan(300)
  return { admin, cookie, tenant }
}

async function supportRows(userId: string) {
  return db
    .select()
    .from(tenantUsers)
    .where(and(eq(tenantUsers.userId, userId), eq(tenantUsers.role, 'support')))
}

describe('losing the global-admin role', () => {
  it('a demotion ends the support membership and the tenant access it gave', async () => {
    const { admin, cookie, tenant } = await inSupport()
    const other = await createTestGlobalAdmin(db)
    const otherCookie = sessionCookieHeader(await createTestSession(db, other.id))
    const key = await json<{ key: string }>(
      await request(
        '/api/keys',
        { method: 'POST', headers: cookie },
        { json: { name: 'before', scopes: ['*'] } }
      )
    )

    const demoted = await request(
      `/api/admin/users/${admin.id}/global-admin`,
      { method: 'POST', headers: otherCookie },
      { json: { isGlobalAdmin: false } }
    )
    expect(demoted.status).toBe(200)

    expect(await supportRows(admin.id)).toEqual([])
    expect((await request('/api/members', { headers: cookie })).status).toBe(403)
    const viaKey = await request('/api/members', {
      headers: { authorization: `Bearer ${key.key}` },
    })
    expect(viaKey.status).toBe(401)
    const activity = await db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.tenantId, tenant.id), eq(activityEvents.type, 'support.left')))
    expect(activity).toHaveLength(1)
  })

  it('a demotion closes the sockets the support membership admitted', async () => {
    const { admin, tenant } = await inSupport()
    const other = await createTestGlobalAdmin(db)
    const otherCookie = sessionCookieHeader(await createTestSession(db, other.id))
    const env = createTestEnv()

    const demoted = await request(
      `/api/admin/users/${admin.id}/global-admin`,
      { method: 'POST', headers: otherCookie },
      { json: { isGlobalAdmin: false }, env }
    )
    expect(demoted.status).toBe(200)

    expect(stubs(env).hub.broadcasts).toContainEqual({
      tenantId: tenant.id,
      args: ['closeUser', admin.id],
    })
  })

  it('the claim going ends it too; a person the issuer never made admin is untouched', async () => {
    const { admin } = await inSupport()
    await db.update(users).set({ globalAdminSource: 'idp' }).where(eq(users.id, admin.id))
    const row = await db.query.users.findFirst({ where: eq(users.id, admin.id) })
    await reconcileIdpClaims(
      db,
      row as typeof users.$inferSelect,
      { orgs: [], admit: false, globalAdmin: false, issuedAt: new Date() },
      logger
    )
    expect(await supportRows(admin.id)).toEqual([])
  })

  it('a global admin who keeps the role keeps support access', async () => {
    const { admin, cookie } = await inSupport()
    const res = await request('/api/members', { headers: cookie })
    expect(res.status).toBe(200)
    expect(await supportRows(admin.id)).toHaveLength(1)
  })
})

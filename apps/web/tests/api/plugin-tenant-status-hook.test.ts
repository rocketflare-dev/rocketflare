// @vitest-isolate
// Mocks the server plugin barrel to install a recording plugin, so this file needs its own module registry.
/**
 * `hooks.onTenantStatusChanged`: suspending or reactivating a tenant runs every plugin's hook
 * after the status has changed, with the new status and the bindings; a hook that throws is
 * logged and costs neither the next plugin its turn nor the admin the action.
 */
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '@/api/utils/core/logger'
import { runTenantStatusChangedHooks } from '@/api/utils/db/tenant-helpers'
import { tenants } from '@/db/schema'
import type { AnyServerPlugin } from '@/plugins/server'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

const heard = vi.hoisted(
  () => [] as { tenantId: string; status: string; stored: string | undefined; hasKv: boolean }[]
)

vi.mock('@/plugins/server', async importOriginal => {
  const actual = await importOriginal<typeof import('@/plugins/server')>()
  const { eq } = await import('drizzle-orm')
  const { tenants } = await import('@/db/schema')
  const broken = {
    shared: { id: 'status-broken' },
    hooks: {
      onTenantStatusChanged: async () => {
        throw new Error('hook exploded')
      },
    },
  }
  const recorder = {
    shared: { id: 'status-recorder' },
    hooks: {
      onTenantStatusChanged: async (
        db: import('@/db/client').Database,
        tenantId: string,
        status: string,
        env: TestEnv
      ) => {
        const [row] = await db
          .select({ status: tenants.status })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
        heard.push({ tenantId, status, stored: row?.status, hasKv: Boolean(env.RATE_LIMIT_KV) })
      },
    },
  }
  const plugins = [...actual.serverPlugins, broken, recorder] as unknown as AnyServerPlugin[]
  return { ...actual, SERVER_PLUGINS: plugins, serverPlugins: plugins }
})

const db = setupTestDatabase()

beforeEach(() => {
  heard.length = 0
})

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

describe('onTenantStatusChanged', () => {
  it('runs after suspend and after reactivate, with the stored status; a throwing hook does not stop the action', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const admin = await createTestGlobalAdmin(db)
    const cookie = sessionCookieHeader(await createTestSession(db, admin.id))
    const suspend = (suspended: boolean) =>
      request(
        `/api/admin/tenants/${tenant.id}/suspend`,
        { method: 'POST', headers: cookie },
        { json: { suspended } }
      )

    const res = await suspend(true)
    expect(res.status).toBe(200)
    const [row] = await db.select().from(tenants).where(eq(tenants.id, tenant.id))
    expect(row?.status).toBe('suspended')
    expect((await suspend(false)).status).toBe(200)

    expect(heard).toEqual([
      { tenantId: tenant.id, status: 'suspended', stored: 'suspended', hasKv: true },
      { tenantId: tenant.id, status: 'active', stored: 'active', hasKv: true },
    ])
  })

  it('logs each failing hook as a warning and runs the next', async () => {
    const calls: string[] = []
    const logger = fakeLogger()
    const plugin = (id: string, hook: () => Promise<void>) =>
      ({ shared: { id }, hooks: { onTenantStatusChanged: hook } }) as unknown as AnyServerPlugin
    await expect(
      runTenantStatusChangedHooks(
        db,
        '99999999-9999-4999-8999-999999999999',
        'suspended',
        createTestEnv(),
        logger,
        [
          plugin('broken', async () => {
            calls.push('broken')
            throw new Error('hook exploded')
          }),
          plugin('last', async () => {
            calls.push('last')
          }),
        ]
      )
    ).resolves.toBeUndefined()
    expect(calls).toEqual(['broken', 'last'])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'broken', status: 'suspended' }),
      'tenant status: plugin onTenantStatusChanged hook failed'
    )
  })
})

/**
 * `resolveOwnerTenant`, the tenant a plugin's public surface belongs to. `single` is THE tenant
 * (the oldest row), so those cases insert an older one inside a transaction and roll it back:
 * other test files share this database, and a committed row would become their single tenant.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import type { Tenant } from '@/db/schema'
import { resolveOwnerTenant } from '@/plugins/api'
import { createTestTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const single = loadConfig(createTestEnv({ TENANCY_MODE: 'single' }))
const multi = loadConfig(createTestEnv({ TENANCY_MODE: 'multi' }))

class Rollback extends Error {}

/** Runs `check` against a new oldest tenant that no other connection ever sees. */
async function withOldestTenant(
  status: Tenant['status'],
  check: (tx: Database, tenant: Tenant) => Promise<void>
) {
  await db
    .transaction(async tx => {
      const handle = tx as unknown as Database
      await check(handle, await createTestTenant(handle, { status, createdAt: new Date(0) }))
      throw new Rollback()
    })
    .catch(err => {
      if (!(err instanceof Rollback)) throw err
    })
}

describe('resolveOwnerTenant', () => {
  it('single: the one tenant, whatever slug is passed', async () => {
    await withOldestTenant('active', async (tx, oldest) => {
      expect((await resolveOwnerTenant(tx, single))?.id).toBe(oldest.id)
      expect((await resolveOwnerTenant(tx, single, 'some-other-slug'))?.id).toBe(oldest.id)
    })
  })

  it('single: a suspended tenant resolves to null', async () => {
    await withOldestTenant('suspended', async tx => {
      expect(await resolveOwnerTenant(tx, single)).toBeNull()
    })
  })

  it('multi: resolves by slug', async () => {
    const tenant = await createTestTenant(db)
    await createTestTenant(db)
    expect((await resolveOwnerTenant(db, multi, tenant.slug))?.id).toBe(tenant.id)
  })

  it('multi: an unknown slug resolves to null', async () => {
    expect(await resolveOwnerTenant(db, multi, 'no-such-tenant-slug')).toBeNull()
  })

  it('multi: a suspended tenant resolves to null', async () => {
    const tenant = await createTestTenant(db, { status: 'suspended' })
    expect(await resolveOwnerTenant(db, multi, tenant.slug)).toBeNull()
  })

  it('multi: no slug resolves to null, not the oldest tenant', async () => {
    await createTestTenant(db)
    expect(await resolveOwnerTenant(db, multi)).toBeNull()
    expect(await resolveOwnerTenant(db, multi, '')).toBeNull()
  })
})

/**
 * `runRequester` — what an agent run's tools know about the person who started it, read at
 * execute time: the same read scope `accessScopeForUser` gives (their groups, no bypass), their
 * CASL check, and the `ToolRequester` a plugin's tools scope by. Nobody behind the run, or a
 * person no longer able to act (blocked), holds nothing.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { accessScopeForUser } from '@/api/services/access'
import { runRequester } from '@/api/services/member-ability'
import { loadConfig } from '@/config'
import { groupMembers, groups, groupTypes, users } from '@/db/schema'
import { createTestTenant, createTestUser, linkUserToTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())

async function memberInFinance(role: 'member' | 'admin' = 'member') {
  const tenant = await createTestTenant(db)
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenant.id, role)
  const [type] = await db
    .insert(groupTypes)
    .values({ tenantId: tenant.id, name: 'Department' })
    .returning()
  const [finance] = await db
    .insert(groups)
    .values({ tenantId: tenant.id, groupTypeId: type?.id ?? '', name: 'Finance' })
    .returning()
  await db
    .insert(groupMembers)
    .values({ tenantId: tenant.id, groupId: finance?.id ?? '', userId: user.id })
  return { tenant, user, finance }
}

describe('runRequester', () => {
  it('gives the requester’s role, groups and grant, and the same scope as before', async () => {
    const { tenant, user, finance } = await memberInFinance()
    const r = await runRequester(db, cfg, tenant.id, user.id)
    expect(r.scope).toEqual(await accessScopeForUser(db, tenant.id, user.id))
    expect(r.requester).toEqual({
      userId: user.id,
      role: 'member',
      isAdmin: false,
      groups: [{ id: finance?.id, name: 'Finance', typeName: 'Department' }],
    })
    expect(r.can('read', 'Document')).toBe(true)
    expect(r.can('manage', 'Tenant')).toBe(false)
  })

  it('marks an admin as admin-level', async () => {
    const { tenant, user } = await memberInFinance('admin')
    expect((await runRequester(db, cfg, tenant.id, user.id)).requester?.isAdmin).toBe(true)
  })

  it('holds nothing for a run nobody started, or a blocked requester', async () => {
    const { tenant, user } = await memberInFinance()
    const none = await runRequester(db, cfg, tenant.id, null)
    expect(none.requester).toBeUndefined()
    expect(none.can('read', 'Document')).toBe(false)
    expect(none.scope).toEqual({ tenantId: tenant.id, userId: null, groupIds: [], bypass: false })

    await db.update(users).set({ blockedAt: new Date() }).where(eq(users.id, user.id))
    const blocked = await runRequester(db, cfg, tenant.id, user.id)
    expect(blocked.requester).toBeUndefined()
    expect(blocked.can('read', 'Document')).toBe(false)
  })
})

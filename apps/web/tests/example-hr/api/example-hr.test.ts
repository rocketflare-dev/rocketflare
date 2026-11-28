/**
 * The example HR domain over the real app: dark until its flag is on, a member asks and only a
 * manager decides, a decision is made once, its one public function applies HR's own read rule to
 * the caller, and nothing crosses an organisation.
 */
import { EXAMPLE_HR_FLAG, EXAMPLE_LEAVE_SUBJECT } from '@rocketflare/shared/example-hr/index'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  json,
  linkUserToTenant,
  request,
  sessionCookieHeader,
  setupTestDatabase,
} from '@testkit/integration'
import { beforeAll, describe, expect, it } from 'vitest'
import { ForbiddenError } from '@/plugins/api'
import { allTables } from '@/plugins/api/peers'
import { whoIsOnLeave } from '../../../src/example-hr/public'

const db = setupTestDatabase()
const today = new Date().toISOString().slice(0, 10)

async function org(flag: boolean) {
  const tenantId = (await createTestTenant(db)).id
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  const member = await createTestUser(db)
  await linkUserToTenant(db, member.id, tenantId, 'member')
  const { featureFlags, tenantFeatureOverrides } = allTables()
  await db.insert(featureFlags).values({ key: EXAMPLE_HR_FLAG, state: 'off' }).onConflictDoNothing()
  await db
    .insert(tenantFeatureOverrides)
    .values({ tenantId, flagKey: EXAMPLE_HR_FLAG, enabled: flag })
    .onConflictDoNothing()
  return {
    tenantId,
    memberId: member.id,
    owner: sessionCookieHeader(await createTestSession(db, owner.id, tenantId)),
    member: sessionCookieHeader(await createTestSession(db, member.id, tenantId)),
  }
}

const post = (path: string, headers: Record<string, string>, body: unknown) =>
  request(path, { method: 'POST', headers }, { json: body })

let a: Awaited<ReturnType<typeof org>>
let b: Awaited<ReturnType<typeof org>>
beforeAll(async () => {
  a = await org(true)
  b = await org(true)
})

describe('leave requests', () => {
  it('is a 404 while the flag is off', async () => {
    const dark = await org(false)
    const res = await request('/api/example-hr/leave-requests', { headers: dark.owner })
    expect(res.status).toBe(404)
  })

  it('lets a member ask, refuses the member a decision, and lets the owner decide once', async () => {
    const asked = await post('/api/example-hr/leave-requests', a.member, {
      startsOn: today,
      endsOn: today,
    })
    expect(asked.status).toBe(201)
    const { id } = await json<{ id: string }>(asked)
    const path = `/api/example-hr/leave-requests/${id}/decision`
    expect((await post(path, a.member, { decision: 'approve' })).status).toBe(403)
    expect((await post(path, a.owner, { decision: 'approve' })).status).toBe(200)
    expect((await post(path, a.owner, { decision: 'reject' })).status).toBe(409)
  })

  it('refuses a request that ends before it starts', async () => {
    const res = await post('/api/example-hr/leave-requests', a.member, {
      startsOn: '2026-05-02',
      endsOn: '2026-05-01',
    })
    expect(res.status).toBe(400)
  })

  it('never lets another organisation list or decide a request', async () => {
    const asked = await post('/api/example-hr/leave-requests', a.member, {
      startsOn: '2026-06-01',
      endsOn: '2026-06-02',
    })
    const { id } = await json<{ id: string }>(asked)
    const list = await json<{ items: Array<{ id: string }> }>(
      await request('/api/example-hr/leave-requests', { headers: b.owner })
    )
    expect(list.items.map(r => r.id)).not.toContain(id)
    const decide = await post(`/api/example-hr/leave-requests/${id}/decision`, b.owner, {
      decision: 'approve',
    })
    expect(decide.status).toBe(404)
  })
})

describe('whoIsOnLeave, the public door', () => {
  it('answers the caller’s tenant only, and refuses a caller who may not read leave', async () => {
    const reader = { db, tenantId: a.tenantId, can: () => true }
    expect(await whoIsOnLeave(reader, [a.memberId])).toEqual([a.memberId])
    expect(await whoIsOnLeave({ ...reader, tenantId: b.tenantId }, [a.memberId])).toEqual([])
    const stranger = {
      db,
      tenantId: a.tenantId,
      can: (action: string, subject: string) =>
        !(action === 'read' && subject === EXAMPLE_LEAVE_SUBJECT),
    }
    await expect(whoIsOnLeave(stranger, [a.memberId])).rejects.toBeInstanceOf(ForbiddenError)
  })
})

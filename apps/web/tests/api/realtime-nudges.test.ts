/**
 * Realtime nudges (D7, D8): mutations reach `NOTIFICATIONS_HUB` through `services/realtime.ts`
 * as deferred RPC calls — asserted on the recording namespace (`stubs(env).hub.broadcasts`), the
 * way queue producers are asserted on `RecordingQueue`. The event names WHAT changed; the client
 * re-queries. Nudges are a no-op without the binding and never fail the request.
 */
import type { RealtimeEvent } from '@gmgo/shared/realtime'
import { describe, expect, it, vi } from 'vitest'
import { createInvitation } from '@/api/services/invitations'
import type { JobsQueue } from '@/api/services/jobs'
import { notify } from '@/api/services/notifications'
import { createHubBroadcaster, nudge, type Realtime, realtimeEvent } from '@/api/services/realtime'
import { loadConfig } from '@/config'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { request } from '../helpers/request'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
/** Emails are queued by the invitation service; the nudge under test does not depend on it. */
const jobs = stubs(createTestEnv()).queue as unknown as JobsQueue
const newEmail = () => `rt_${uniqueId().toLowerCase()}@example.test`

async function ownerWithCookie() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  return { owner: user, tenant, cookie: sessionCookieHeader(await createTestSession(db, user.id)) }
}

/** `[method, event]` pairs recorded for a tenant, event typed for `toMatchObject`. */
function recorded(env: ReturnType<typeof createTestEnv>, tenantId: string) {
  return stubs(env)
    .hub.broadcasts.filter(b => b.tenantId === tenantId)
    .map(b => ({
      method: b.args[0] as string,
      target: b.args[1],
      event: b.args.at(-1) as RealtimeEvent,
    }))
}

describe('realtime nudges', () => {
  it('POST /api/invitations → broadcast invitation.changed to the tenant', async () => {
    const { tenant, cookie } = await ownerWithCookie()
    const env = createTestEnv()
    const res = await request(
      '/api/invitations',
      { method: 'POST', headers: cookie },
      { env, json: { email: newEmail(), role: 'member' } }
    )
    expect(res.status).toBe(201)
    const calls = recorded(env, tenant.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'broadcast',
      event: { type: 'invitation.changed', tenantId: tenant.id },
    })
    expect(calls[0]?.event.payload).toMatchObject({ id: expect.any(String) })
    expect(Date.parse(calls[0]?.event.at ?? '')).not.toBeNaN()
  })

  it('PATCH /api/members/:userId → broadcast member.changed', async () => {
    const { tenant, cookie } = await ownerWithCookie()
    const target = await createTestUser(db)
    await linkUserToTenant(db, target.id, tenant.id, 'member')
    const env = createTestEnv()
    const res = await request(
      `/api/members/${target.id}`,
      { method: 'PATCH', headers: cookie },
      { env, json: { role: 'admin' } }
    )
    expect(res.status).toBe(200)
    expect(recorded(env, tenant.id)).toEqual([
      expect.objectContaining({
        method: 'broadcast',
        event: expect.objectContaining({
          type: 'member.changed',
          tenantId: tenant.id,
          payload: { id: target.id },
        }),
      }),
    ])
  })

  it('accepting an invitation nudges the inviter (notification.created) and the tenant', async () => {
    const { owner, tenant } = await ownerWithCookie()
    const email = newEmail()
    const { token } = await createInvitation(db, cfg, logger, jobs, {
      tenantId: tenant.id,
      email,
      role: 'member',
      inviter: owner,
    })
    const invitee = await createTestUser(db, { email })
    const cookie = sessionCookieHeader(await createTestSession(db, invitee.id))
    const env = createTestEnv()
    const res = await request(
      `/api/invite/${token}/accept`,
      { method: 'POST', headers: cookie },
      { env }
    )
    expect(res.status).toBe(200)
    const calls = recorded(env, tenant.id)
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: 'broadcastToUser',
        target: owner.id,
        event: expect.objectContaining({ type: 'notification.created', tenantId: tenant.id }),
      })
    )
    expect(calls.map(c => c.event.type)).toEqual(
      expect.arrayContaining(['invitation.changed', 'member.changed'])
    )
  })

  it('notify() with a Realtime nudges only that user; without one it just inserts', async () => {
    const { owner, tenant } = await ownerWithCookie()
    const env = createTestEnv()
    const realtime: Realtime = { defer: fn => void fn(), env }
    await notify(
      db,
      { tenantId: tenant.id, userId: owner.id, type: 'system', title: 'Hello' },
      realtime
    )
    const [call] = recorded(env, tenant.id)
    expect(call).toMatchObject({
      method: 'broadcastToUser',
      target: owner.id,
      event: { type: 'notification.created', payload: { title: 'Hello', type: 'system' } },
    })
    await expect(
      notify(db, { tenantId: tenant.id, userId: owner.id, type: 'system', title: 'Quiet' })
    ).resolves.toBeUndefined()
    expect(recorded(env, tenant.id)).toHaveLength(1)
  })

  it('nudges are a no-op without the binding and never throw', () => {
    const defer = vi.fn()
    const env = createTestEnv({ NOTIFICATIONS_HUB: undefined })
    expect(() => nudge({ defer, env }, realtimeEvent('tenant.changed', 't1'))).not.toThrow()
    expect(defer).not.toHaveBeenCalled()
  })

  it('createHubBroadcaster addresses the tenant DO by name and returns { delivered }', async () => {
    const env = createTestEnv()
    const event = realtimeEvent('tenant.changed', 'tenant-x', { id: 'tenant-x' })
    await expect(createHubBroadcaster(env).toTenant('tenant-x', event)).resolves.toEqual({
      delivered: 0,
    })
    await createHubBroadcaster(env).toUsers('tenant-x', ['u1', 'u2'], event)
    expect(stubs(env).hub.broadcasts).toEqual([
      { tenantId: 'tenant-x', args: ['broadcast', event] },
      { tenantId: 'tenant-x', args: ['broadcastToUsers', ['u1', 'u2'], event] },
    ])
  })
})

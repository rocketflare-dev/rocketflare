// @vitest-isolate
// Swaps entries in the `AGENTS` registry (an agent with `meta.hitl`) and mocks the plugin barrels
// to register the fixture agents (tests/helpers/fixture-agents.ts).
/**
 * HITL upgrades (D44 phase 3):
 *   - `askTiming`: `meta.hitl.timeout` capped at `AGENT_INTERRUPT_TIMEOUT`; no reminder at or past
 *     the deadline;
 *   - named assignees — a user, or the members of a visibility group — are the ones told, see the
 *     ask in their inbox and its run, and may answer it; the requester then may not, an admin may;
 *   - `sendReminders` reminds the assignees ONCE, when `remind_at` has passed;
 *   - `onTimeout: 'reject'`: an expired ask is answered as a rejection by nobody, and the run is
 *     woken — not cancelled.
 */
import type { AgentKey } from '@rocketflare/shared/ai/agents'
import type { AgentInterruptSpec } from '@rocketflare/shared/ai/interrupts'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runSendReminders, runSweepLostRuns, SWEEP_STALE_MS } from '@/api/scheduled'
import { askTiming, TIMEOUT_REJECTION_NOTE } from '@/api/services/agents/hitl'
import { listInterrupts, requestInterrupt } from '@/api/services/agents/interrupts'
import { AGENTS, type AnyAgentDefinition } from '@/api/services/agents/registry'
import { enqueueRun, getRun, parkRun } from '@/api/services/agents/runs'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import {
  agentRunInterrupts,
  agentRuns,
  groupMembers,
  groups,
  groupTypes,
  notifications,
} from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { FIXTURE_AGENT } from '../helpers/fixture-agents'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)
vi.mock('@/plugins/server', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureServer(await importOriginal())
)

const db = setupTestDatabase()
const originals = { ...AGENTS }
afterEach(() => {
  Object.assign(AGENTS, originals)
})

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger
}

function withHitl(key: AgentKey, hitl: AnyAgentDefinition['meta']['hitl']) {
  AGENTS[key] = {
    meta: { ...originals[key].meta, inputSchema: z.any(), outputSchema: z.any(), hitl },
    run: async () => 'done',
  } as AnyAgentDefinition
}

async function member(tenantId: string, role: 'member' | 'admin' = 'member') {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
}

/** A run of the requester's, parked on one ask. */
async function parkedOn(
  env: TestEnv,
  spec: AgentInterruptSpec,
  timing: { expiresAt?: Date; remindAt?: Date } = {}
) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const requester = {
    user,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
  const { run } = await enqueueRun(db, loadConfig(env), env, {
    tenantId: tenant.id,
    agentKey: FIXTURE_AGENT,
    input: { text: 'x' },
    userId: user.id,
  })
  await db.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, run.id))
  const ask = await requestInterrupt(db, {
    tenantId: tenant.id,
    runId: run.id,
    key: 'decide',
    spec,
    ...timing,
  })
  await parkRun(db, tenant.id, run.id)
  return { tenant, requester, run, ask }
}

const answer = (cookie: Record<string, string>, env: TestEnv, runId: string, id: string) =>
  request(
    `/api/agents/runs/${runId}/interrupts/${id}`,
    { method: 'POST', headers: cookie },
    { env, json: { status: 'resolved' } }
  )

describe('askTiming', () => {
  const cfg = { AGENT_INTERRUPT_TIMEOUT: '168 hours' }
  const now = new Date('2026-11-18T00:00:00Z')
  it('caps the agent timeout at AGENT_INTERRUPT_TIMEOUT and drops a reminder past the deadline', () => {
    expect(askTiming(cfg, { timeout: '1 day', remindAfter: '2 hours' }, now)).toEqual({
      expiresAt: new Date('2026-11-19T00:00:00Z'),
      remindAt: new Date('2026-11-18T02:00:00Z'),
    })
    expect(askTiming(cfg, { timeout: '30 days' }, now).expiresAt).toEqual(
      new Date('2026-11-25T00:00:00Z')
    )
    expect(askTiming(cfg, { timeout: '1 hour', remindAfter: '1 hour' }, now).remindAt).toBeNull()
    expect(askTiming(cfg, undefined, now).remindAt).toBeNull()
  })
})

describe('named assignees', () => {
  it('a named user sees, and may answer, the ask — the requester may not, an admin may', async () => {
    const env = createTestEnv()
    const { tenant, requester, run, ask } = await parkedOn(env, {
      kind: 'approval',
      message: 'Ship it?',
    })
    const assignee = await member(tenant.id)
    await db
      .update(agentRunInterrupts)
      .set({ assigneeUserIds: [assignee.user.id] })
      .where(eq(agentRunInterrupts.id, ask.id))

    // The assignee: the ask is in their inbox, answerable, and the run is readable.
    const inbox = (await json(
      await request('/api/agents/interrupts', { headers: assignee.cookie }, { env })
    )) as { items: { id: string; canAnswer: boolean }[] }
    expect(inbox.items.map(i => [i.id, i.canAnswer])).toEqual([[ask.id, true]])
    expect(
      (await request(`/api/agents/runs/${run.id}`, { headers: assignee.cookie }, { env })).status
    ).toBe(200)
    // …but not someone else's run they were not asked about, and they cannot cancel this one.
    expect(
      (
        await request(
          `/api/agents/runs/${run.id}/cancel`,
          { method: 'POST', headers: assignee.cookie },
          { env }
        )
      ).status
    ).toBe(404)

    // The requester sees the ask read-only and is refused.
    const mine = (await json(
      await request('/api/agents/interrupts', { headers: requester.cookie }, { env })
    )) as { items: { id: string; canAnswer: boolean }[] }
    expect(mine.items.map(i => [i.id, i.canAnswer])).toEqual([[ask.id, false]])
    expect((await answer(requester.cookie, env, run.id, ask.id)).status).toBe(403)

    // Another member who is not assigned sees nothing.
    const other = await member(tenant.id)
    expect((await answer(other.cookie, env, run.id, ask.id)).status).toBe(404)

    expect((await answer(assignee.cookie, env, run.id, ask.id)).status).toBe(200)
    expect((await getRun(db, tenant.id, run.id))?.status).toBe('running')
  })

  it('a group assignee is told and may answer; an admin always may', async () => {
    const env = createTestEnv()
    const { tenant, run, ask } = await parkedOn(env, { kind: 'approval', message: 'Refund?' })
    const inGroup = await member(tenant.id)
    const [type] = await db
      .insert(groupTypes)
      .values({ tenantId: tenant.id, name: 'Team' })
      .returning()
    const [group] = await db
      .insert(groups)
      .values({ tenantId: tenant.id, groupTypeId: type?.id as string, name: 'Finance' })
      .returning()
    await db
      .insert(groupMembers)
      .values({ tenantId: tenant.id, groupId: group?.id as string, userId: inGroup.user.id })
    await db
      .update(agentRunInterrupts)
      .set({ assigneeGroupIds: [group?.id as string] })
      .where(eq(agentRunInterrupts.id, ask.id))

    const inbox = (await json(
      await request('/api/agents/interrupts', { headers: inGroup.cookie }, { env })
    )) as { items: { id: string; canAnswer: boolean }[] }
    expect(inbox.items.map(i => [i.id, i.canAnswer])).toEqual([[ask.id, true]])
    const admin = await member(tenant.id, 'admin')
    expect((await answer(admin.cookie, env, run.id, ask.id)).status).toBe(200)
  })
})

describe('reminders', () => {
  it('reminds the assignee once, when remind_at has passed', async () => {
    const env = createTestEnv()
    const { tenant, ask } = await parkedOn(
      env,
      { kind: 'approval', message: 'Still there?' },
      {
        remindAt: new Date(Date.now() - 1000),
      }
    )
    const assignee = await member(tenant.id)
    await db
      .update(agentRunInterrupts)
      .set({ assigneeUserIds: [assignee.user.id] })
      .where(eq(agentRunInterrupts.id, ask.id))

    await runSendReminders(db, fakeLogger())
    await runSendReminders(db, fakeLogger())
    const sent = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenant.id), eq(notifications.userId, assignee.user.id)))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.title).toMatch(/^Reminder:/)
  })
})

describe("onTimeout: 'reject'", () => {
  it('answers an expired ask as a rejection by nobody and wakes the run', async () => {
    withHitl(FIXTURE_AGENT, { onTimeout: 'reject' })
    const env = createTestEnv()
    const { tenant, run, ask } = await parkedOn(
      env,
      { kind: 'approval', message: 'OK?' },
      {
        expiresAt: new Date(Date.now() - 1000),
      }
    )
    await db
      .update(agentRuns)
      .set({ updatedAt: new Date(Date.now() - SWEEP_STALE_MS - 60_000) })
      .where(eq(agentRuns.id, run.id))

    await runSweepLostRuns(db, env, fakeLogger())

    const [settled] = await listInterrupts(db, tenant.id, run.id)
    expect(settled).toMatchObject({ id: ask.id, status: 'cancelled', resolvedByUserId: null })
    expect(settled?.payload).toEqual({ note: TIMEOUT_REJECTION_NOTE })
    expect((await getRun(db, tenant.id, run.id))?.status).toBe('running')
    expect(stubs(env).workflow?.events.at(-1)).toMatchObject({
      instanceId: run.id,
      type: 'agent-resume',
    })
  })

  it('without it, an expired park is cancelled as before', async () => {
    const env = createTestEnv()
    const { tenant, run } = await parkedOn(
      env,
      { kind: 'approval', message: 'OK?' },
      {
        expiresAt: new Date(Date.now() - 1000),
      }
    )
    await db
      .update(agentRuns)
      .set({ updatedAt: new Date(Date.now() - SWEEP_STALE_MS - 60_000) })
      .where(eq(agentRuns.id, run.id))
    await runSweepLostRuns(db, env, fakeLogger())
    expect((await getRun(db, tenant.id, run.id))?.status).toBe('cancelled')
  })
})

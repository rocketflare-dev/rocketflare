// @vitest-fixture-agents
/**
 * `sweepLostRuns` — the read path's settle for runs nobody is reading. Every case backdates the
 * row past `SWEEP_STALE_MS` and sets what the Workflow stub reports:
 *   - an `errored` instance settles `failed`, a `terminated` one `cancelled`;
 *   - a `running` or `waiting` instance is left alone, as is a row touched recently;
 *   - a `queued` row whose instance was never created gets one;
 *   - a park whose every ask has expired is settled `cancelled`.
 */
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, vi } from 'vitest'
import { runSweepLostRuns, SWEEP_STALE_MS } from '@/api/scheduled'
import { requestInterrupt } from '@/api/services/agents/interrupts'
import {
  ATTEMPT_DEAD_MS,
  claimRun,
  enqueueRun,
  getRun,
  listEvents,
  parkRun,
  requestCancel,
} from '@/api/services/agents/runs'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { agentRuns } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { FIXTURE_AGENT } from '../helpers/fixture-agents'
import { itSweeps } from '../helpers/sweeps'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
// Every case backdates a run past the sweep's staleness: one sweep at a time across files.
const sweepIt = (name: string, body: () => Promise<void>) => itSweeps(db, name, body)

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

function workflowStub(env: TestEnv) {
  const workflow = stubs(env).workflow
  if (!workflow) throw new Error('expected the AGENT_RUN_WORKFLOW stub')
  return workflow
}

async function staleRun(env: TestEnv, options: { claim?: boolean } = { claim: true }) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const { run } = await enqueueRun(db, loadConfig(env), env, {
    tenantId: tenant.id,
    agentKey: FIXTURE_AGENT,
    input: { text: 'anything' },
    userId: user.id,
  })
  if (options.claim) await claimRun(db, tenant.id, run.id)
  await backdate(run.id)
  return { run, tenant }
}

async function backdate(runId: string) {
  await db
    .update(agentRuns)
    .set({ updatedAt: new Date(Date.now() - SWEEP_STALE_MS - 60_000) })
    .where(eq(agentRuns.id, runId))
}

async function statusOf(tenantId: string, runId: string) {
  return (await getRun(db, tenantId, runId))?.status
}

let env: TestEnv
beforeEach(() => {
  env = createTestEnv()
})

describe('sweepLostRuns', () => {
  sweepIt('settles what the runtime says has ended, and nothing else', async () => {
    const errored = await staleRun(env)
    const terminated = await staleRun(env)
    const running = await staleRun(env)
    const waiting = await staleRun(env)
    const fresh = await staleRun(env)
    await db.update(agentRuns).set({ updatedAt: new Date() }).where(eq(agentRuns.id, fresh.run.id))
    workflowStub(env).setStatus(errored.run.id, {
      status: 'errored',
      error: { name: 'Error', message: 'boom' },
    })
    workflowStub(env).setStatus(terminated.run.id, { status: 'terminated' })
    workflowStub(env).setStatus(running.run.id, { status: 'running' })
    workflowStub(env).setStatus(waiting.run.id, { status: 'waiting' })
    workflowStub(env).setStatus(fresh.run.id, { status: 'errored' })

    const result = await runSweepLostRuns(db, env, fakeLogger())

    expect(await statusOf(errored.tenant.id, errored.run.id)).toBe('failed')
    expect((await getRun(db, errored.tenant.id, errored.run.id))?.error).toBe('boom')
    expect(await statusOf(terminated.tenant.id, terminated.run.id)).toBe('cancelled')
    expect(await statusOf(running.tenant.id, running.run.id)).toBe('running')
    expect(await statusOf(waiting.tenant.id, waiting.run.id)).toBe('running')
    expect(await statusOf(fresh.tenant.id, fresh.run.id)).toBe('running')
    expect(result.settled).toBeGreaterThanOrEqual(2)
    expect(result.failed).toBe(0)
  })

  sweepIt('creates the instance a queued run never got', async () => {
    const { run, tenant } = await staleRun(env, { claim: false })
    await db.update(agentRuns).set({ instanceId: null }).where(eq(agentRuns.id, run.id))
    await backdate(run.id)

    const result = await runSweepLostRuns(db, env, fakeLogger())

    expect(result.dispatched).toBeGreaterThanOrEqual(1)
    expect((await getRun(db, tenant.id, run.id))?.instanceId).toBe(run.id)
  })

  sweepIt('settles a park whose every ask has expired, and leaves one still in date', async () => {
    const expired = await staleRun(env)
    const inDate = await staleRun(env)
    for (const [{ run, tenant }, offset] of [
      [expired, -60_000],
      [inDate, 60 * 60_000],
    ] as const) {
      await parkRun(db, tenant.id, run.id)
      await requestInterrupt(db, {
        tenantId: tenant.id,
        runId: run.id,
        key: 'approve',
        spec: { kind: 'approval', message: 'Send it?' },
        expiresAt: new Date(Date.now() + offset),
      })
      await backdate(run.id)
    }

    await runSweepLostRuns(db, env, fakeLogger())

    expect(await statusOf(expired.tenant.id, expired.run.id)).toBe('cancelled')
    expect(await statusOf(inDate.tenant.id, inDate.run.id)).toBe('awaiting_input')
  })
})

describe('cancel without a live attempt', () => {
  const longAgo = () => new Date(Date.now() - ATTEMPT_DEAD_MS - 60_000)
  const silence = (runId: string) =>
    db
      .update(agentRuns)
      .set({ updatedAt: longAgo(), startedAt: longAgo(), createdAt: longAgo() })
      .where(eq(agentRuns.id, runId))
  const statusEvents = async (tenantId: string, runId: string) =>
    (await listEvents(db, tenantId, runId))
      .filter(e => e.type === 'status')
      .map(e => e.data as { status: string; reason?: string })

  sweepIt(
    'settles a running run nothing has touched for longer than a step, and says why',
    async () => {
      const { run, tenant } = await staleRun(env)
      await silence(run.id)
      const settled = await requestCancel(db, tenant.id, run.id, undefined, env)
      expect(settled?.status).toBe('cancelled')
      expect((await statusEvents(tenant.id, run.id)).at(-1)).toEqual({
        status: 'cancelled',
        reason: 'no_live_attempt',
      })
    }
  )

  sweepIt(
    'only flags a run with a live attempt, and a second cancel forces it with an event',
    async () => {
      const { run, tenant } = await staleRun(env)
      await db.update(agentRuns).set({ updatedAt: new Date() }).where(eq(agentRuns.id, run.id))
      expect((await requestCancel(db, tenant.id, run.id, undefined, env))?.status).toBe('running')
      expect(await statusEvents(tenant.id, run.id)).toEqual([])
      expect((await requestCancel(db, tenant.id, run.id, undefined, env))?.status).toBe('cancelled')
      expect((await statusEvents(tenant.id, run.id)).at(-1)).toEqual({
        status: 'cancelled',
        reason: 'forced',
      })
    }
  )

  sweepIt('a settle found by reconciling with the engine ends the log too', async () => {
    const { run, tenant } = await staleRun(env)
    workflowStub(env).setStatus(run.id, { status: 'terminated' })
    await runSweepLostRuns(db, env, fakeLogger())
    expect((await statusEvents(tenant.id, run.id)).at(-1)).toEqual({
      status: 'cancelled',
      reason: 'reconciled',
    })
  })
})

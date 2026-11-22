// @vitest-fixture-agents
/**
 * Version pinning (D44 phase 3) through the real runtime and database:
 *   - a run records its agent's `meta.version` at enqueue and the Worker deployment it ran on;
 *   - an attempt under ANOTHER `meta.version` applies `onVersionChange`: `continue` moves the row
 *     forward and says so, `fail` settles `failed` with `agent_version_changed`, `rerun` cancels
 *     the run and starts ONE new run of the same input (a retried step does not start a second);
 *   - a `pinned` agent always fails across versions, and its repeated `ctx.once` labels are
 *     order-derived (`label@2`) instead of a key conflict;
 *   - `pinned` with any other policy is refused by `assertVersionMeta`.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AGENTS, type AgentContext, type AnyAgentDefinition } from '@/api/services/agents/registry'
import { enqueueRun, getRun, idempotentRunId, listEvents } from '@/api/services/agents/runs'
import { claimStep, executeRun } from '@/api/services/agents/runtime'
import { assertVersionMeta } from '@/api/services/agents/versions'
import { overrideResolveChatForTests } from '@/api/services/ai/resolve'
import type { ChatClient } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { agentRunEffects } from '@/db/schema'
import { FakeChatClient } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { FIXTURE_AGENT } from '../helpers/fixture-agents'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

const state: { client: ChatClient } = { client: new FakeChatClient([], 'anthropic') }
overrideResolveChatForTests(async () => ({
  client: state.client,
  provider: 'anthropic' as const,
  model: 'claude-sonnet-4-5',
  source: 'tenant' as const,
  billedToPlatform: false,
  maxOutputTokens: 2048,
}))

const db = setupTestDatabase()
const original = AGENTS[FIXTURE_AGENT]
afterEach(() => {
  AGENTS[FIXTURE_AGENT] = original
})

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

function install(
  meta: Partial<AnyAgentDefinition['meta']>,
  run: (ctx: AgentContext) => Promise<unknown> = async () => 'done'
) {
  AGENTS[FIXTURE_AGENT] = {
    meta: { ...original.meta, inputSchema: z.any(), outputSchema: z.any(), ...meta },
    run,
  } as AnyAgentDefinition
}

async function startedRun(env: TestEnv) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const { run } = await enqueueRun(db, loadConfig(env), env, {
    tenantId: tenant.id,
    agentKey: FIXTURE_AGENT,
    input: { text: 'hello' },
    userId: user.id,
  })
  const params = { runId: run.id, tenantId: tenant.id }
  expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
  return { run, params }
}

const execute = (env: TestEnv, params: { runId: string; tenantId: string }) =>
  executeRun(db, loadConfig(env), env, fakeLogger(), params)

describe('version pinning', () => {
  it('records meta.version at enqueue and the Worker deployment on execute', async () => {
    install({ version: 3 })
    const env = {
      ...createTestEnv(),
      CF_VERSION_METADATA: { id: 'deploy-abc', tag: '', timestamp: '' },
    }
    const { run, params } = await startedRun(env)
    expect(run.agentVersion).toBe(3)
    expect((await execute(env, params)).status).toBe('succeeded')
    expect(await getRun(db, params.tenantId, params.runId)).toMatchObject({
      agentVersion: 3,
      workerVersionId: 'deploy-abc',
    })
  })

  it('continue (the default) carries on under the new version and says so', async () => {
    install({ version: 1 })
    const env = createTestEnv()
    const { params } = await startedRun(env)
    install({ version: 2 })
    expect((await execute(env, params)).status).toBe('succeeded')
    expect((await getRun(db, params.tenantId, params.runId))?.agentVersion).toBe(2)
    const events = await listEvents(db, params.tenantId, params.runId)
    expect(
      events.find(e => (e.data as { reason?: string }).reason === 'version_changed')?.data
    ).toMatchObject({ fromVersion: 1, toVersion: 2 })
  })

  it('fail settles failed with agent_version_changed and never runs the agent', async () => {
    install({ version: 1, onVersionChange: 'fail' })
    const env = createTestEnv()
    const { params } = await startedRun(env)
    const ran = vi.fn(async () => 'ran')
    install({ version: 2, onVersionChange: 'fail' }, ran)
    expect((await execute(env, params)).status).toBe('failed')
    expect(ran).not.toHaveBeenCalled()
    const error = (await listEvents(db, params.tenantId, params.runId)).find(
      e => e.type === 'error'
    )
    expect(error?.data).toMatchObject({ code: ERROR_CODES.agentVersionChanged })
  })

  it('rerun cancels the run and starts a new run of the same input under the new version', async () => {
    install({ version: 1, onVersionChange: 'rerun' })
    const env = createTestEnv()
    const { params } = await startedRun(env)
    install({ version: 2, onVersionChange: 'rerun' })
    expect((await execute(env, params)).status).toBe('cancelled')
    const status = (await listEvents(db, params.tenantId, params.runId)).find(
      e => (e.data as { reason?: string }).reason === 'version_rerun'
    )?.data as { rerunRunId?: string }
    expect(status.rerunRunId).toBeDefined()
    const rerun = await getRun(db, params.tenantId, status.rerunRunId as string)
    expect(rerun).toMatchObject({ status: 'queued', agentVersion: 2, input: { text: 'hello' } })
    // Derived from the old run's id (`rerun:<id>`): a retried step finds it, never starts two.
    expect(status.rerunRunId).toBe(
      await idempotentRunId(params.tenantId, FIXTURE_AGENT, `rerun:${params.runId}`)
    )
  })

  it('a pinned agent fails across versions and keys repeated once labels by order', async () => {
    install({ version: 1, pinned: true }, async ctx => {
      for (const n of [1, 2, 3]) await ctx.once('step', async () => n)
      return 'done'
    })
    const env = createTestEnv()
    const { params } = await startedRun(env)
    expect((await execute(env, params)).status).toBe('succeeded')
    const keys = await db
      .select({ key: agentRunEffects.key, result: agentRunEffects.result })
      .from(agentRunEffects)
      .where(eq(agentRunEffects.runId, params.runId))
    expect(keys.map(k => k.key).sort()).toEqual(['step', 'step@2', 'step@3'])

    const second = await startedRun(env)
    install({ version: 2, pinned: true })
    expect((await execute(env, second.params)).status).toBe('failed')
  })

  it('every registered agent declares a valid version policy', () => {
    for (const agent of Object.values(AGENTS))
      expect(() => assertVersionMeta(agent.meta)).not.toThrow()
  })

  it('assertVersionMeta refuses a pinned agent that would continue, and a bad version', () => {
    const meta = original.meta as AnyAgentDefinition['meta']
    expect(() => assertVersionMeta({ ...meta, pinned: true, onVersionChange: 'continue' })).toThrow(
      /pinned/
    )
    expect(() => assertVersionMeta({ ...meta, version: 0 })).toThrow(/positive integer/)
    expect(() => assertVersionMeta({ ...meta, pinned: true })).not.toThrow()
  })
})

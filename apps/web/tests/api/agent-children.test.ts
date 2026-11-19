// @vitest-isolate
// Swaps entries in the `AGENTS` registry (a parent that spawns, a child it spawns) and mocks
// `@/api/services/ai/resolve` and the plugin barrels, so this file needs its own module registry.
/**
 * Child runs (`ctx.spawn`, D44 phase 3), through the runtime's real steps:
 *   - the parent parks with NO ask, the child is a run of its own (`parent_run_id`, a budget carved
 *     from the parent's), and the child's `finish` wakes the parent, which then gets its output;
 *   - a retried parent finds the SAME child, never a second one;
 *   - a failed child throws `ChildRunFailedError` into the parent, which may catch it;
 *   - a cancel of the parent cascades; children stay out of the runs list unless asked for.
 */
import { agentRunTimelineSchema } from '@rocketflare/shared/ai/agent-timeline'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ChildRunFailedError } from '@/api/services/agents/children'
import { listInterrupts } from '@/api/services/agents/interrupts'
import { AGENTS, type AgentContext, type AnyAgentDefinition } from '@/api/services/agents/registry'
import { enqueueRun, getRun, requestCancel } from '@/api/services/agents/runs'
import { claimStep, executeRun, finishStep } from '@/api/services/agents/runtime'
import { AiError } from '@/api/services/ai/errors'
import type { ChatClient } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { agentRuns } from '@/db/schema'
import { FakeChatClient } from '../helpers/ai'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { FIXTURE_AGENT, FIXTURE_AGENT_B } from '../helpers/fixture-agents'
import { json, request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)
vi.mock('@/plugins/server', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureServer(await importOriginal())
)

const state: { client: ChatClient | null } = {
  client: new FakeChatClient([{ text: 'x' }], 'anthropic'),
}
vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      if (!state.client) throw new AiError('auth', 'anthropic', 'no client')
      return {
        client: state.client,
        provider: 'anthropic' as const,
        model: 'claude-sonnet-4-5',
        source: 'tenant' as const,
        maxOutputTokens: 2048,
      }
    }),
  }
})

const db = setupTestDatabase()
const originals = { ...AGENTS }
afterEach(() => {
  Object.assign(AGENTS, originals)
})

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger
}

function install(
  key: typeof FIXTURE_AGENT,
  run: (ctx: AgentContext) => Promise<unknown>,
  meta: Partial<AnyAgentDefinition['meta']> = {}
) {
  AGENTS[key] = {
    meta: { ...originals[key].meta, inputSchema: z.any(), outputSchema: z.any(), ...meta },
    run,
  } as AnyAgentDefinition
}

async function startParent(env: TestEnv) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const { run } = await enqueueRun(db, loadConfig(env), env, {
    tenantId: tenant.id,
    agentKey: FIXTURE_AGENT,
    input: { n: 2 },
    userId: user.id,
  })
  const params = { runId: run.id, tenantId: tenant.id }
  expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
  return { user, tenant, params }
}

const attempt = (env: TestEnv, params: { runId: string; tenantId: string }) =>
  executeRun(db, loadConfig(env), env, fakeLogger(), params)

/** What the child's Workflow does: claim, execute, finish. */
async function runChildToEnd(env: TestEnv, tenantId: string, runId: string) {
  const params = { runId, tenantId }
  expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
  const outcome = await attempt(env, params)
  return finishStep(db, env, fakeLogger(), params, outcome)
}

const childrenOf = (tenantId: string, parentRunId: string) =>
  db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.parentRunId, parentRunId)))

describe('ctx.spawn', () => {
  it('parks the parent with no ask, runs the child, wakes the parent and hands it the output', async () => {
    install(FIXTURE_AGENT_B, async ctx => ({ doubled: (ctx.input as { n: number }).n * 2 }))
    install(
      FIXTURE_AGENT,
      async ctx => {
        const out = await ctx.spawn<{ doubled: number }>('double', FIXTURE_AGENT_B, ctx.input)
        return { got: out.doubled }
      },
      { budget: { maxTokens: 10_000 } }
    )
    const env = createTestEnv()
    const { user, tenant, params } = await startParent(env)

    expect((await attempt(env, params)).status).toBe('awaiting_input')
    expect(await listInterrupts(db, tenant.id, params.runId)).toEqual([])
    const [child] = await childrenOf(tenant.id, params.runId)
    expect(child).toMatchObject({
      agentKey: FIXTURE_AGENT_B,
      status: 'queued',
      budget: { maxTokens: 10_000 },
    })

    // A retried parent attempt before the child ran: the same child, not a second.
    await db.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, params.runId))
    expect((await attempt(env, params)).status).toBe('awaiting_input')
    expect(await childrenOf(tenant.id, params.runId)).toHaveLength(1)

    const settled = await runChildToEnd(env, tenant.id, child?.id as string)
    expect(settled.status).toBe('succeeded')
    // The child's finish woke the parent.
    expect((await getRun(db, tenant.id, params.runId))?.status).toBe('running')

    expect(await attempt(env, params)).toMatchObject({ status: 'succeeded' })
    expect((await getRun(db, tenant.id, params.runId))?.output).toEqual({ got: 4 })

    // The inspector: the child, the recorded output, the versions and the parent's budget.
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const res = await request(
      `/api/agents/runs/${params.runId}/timeline`,
      { headers: cookie },
      { env }
    )
    expect(res.status).toBe(200)
    const timeline = agentRunTimelineSchema.parse(await json(res))
    expect(timeline.versions).toEqual({
      agentVersion: 1,
      currentAgentVersion: 1,
      workerVersionId: null,
    })
    expect(timeline.spend.budget).toEqual({ maxTokens: 10_000 })
    expect(timeline.children.map(c => [c.id, c.status])).toEqual([[child?.id, 'succeeded']])
    const labels = timeline.entries.map(e => e.label)
    expect(labels).toContain(`spawned ${FIXTURE_AGENT_B}`)
    expect(labels).toContain(`child ${FIXTURE_AGENT_B} succeeded`)
    expect(labels).toContain('child output recorded double')
    const times = timeline.entries.map(e => e.at.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    // The child, read by itself, says whose it is.
    const childRes = await request(
      `/api/agents/runs/${child?.id}/timeline`,
      { headers: cookie },
      { env }
    )
    expect(agentRunTimelineSchema.parse(await json(childRes)).run.parentRunId).toBe(params.runId)
  })

  it('a failed child throws ChildRunFailedError, which the parent may catch', async () => {
    install(FIXTURE_AGENT_B, async () => {
      throw new Error('child broke')
    })
    install(FIXTURE_AGENT, async ctx => {
      try {
        return await ctx.spawn('work', FIXTURE_AGENT_B, {})
      } catch (err) {
        if (err instanceof ChildRunFailedError) return { fallback: err.childStatus }
        throw err
      }
    })
    const env = createTestEnv()
    const { tenant, params } = await startParent(env)
    expect((await attempt(env, params)).status).toBe('awaiting_input')
    const [child] = await childrenOf(tenant.id, params.runId)
    // Not retryable inside the test: settle it the way finish does after retries.
    const childParams = { runId: child?.id as string, tenantId: tenant.id }
    await claimStep(db, env, fakeLogger(), childParams)
    await attempt(env, childParams)
    await finishStep(db, env, fakeLogger(), childParams, {
      ...childParams,
      status: 'failed',
      error: 'child broke',
    })
    expect((await getRun(db, tenant.id, childParams.runId))?.status).toBe('failed')
    expect((await getRun(db, tenant.id, params.runId))?.status).toBe('running')
    expect(await attempt(env, params)).toMatchObject({ status: 'succeeded' })
    expect((await getRun(db, tenant.id, params.runId))?.output).toEqual({ fallback: 'failed' })
  })

  it('a cancel of the parent cascades; children are listed only under their parent', async () => {
    install(FIXTURE_AGENT_B, async () => 'never')
    install(FIXTURE_AGENT, async ctx =>
      Promise.all([ctx.spawn('a', FIXTURE_AGENT_B, {}), ctx.spawn('b', FIXTURE_AGENT_B, {})])
    )
    const env = createTestEnv()
    const { user, tenant, params } = await startParent(env)
    expect((await attempt(env, params)).status).toBe('awaiting_input')
    // Both spawns created their child before the park.
    expect(await childrenOf(tenant.id, params.runId)).toHaveLength(2)

    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const top = (await json(await request('/api/agents/runs', { headers: cookie }, { env }))) as {
      items: { id: string }[]
    }
    expect(top.items.map(r => r.id)).toEqual([params.runId])
    const under = (await json(
      await request(`/api/agents/runs?parentRunId=${params.runId}`, { headers: cookie }, { env })
    )) as { items: { id: string }[] }
    expect(under.items).toHaveLength(2)

    await requestCancel(db, tenant.id, params.runId, undefined, env)
    expect((await getRun(db, tenant.id, params.runId))?.status).toBe('cancelled')
    expect((await childrenOf(tenant.id, params.runId)).map(c => c.status)).toEqual([
      'cancelled',
      'cancelled',
    ])
  })
})

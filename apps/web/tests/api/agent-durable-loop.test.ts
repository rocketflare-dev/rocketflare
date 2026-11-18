// @vitest-isolate
// Mocks `@/api/services/ai/resolve` and swaps an entry of the shared `AGENTS` registry, so this file needs its own module registry.
// Also mocks the plugin barrels to register the fixture agents (tests/helpers/fixture-agents.ts).
/**
 * The durable loop through the real runtime and database (`executeRun`, `agent_run_turns`):
 *   - a retry after a crash part-way through a turn is billed only for the turns it still owes,
 *     and re-runs no tool that had finished; the settled run keeps its journal while its
 *     checkpoint is cleared, and a STRICT replay answers it from the journal with no model call;
 *   - a tool loop inside a `ctx.map` item — which has no checkpoint — resumes from its own scoped
 *     journal;
 *   - key safety: `ctx.once` twice under one key in one attempt fails the run with
 *     `agent_effect_key_conflict`; `{ inputs }` makes one record per input, served on a retry;
 *   - the nightly prune drops the journals of runs settled past the retention, nothing else.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runPruneAgentTurns } from '@/api/scheduled'
import { AGENTS, type AgentContext, type AnyAgentDefinition } from '@/api/services/agents/registry'
import { replayRun } from '@/api/services/agents/replay'
import { enqueueRun, getRun, listEvents } from '@/api/services/agents/runs'
import { claimStep, executeRun } from '@/api/services/agents/runtime'
import { runToolLoop, type Tool } from '@/api/services/ai/agent-loop'
import { AiError } from '@/api/services/ai/errors'
import type { ChatClient } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { agentRunEffects, agentRuns, agentRunTurns, aiUsage } from '@/db/schema'
import { FakeChatClient, type FakeScript } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { FIXTURE_AGENT } from '../helpers/fixture-agents'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)
vi.mock('@/plugins/server', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureServer(await importOriginal())
)

const state: { client: ChatClient | null } = { client: null }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => ({
      client: state.client,
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      source: 'tenant' as const,
      maxOutputTokens: 2048,
    })),
  }
})

const db = setupTestDatabase()

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

const originalAgent = AGENTS[FIXTURE_AGENT]

function installAgent(run: (ctx: AgentContext) => Promise<unknown>): AnyAgentDefinition {
  const agent = {
    meta: { ...originalAgent.meta, inputSchema: z.any(), outputSchema: z.any() },
    run,
  } as AnyAgentDefinition
  AGENTS[FIXTURE_AGENT] = agent
  return agent
}

function script(turns: FakeScript) {
  const client = new FakeChatClient(turns, 'anthropic')
  state.client = client
  return client
}

async function enqueueAndClaim(env: TestEnv) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const { run } = await enqueueRun(db, loadConfig(env), env, {
    tenantId: tenant.id,
    agentKey: FIXTURE_AGENT,
    input: {},
    userId: user.id,
  })
  const params = { runId: run.id, tenantId: tenant.id }
  expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
  return params
}

/** A retried `execute` step: claimed again through the row, then run. */
async function attempt(env: TestEnv, params: { runId: string; tenantId: string }) {
  return executeRun(db, loadConfig(env), env, fakeLogger(), params)
}

const answerTool: Tool<{ answer: string }> = {
  name: 'answer',
  description: 'terminal',
  schema: z.object({ answer: z.string() }),
}

function counted(name: string) {
  const calls: string[] = []
  const tool: Tool<{ q: string }> = {
    name,
    description: 'read',
    schema: z.object({ q: z.string() }),
    handler: async input => {
      calls.push(input.q)
      return `${name}: ${input.q}`
    },
  }
  return { tool, calls }
}

const usageRows = async (runId: string) =>
  db.select().from(aiUsage).where(eq(aiUsage.agentRunId, runId))

beforeEach(() => {
  // An agent that never calls the model still gets a client resolved for it.
  script([{ text: 'unused' }])
})

afterEach(() => {
  AGENTS[FIXTURE_AGENT] = originalAgent
})

describe('the durable tool loop', () => {
  it('a mid-turn crash costs no second model call and re-runs no finished tool; replay is strict', async () => {
    const env = createTestEnv()
    const a = counted('a')
    const b = counted('b')
    let crash = true
    installAgent(async ctx => {
      const loop = await runToolLoop(ctx.chat.client, {
        model: ctx.chat.model,
        system: 'research',
        messages: [{ role: 'user', content: 'go' }],
        tools: [a.tool, b.tool, answerTool as Tool],
        policy: { maxConcurrentToolCalls: 1 },
        resume: (await ctx.checkpoint.load()) ?? undefined,
        onCheckpoint: ctx.checkpoint.save,
        journal: ctx.journal,
        onEvent: async event => {
          // The isolate dies between b's result settling and the turn finishing.
          if (event.kind === 'tool_result' && event.name === 'b' && crash) {
            crash = false
            throw new AiError('unavailable', 'anthropic', 'connection reset')
          }
          await ctx.emit({ type: 'text', data: { text: event.kind } })
        },
      })
      return loop.terminalInput
    })
    const client = script([
      {
        toolUses: [
          { id: 'call-a', name: 'a', input: { q: '1' } },
          { id: 'call-b', name: 'b', input: { q: '2' } },
        ],
      },
      { toolUses: [{ id: 'call-z', name: 'answer', input: { answer: 'done' } }] },
    ])
    const params = await enqueueAndClaim(env)

    await expect(attempt(env, params)).rejects.toThrow(/connection reset/)
    expect(client.calls).toHaveLength(1)
    expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
    const outcome = await attempt(env, params)

    expect(outcome.status).toBe('succeeded')
    expect((await getRun(db, params.tenantId, params.runId))?.output).toEqual({ answer: 'done' })
    expect(a.calls).toEqual(['1'])
    expect(b.calls).toEqual(['2'])
    // Two model calls in all — turn 1 once, turn 2 once — and one usage row each.
    expect(client.calls).toHaveLength(2)
    expect(await usageRows(params.runId)).toHaveLength(2)

    // Settling clears the checkpoint and keeps the journal: two model turns, two tool results.
    const row = await getRun(db, params.tenantId, params.runId)
    expect(row?.checkpoint).toBeNull()
    const turns = await db.select().from(agentRunTurns).where(eq(agentRunTurns.runId, params.runId))
    expect(turns.filter(t => t.role === 'model').map(t => t.turn)).toEqual(
      expect.arrayContaining([1, 2])
    )
    expect(
      turns
        .filter(t => t.role === 'tool')
        .map(t => [t.toolCallId, t.status])
        .sort()
    ).toEqual([
      ['call-a', 'settled'],
      ['call-b', 'settled'],
    ])

    // A strict replay of the settled run: answered from the journal, no model call at all.
    const replayClient = script([])
    if (!row) throw new Error('run vanished')
    const replay = await replayRun(db, loadConfig(env), env, row, AGENTS[FIXTURE_AGENT], {
      logger: fakeLogger(),
    })
    expect(replay).toMatchObject({ verdict: 'match', replayStatus: 'succeeded', misses: [] })
    expect(replay.turns).toEqual([
      { loop: 'tool-loop', turn: 1, status: 'served' },
      { loop: 'tool-loop', turn: 2, status: 'served' },
    ])
    expect(replayClient.calls).toHaveLength(0)

    // Today's code sends a different seed: strict still answers from the journal, and says so.
    const reworded = installAgent(async ctx => {
      const loop = await runToolLoop(ctx.chat.client, {
        model: ctx.chat.model,
        system: 'research',
        messages: [{ role: 'user', content: 'go, and be thorough' }],
        tools: [a.tool, b.tool, answerTool as Tool],
        journal: ctx.journal,
      })
      return loop.terminalInput
    })
    const drift = await replayRun(db, loadConfig(env), env, row, reworded, {
      logger: fakeLogger(),
    })
    expect(drift.verdict).toBe('differs')
    expect(drift.turns.map(t => t.status)).toEqual(['drift', 'drift'])
    expect(replayClient.calls).toHaveLength(0)
  })

  it('a tool loop inside a ctx.map item resumes from its own scoped journal', async () => {
    const env = createTestEnv()
    const search = counted('search')
    let crash = true
    installAgent(async ctx =>
      ctx.map(
        'items',
        ['only'],
        async (_item, scope) => {
          const loop = await runToolLoop(scope.chat.client, {
            model: scope.chat.model,
            system: 'item',
            messages: [{ role: 'user', content: 'go' }],
            tools: [search.tool, answerTool as Tool],
            journal: scope.journal,
            onStep: async step => {
              if (step.turn === 2 && crash) {
                crash = false
                throw new AiError('unavailable', 'anthropic', 'overloaded')
              }
            },
          })
          return loop.terminalInput
        },
        { concurrency: 1 }
      )
    )
    const client = script([
      { toolUses: [{ id: 's-1', name: 'search', input: { q: 'x' } }] },
      { toolUses: [{ id: 'z-1', name: 'answer', input: { answer: 'ok' } }] },
    ])
    const params = await enqueueAndClaim(env)
    await expect(attempt(env, params)).rejects.toThrow(/overloaded/)
    expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
    expect((await attempt(env, params)).status).toBe('succeeded')

    // Both turns were recorded by attempt 1 (turn 2 before `onStep` threw); attempt 2 was served
    // both — the item restarted from its seed with no checkpoint, and paid for nothing.
    expect(client.calls).toHaveLength(2)
    expect(search.calls).toEqual(['x'])
    const loops = await db
      .selectDistinct({ loopKey: agentRunTurns.loopKey })
      .from(agentRunTurns)
      .where(eq(agentRunTurns.runId, params.runId))
    expect(loops).toEqual([{ loopKey: 'items[0]/tool-loop' }])
  })
})

describe('ctx.once key safety', () => {
  it('the same key twice in one attempt fails the run with agent_effect_key_conflict', async () => {
    const env = createTestEnv()
    installAgent(async ctx => {
      const out = []
      for (const q of ['alpha', 'beta']) out.push(await ctx.once('search', async () => q))
      return out
    })
    const params = await enqueueAndClaim(env)
    const outcome = await attempt(env, params)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/ctx\.once\("search"\) was called twice/)
    const events = await listEvents(db, params.tenantId, params.runId)
    expect(events.find(e => e.type === 'error')?.data).toMatchObject({
      code: ERROR_CODES.agentEffectKeyConflict,
      details: { primitive: 'once', key: 'search' },
    })
  })

  it('{ inputs } gives every call its own record, and a retry is served them', async () => {
    const env = createTestEnv()
    const ran: string[] = []
    let crash = true
    installAgent(async ctx => {
      const out = []
      for (const q of ['alpha', 'beta']) {
        out.push(
          await ctx.once(
            'search',
            async () => {
              ran.push(q)
              return q.toUpperCase()
            },
            { inputs: { q } }
          )
        )
      }
      if (crash) {
        crash = false
        throw new AiError('rate_limit', 'anthropic', 'slow down')
      }
      return out
    })
    const params = await enqueueAndClaim(env)
    await expect(attempt(env, params)).rejects.toThrow(/slow down/)
    expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
    expect((await attempt(env, params)).status).toBe('succeeded')

    expect((await getRun(db, params.tenantId, params.runId))?.output).toEqual(['ALPHA', 'BETA'])
    expect(ran).toEqual(['alpha', 'beta'])
    const keys = (
      await db
        .select({ key: agentRunEffects.key })
        .from(agentRunEffects)
        .where(eq(agentRunEffects.runId, params.runId))
    ).map(r => r.key)
    expect(keys).toHaveLength(2)
    for (const key of keys) expect(key).toMatch(/^search#[0-9a-f]{12}$/)
  })
})

describe('runPruneAgentTurns', () => {
  it('drops journals of runs settled past the cutoff, and keeps active and recent ones', async () => {
    const env = createTestEnv()
    installAgent(async ctx => {
      const loop = await runToolLoop(ctx.chat.client, {
        model: ctx.chat.model,
        system: 's',
        messages: [{ role: 'user', content: 'go' }],
        tools: [answerTool as Tool],
        journal: ctx.journal,
      })
      return loop.terminalInput
    })
    const finished = async () => {
      script([{ toolUses: [{ id: crypto.randomUUID(), name: 'answer', input: { answer: 'x' } }] }])
      const params = await enqueueAndClaim(env)
      expect((await attempt(env, params)).status).toBe('succeeded')
      return params.runId
    }
    const old = await finished()
    const recent = await finished()
    // An ACTIVE run whose journal rows are old: a parked run resumes from them.
    const parkedRun = await finished()
    await db
      .update(agentRuns)
      .set({ status: 'awaiting_input', finishedAt: null })
      .where(eq(agentRuns.id, parkedRun))

    const now = new Date()
    const longAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000)
    await db.update(agentRuns).set({ finishedAt: longAgo }).where(eq(agentRuns.id, old))
    for (const runId of [old, parkedRun]) {
      await db
        .update(agentRunTurns)
        .set({ updatedAt: longAgo })
        .where(eq(agentRunTurns.runId, runId))
    }

    const result = await runPruneAgentTurns(db, 30, now)
    expect(result.turns).toBeGreaterThanOrEqual(1)
    const left = async (runId: string) =>
      (
        await db
          .select({ id: agentRunTurns.id })
          .from(agentRunTurns)
          .where(and(eq(agentRunTurns.runId, runId)))
      ).length
    expect(await left(old)).toBe(0)
    expect(await left(recent)).toBe(1)
    expect(await left(parkedRun)).toBe(1)
    // The run itself is kept: only its transcript ages out.
    expect(await db.select().from(agentRuns).where(eq(agentRuns.id, old))).toHaveLength(1)
  })
})

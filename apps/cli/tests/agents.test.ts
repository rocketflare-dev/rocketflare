/**
 * `agents list|run|runs list`: one run from a JSON file, a JSONL batch split into chunks of
 * `AGENT_RUN_BATCH_MAX` with failed lines reported by line number and exit 1, the `--batch` filter,
 * and the argument errors that never reach the server.
 *
 * The agents are fixtures registered the way a plugin registers its own (`SharedPlugin.agentKeys`),
 * because the CLI parses `agentKey` with the shared enum and no test may borrow an example agent:
 * an app deletes those.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_RUN_BATCH_MAX,
  createAgentRunBatchResponseSchema,
} from '@rocketflare/shared/ai/agents'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgentRunsList, runAgentsList, runAgentsRun } from '../src/commands/agents'
import { EXIT_ERROR, exitCodeFor } from '../src/errors'
import {
  captureError,
  jsonResponse,
  mockFetch,
  TENANT_ID,
  TEST_KEY,
  tempStore,
  testContext,
  USER_ID,
} from './helpers'

vi.mock('@rocketflare/shared/plugins', async importOriginal => {
  const actual = await importOriginal<typeof import('@rocketflare/shared/plugins')>()
  const fixture = {
    id: 'fixture',
    label: 'Fixture agents (tests)',
    agentKeys: ['fixture-agent', 'fixture-batchable'],
  }
  const plugins = [...actual.sharedPlugins, fixture]
  return { ...actual, SHARED_PLUGINS: plugins, sharedPlugins: plugins }
})

const SERVER = 'http://server.test'
const BATCH = '7b0f3c1a-2d4e-4f6a-8b9c-0d1e2f3a4b5c'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function setup() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({ serverUrl: SERVER, apiKey: TEST_KEY, tenantId: TENANT_ID, tenantName: 'A' })
  return { store: t.store, dir: t.dir }
}

let n = 0
const run = (over: Record<string, unknown> = {}) => {
  n += 1
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    tenantId: TENANT_ID,
    agentKey: 'fixture-batchable',
    status: 'queued',
    input: {},
    output: null,
    error: null,
    requestedByUserId: USER_ID,
    instanceId: null,
    attempt: 0,
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    createdAt: '2026-10-12T10:00:00.000Z',
    exclusive: false,
    batchId: BATCH,
    ...over,
  }
}

/** Answers a batch the way the server does: every input a run, except `{ "bad": true }`. */
function batchServer() {
  return mockFetch({
    '/api/agents/runs/batch': (_url, init) => {
      const body = JSON.parse(String(init.body)) as { agentKey: string; inputs: unknown[] }
      const items = body.inputs.map((input, index) =>
        (input as { bad?: boolean }).bad
          ? {
              index,
              run: null,
              error: { code: 'validation_failed', message: 'Invalid agent input' },
            }
          : { index, run: run({ input }), error: null }
      )
      const failed = items.filter(i => i.error).length
      return jsonResponse(
        { batchId: BATCH, agentKey: body.agentKey, created: items.length - failed, failed, items },
        202
      )
    },
  })
}

describe('agents list', () => {
  it('says which agents can batch', async () => {
    const { store } = await setup()
    const { fetch } = mockFetch({
      '/api/agents': () =>
        jsonResponse({
          items: [
            {
              key: 'fixture-agent',
              title: 'Fixture agent',
              description: '',
              promptKey: 'fixture-agent',
              exclusive: true,
            },
            {
              key: 'fixture-batchable',
              title: 'Fixture batchable',
              description: '',
              promptKey: 'fixture-batchable',
              exclusive: false,
            },
          ],
        }),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runAgentsList(ctx)
    expect(out.content()).toMatch(/fixture-agent.*exclusive/)
    expect(out.content()).toMatch(/fixture-batchable.*yes/)
  })
})

describe('agents run', () => {
  it('--input posts one run from a JSON file', async () => {
    const { store, dir } = await setup()
    const file = join(dir, 'input.json')
    await writeFile(file, JSON.stringify({ question: 'Who approves access?' }))
    const { fetch, calls } = mockFetch({
      '/api/agents/runs': () => jsonResponse({ ...run(), deduplicated: false }, 202),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runAgentsRun(ctx, 'fixture-batchable', { input: file })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      agentKey: 'fixture-batchable',
      input: { question: 'Who approves access?' },
    })
    expect(JSON.parse(out.content())).toMatchObject({
      agentKey: 'fixture-batchable',
      status: 'queued',
    })
  })

  it('--batch sends the JSONL in chunks of the server max, skipping blank lines', async () => {
    const { store, dir } = await setup()
    const file = join(dir, 'inputs.jsonl')
    const total = AGENT_RUN_BATCH_MAX + 5
    const lines = Array.from({ length: total }, (_, i) => JSON.stringify({ question: `q${i}` }))
    await writeFile(file, `${lines.slice(0, 3).join('\n')}\n\n${lines.slice(3).join('\n')}\n`)
    const { fetch, calls } = batchServer()
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runAgentsRun(ctx, 'fixture-batchable', { batch: file })
    expect(calls.map(c => JSON.parse(String(c.init.body)).inputs.length)).toEqual([
      AGENT_RUN_BATCH_MAX,
      5,
    ])
    const printed = JSON.parse(out.content()) as unknown[]
    expect(printed).toHaveLength(2)
    expect(createAgentRunBatchResponseSchema.parse(printed[1]).created).toBe(5)
  })

  it('reports the lines that did not start and exits 1 after the rest started', async () => {
    const { store, dir } = await setup()
    const file = join(dir, 'inputs.jsonl')
    await writeFile(file, ['{"question":"a"}', '{"bad":true}', '{"question":"c"}'].join('\n'))
    const { fetch } = batchServer()
    const { ctx, out } = await testContext({ store, fetch })
    const error = await captureError(runAgentsRun(ctx, 'fixture-batchable', { batch: file }))
    expect(error.message).toBe('1 of 3 inputs did not start')
    expect(error.hint).toMatch(/^Lines 2: Invalid agent input/)
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(out.content()).toContain('validation_failed')
  })

  it('refuses both or neither flag, a bad line and a missing file — before any request', async () => {
    const { store, dir } = await setup()
    const { fetch, calls } = batchServer()
    const { ctx } = await testContext({ store, fetch })
    expect((await captureError(runAgentsRun(ctx, 'x', {}))).message).toMatch(/exactly one/)
    expect(
      (await captureError(runAgentsRun(ctx, 'x', { input: 'a.json', batch: 'b.jsonl' }))).message
    ).toMatch(/exactly one/)
    const bad = join(dir, 'bad.jsonl')
    await writeFile(bad, '{"question":"ok"}\n{nope\n')
    expect((await captureError(runAgentsRun(ctx, 'x', { batch: bad }))).message).toBe(
      `${bad}:2 is not valid JSON`
    )
    expect(
      (await captureError(runAgentsRun(ctx, 'x', { input: join(dir, 'missing.json') }))).message
    ).toMatch(/^Cannot read/)
    expect(calls).toHaveLength(0)
  })
})

describe('agents runs list', () => {
  it('passes --batch as batchId and prints the runs', async () => {
    const { store } = await setup()
    const { fetch, calls } = mockFetch({
      '/api/agents/runs': () =>
        jsonResponse({
          items: [run({ status: 'failed', error: 'Could not start the workflow: boom' })],
          pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
        }),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runAgentRunsList(ctx, { batch: BATCH, agent: 'fixture-batchable' })
    expect(calls[0]?.url.searchParams.get('batchId')).toBe(BATCH)
    expect(calls[0]?.url.searchParams.get('agentKey')).toBe('fixture-batchable')
    expect(out.content()).toContain('Could not start the workflow')
  })
})

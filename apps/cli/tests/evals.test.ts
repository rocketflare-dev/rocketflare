/**
 * `feedback list` and `evals promote` (D33), plus the feedback span in `traces show`: the promotion
 * queue renders and forwards its filters; promote tries the id as a message and falls back to a run
 * on 404, refuses to write tenant data unconfirmed, refuses a duplicate case id, and appends one
 * valid `EvalCase` line.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evalCaseSchema } from '@rocketflare/shared/ai/evals'
import { afterEach, describe, expect, it } from 'vitest'
import { findDatasetsDir, runEvalsPromote } from '../src/commands/evals'
import { runFeedbackList } from '../src/commands/feedback'
import { runTracesShow } from '../src/commands/traces'
import { EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
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

const SERVER = 'http://server.test'
const MESSAGE = '6b1d9a52-3c4e-4f70-8a91-0b2c3d4e5f60'
const RUN = '3f9c2b1e-8d4a-4c6b-9e2f-1a2b3c4d5e6f'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function loggedInStore() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({ serverUrl: SERVER, apiKey: TEST_KEY, tenantId: TENANT_ID, tenantName: 'A' })
  return t.store
}

/** A repo-shaped temp dir: `<root>/apps/evals/datasets`, returned with a nested cwd inside it. */
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'rocketflare-evals-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const datasets = join(root, 'apps', 'evals', 'datasets')
  await mkdir(datasets, { recursive: true })
  const cwd = join(root, 'apps', 'cli')
  await mkdir(cwd, { recursive: true })
  return { root, datasets, cwd }
}

const draft = (over: Record<string, unknown> = {}) => ({
  case: {
    id: 'message-6b1d9a52',
    input: 'What is our refund window?',
    messages: [],
    context: [{ title: 'Refund policy', text: 'Refunds within 30 days.' }],
    expected: { output: 'Thirty days.', tools: ['search_knowledge'] },
    tags: ['promoted', 'chat'],
    source: { kind: 'message', id: MESSAGE, feedback: { rating: -1, comment: 'too short' } },
    ...over,
  },
  containsTenantData: true,
})

const feedback = {
  id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  target: 'message',
  targetId: MESSAGE,
  rating: -1,
  comment: 'Wrong policy',
  userId: USER_ID,
  traceId: null,
  createdAt: '2026-09-25T10:00:00.000Z',
  updatedAt: '2026-09-25T10:00:00.000Z',
}

describe('feedback list', () => {
  it('renders the queue, forwards --rating/--target, maps 403 to exit 3', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/feedback': () =>
        jsonResponse({
          items: [feedback],
          pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
        }),
    })
    const { ctx, out, log } = await testContext({ store, fetch: api.fetch })
    await runFeedbackList(ctx, { rating: 'down', target: 'message' })
    expect(out.content()).toContain(MESSAGE)
    expect(out.content()).toContain('Wrong policy')
    expect(api.calls[0]?.url.searchParams.get('rating')).toBe('down')
    expect(api.calls[0]?.url.searchParams.get('target')).toBe('message')
    expect(log.lines.join('\n')).toContain('evals promote')

    const forbidden = mockFetch({
      '/api/feedback': () =>
        jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403),
    })
    const { ctx: ctx2 } = await testContext({ store, fetch: forbidden.fetch })
    expect(exitCodeFor(await captureError(runFeedbackList(ctx2)))).toBe(EXIT_FORBIDDEN)
  })
})

describe('evals promote', () => {
  it('finds apps/evals/datasets from a nested cwd', async () => {
    const { datasets, cwd } = await repo()
    expect(findDatasetsDir(cwd)).toBe(datasets)
    expect(findDatasetsDir(tmpdir())).toBeNull()
  })

  it('appends one valid EvalCase line after a confirmed prompt, warning about tenant data', async () => {
    const store = await loggedInStore()
    const { datasets, cwd } = await repo()
    const api = mockFetch({ '/api/evals/export': () => jsonResponse(draft()) })
    const { ctx, log } = await testContext({ store, fetch: api.fetch })
    const asked: string[] = []
    await runEvalsPromote(ctx, MESSAGE, {
      dataset: 'knowledge-chat',
      cwd,
      confirm: async q => {
        asked.push(q)
        return true
      },
    })
    expect(api.calls[0]?.url.searchParams.get('messageId')).toBe(MESSAGE)
    expect(asked).toHaveLength(1)
    expect(log.lines.join('\n')).toContain('TENANT DATA')
    const lines = (await readFile(join(datasets, 'knowledge-chat.jsonl'), 'utf8'))
      .trim()
      .split('\n')
    expect(lines).toHaveLength(1)
    const written = evalCaseSchema.parse(JSON.parse(lines[0] ?? '{}'))
    expect(written).toMatchObject({ id: 'message-6b1d9a52', source: { kind: 'message' } })
  })

  it('falls back to the run lookup on a 404, and --id renames the case', async () => {
    const store = await loggedInStore()
    const { datasets, cwd } = await repo()
    const api = mockFetch({
      '/api/evals/export': url =>
        url.searchParams.get('messageId')
          ? jsonResponse({ error: 'Not found', statusCode: 404, code: 'message_not_found' }, 404)
          : jsonResponse(
              draft({
                id: 'run-3f9c2b1e',
                input: { question: 'refunds?' },
                agentKey: 'research-topic',
                source: { kind: 'agent_run', id: RUN },
              })
            ),
    })
    const { ctx } = await testContext({ store, fetch: api.fetch })
    await runEvalsPromote(ctx, RUN, { dataset: 'research', cwd, yes: true, id: 'refund-window' })
    expect(api.calls.map(c => [...c.url.searchParams.keys()][0])).toEqual(['messageId', 'runId'])
    const line = (await readFile(join(datasets, 'research.jsonl'), 'utf8')).trim()
    expect(evalCaseSchema.parse(JSON.parse(line))).toMatchObject({
      id: 'refund-window',
      agentKey: 'research-topic',
    })
  })

  it('refuses without confirmation off a terminal, on a declined prompt and on a duplicate id', async () => {
    const store = await loggedInStore()
    const { datasets, cwd } = await repo()
    const api = mockFetch({ '/api/evals/export': () => jsonResponse(draft()) })
    const { ctx } = await testContext({ store, fetch: api.fetch })

    await runEvalsPromote(ctx, MESSAGE, { dataset: 'd', cwd, confirm: async () => false })
    await expect(readFile(join(datasets, 'd.jsonl'), 'utf8')).rejects.toThrow()

    await writeFile(join(datasets, 'd.jsonl'), `${JSON.stringify({ id: 'message-6b1d9a52' })}\n`)
    const dup = await captureError(runEvalsPromote(ctx, MESSAGE, { dataset: 'd', cwd, yes: true }))
    expect(dup.message).toContain('already has a case')

    const bad = await captureError(runEvalsPromote(ctx, MESSAGE, { dataset: 'Bad Name', cwd }))
    expect(bad.message).toContain('Invalid dataset name')
  })
})

describe('traces show — feedback', () => {
  it('prints a feedback span as a thumbs line with its comment', async () => {
    const store = await loggedInStore()
    const TRACE = '0af7651916cd43dd8448eb211c80319c'
    const span = (over: Record<string, unknown>) => ({
      traceId: TRACE,
      parentSpanId: null,
      status: 'ok',
      statusMessage: null,
      startedAt: '2026-09-25T10:00:00.000Z',
      endedAt: '2026-09-25T10:00:01.000Z',
      durationMs: 1000,
      model: null,
      provider: null,
      inputTokens: null,
      outputTokens: null,
      toolName: null,
      attributes: {},
      content: null,
      ...over,
    })
    const detail = {
      trace: {
        traceId: TRACE,
        name: 'invoke_agent chat',
        status: 'ok',
        startedAt: '2026-09-25T10:00:00.000Z',
        endedAt: '2026-09-25T10:00:01.000Z',
        durationMs: 1000,
        spanCount: 2,
        errorCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        models: [],
        runId: null,
        conversationId: null,
        userId: USER_ID,
        traceUrl: null,
      },
      spans: [
        span({ spanId: 'a1', name: 'invoke_agent chat', kind: 'agent' }),
        span({
          spanId: 'f2',
          parentSpanId: 'a1',
          name: 'feedback',
          kind: 'span',
          attributes: { 'rocketflare.feedback.rating': -1 },
          content: { input: 'Cited the wrong policy' },
        }),
      ],
    }
    const api = mockFetch({ [`/api/traces/${MESSAGE}`]: () => jsonResponse(detail) })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runTracesShow(ctx, MESSAGE)
    expect(out.content()).toMatch(/└ feedback {2}👎 down/)
    expect(out.content()).toContain('"Cited the wrong policy"')
  })
})

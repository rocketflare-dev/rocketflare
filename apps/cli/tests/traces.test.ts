/** `traces list|show` (D32): table vs `--json`, the span tree with tool I/O, 403 → exit 3. */
import { traceDetailSchema } from '@rocketflare/shared/ai/traces'
import { afterEach, describe, expect, it } from 'vitest'
import { formatDuration, runTracesList, runTracesShow } from '../src/commands/traces'
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
const TRACE = '0af7651916cd43dd8448eb211c80319c'
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

const summary = {
  traceId: TRACE,
  name: 'invoke_agent research-topic',
  status: 'error',
  startedAt: '2026-09-25T10:00:00.000Z',
  endedAt: '2026-09-25T10:00:04.200Z',
  durationMs: 4200,
  spanCount: 4,
  errorCount: 1,
  inputTokens: 120,
  outputTokens: 30,
  models: ['claude-sonnet-5'],
  runId: RUN,
  conversationId: null,
  userId: USER_ID,
  traceUrl: `https://cloud.langfuse.com/project/p/traces/${TRACE}`,
}

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
  trace: summary,
  spans: [
    span({
      spanId: 'a1',
      name: 'invoke_agent research-topic',
      kind: 'agent',
      status: 'error',
      statusMessage: 'failed',
    }),
    span({ spanId: 'b2', parentSpanId: 'a1', name: 'execute#0', kind: 'span' }),
    span({
      spanId: 'c3',
      parentSpanId: 'b2',
      name: 'chat claude-sonnet-5',
      kind: 'llm',
      model: 'claude-sonnet-5',
      inputTokens: 120,
      outputTokens: 30,
      content: { input: { messages: [] }, output: [{ type: 'text', text: 'hi' }] },
    }),
    span({
      spanId: 'd4',
      parentSpanId: 'b2',
      name: 'execute_tool search_knowledge',
      kind: 'tool',
      status: 'error',
      statusMessage: 'no embeddings provider',
      toolName: 'search_knowledge',
      content: { input: { query: 'volcano' }, output: 'x'.repeat(1000) },
    }),
  ],
}

describe('traces list', () => {
  it('renders one row per trace, forwards the filters, maps 403 to exit 3', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/traces': () =>
        jsonResponse({
          items: [summary],
          pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
        }),
    })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runTracesList(ctx, { agent: 'research-topic', status: 'error', runId: RUN })
    expect(out.content()).toContain(TRACE)
    expect(out.content()).toMatch(/invoke_agent research-topic\s+error\s+4\.2s\s+4\s+120\/30/)
    expect(api.calls[0]?.url.searchParams.get('agent')).toBe('research-topic')
    expect(api.calls[0]?.url.searchParams.get('status')).toBe('error')
    expect(api.calls[0]?.url.searchParams.get('runId')).toBe(RUN)

    const forbidden = mockFetch({
      '/api/traces': () =>
        jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403),
    })
    const { ctx: ctx2 } = await testContext({ store, fetch: forbidden.fetch })
    expect(exitCodeFor(await captureError(runTracesList(ctx2)))).toBe(EXIT_FORBIDDEN)
  })
})

describe('traces show', () => {
  it('prints the indented span tree with tool I/O clipped, errors and the link-out', async () => {
    const store = await loggedInStore()
    const api = mockFetch({ [`/api/traces/${RUN}`]: () => jsonResponse(detail) })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runTracesShow(ctx, RUN)
    const lines = out.content().split('\n')
    expect(
      lines.some(l => l.startsWith('invoke_agent research-topic') && l.includes('ERROR failed'))
    ).toBe(true)
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}└ execute#0/))
    expect(lines).toContainEqual(expect.stringMatching(/^ {4}└ chat claude-sonnet-5 {2}120→30 tok/))
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {4}└ execute_tool search_knowledge .*ERROR no embeddings provider/)
    )
    expect(out.content()).toContain('in:  {"query":"volcano"}')
    expect(out.content()).toContain('(+600 chars)')
    expect(out.content()).toContain(`open: ${summary.traceUrl}`)

    const { ctx: full, out: fullOut } = await testContext({ store, fetch: api.fetch })
    await runTracesShow(full, RUN, { full: true })
    expect(fullOut.content()).toContain('x'.repeat(1000))
  })

  it('--json prints the raw body, parseable with the shared schema', async () => {
    const store = await loggedInStore()
    const api = mockFetch({ [`/api/traces/${TRACE}`]: () => jsonResponse(detail) })
    const { ctx, out } = await testContext({ store, fetch: api.fetch, json: true })
    await runTracesShow(ctx, TRACE)
    expect(traceDetailSchema.parse(JSON.parse(out.content())).spans).toHaveLength(4)
  })

  it('formats durations', () => {
    expect([formatDuration(12), formatDuration(4200), formatDuration(125_000)]).toEqual([
      '12ms',
      '4.2s',
      '2m5s',
    ])
  })
})

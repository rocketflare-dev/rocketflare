/**
 * `memory list` / `memory forget` (D36): the table and `--json`, the query forwarding, the two
 * forget shapes, and the dark-feature 404 surfacing as an error rather than an empty list.
 */
import { memoryListResponseSchema } from '@rocketflare/shared/ai/memory'
import { afterEach, describe, expect, it } from 'vitest'
import { runMemoryForget, runMemoryList } from '../src/commands/memory'
import { EXIT_ERROR, exitCodeFor } from '../src/errors'
import {
  captureError,
  jsonResponse,
  mockFetch,
  TENANT_ID,
  TEST_KEY,
  tempStore,
  testContext,
} from './helpers'

const SERVER = 'http://server.test'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function loggedInStore() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({
    serverUrl: SERVER,
    apiKey: TEST_KEY,
    tenantId: TENANT_ID,
    tenantName: 'Acme',
  })
  return t.store
}

const FACT_ID = '11111111-1111-4111-8111-111111111111'
const list = {
  items: [
    {
      id: FACT_ID,
      text: 'Leads the Payments team',
      kind: 'fact',
      visibility: 'private',
      occurredStart: '2026-03-01T00:00:00.000Z',
      occurredEnd: null,
      mentionedAt: '2026-10-01T09:00:00.000Z',
      entities: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Payments' }],
      sourceConversationId: null,
      invalidatedAt: null,
      supersededById: null,
      createdAt: '2026-10-01T09:00:00.000Z',
    },
  ],
  pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
}

describe('memory list', () => {
  it('renders a table, forwards --q/--history, and --json is the contract', async () => {
    const store = await loggedInStore()
    const api = mockFetch({ '/api/memory': () => jsonResponse(list) })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runMemoryList(ctx, { q: 'payments', history: true })
    expect(out.content()).toContain('Leads the Payments team')
    expect(out.content()).toContain('Payments')
    expect(api.calls[0]?.url.searchParams.get('q')).toBe('payments')
    expect(api.calls[0]?.url.searchParams.get('includeHistorical')).toBe('true')

    const json = await testContext({ store, fetch: api.fetch, json: true })
    await runMemoryList(json.ctx)
    expect(memoryListResponseSchema.parse(JSON.parse(json.out.content())).items).toHaveLength(1)
  })

  it('an organisation without memory is an error, not an empty list', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/memory': () =>
        jsonResponse({ error: 'Not available', statusCode: 404, code: 'feature_disabled' }, 404),
    })
    const { ctx } = await testContext({ store, fetch: api.fetch })
    expect(exitCodeFor(await captureError(runMemoryList(ctx)))).toBe(EXIT_ERROR)
  })
})

describe('memory forget', () => {
  it('forgets one by id, everything with --all, and refuses neither', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      [`/api/memory/${FACT_ID}`]: () => new Response(null, { status: 204 }),
      '/api/memory': () => jsonResponse({ deleted: 3 }),
    })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runMemoryForget(ctx, FACT_ID)
    expect(api.calls[0]?.init.method).toBe('DELETE')
    expect(api.calls[0]?.url.pathname).toBe(`/api/memory/${FACT_ID}`)
    await runMemoryForget(ctx, undefined, { all: true })
    expect(api.calls[1]?.url.pathname).toBe('/api/memory')
    expect(out.content()).toContain('Forgot 3 memories.')
    expect(exitCodeFor(await captureError(runMemoryForget(ctx, undefined)))).toBe(EXIT_ERROR)
  })
})

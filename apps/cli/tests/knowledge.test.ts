/**
 * `docs list|search|ingest|retry` and `facts review|confirm|reject|prefer`: the request each one
 * sends, `--json` printing the server's body unchanged, the human output, and the argument errors
 * that never reach the server (a binary file, an empty or oversized one, a bad `--status`).
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { INGEST_TEXT_MAX_CHARS } from '@rocketflare/shared/ai/embeddings'
import { afterEach, describe, expect, it } from 'vitest'
import { runDocsIngest, runDocsList, runDocsRetry, runDocsSearch } from '../src/commands/docs'
import { runFactsReview, runFactsSettle } from '../src/commands/facts'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
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
const DOC = '0b9c4a2e-1f3d-4e5a-8b6c-7d8e9f0a1b2c'
const FACT = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const OTHER = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a'
const ENTITY = '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b'
const NOW = '2026-11-20T10:00:00.000Z'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function setup() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({ serverUrl: SERVER, apiKey: TEST_KEY, tenantId: TENANT_ID, tenantName: 'A' })
  return t
}

const doc = (over: Record<string, unknown> = {}) => ({
  id: DOC,
  tenantId: TENANT_ID,
  ownerUserId: USER_ID,
  title: 'Brightside contract',
  source: 'upload',
  contentType: 'text/plain',
  sizeBytes: 120,
  fileId: null,
  chunkCount: 3,
  status: 'indexed',
  error: null,
  visibility: 'tenant',
  groups: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})

const fact = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  entityKind: 'staging',
  entityType: 'customer',
  entityId: ENTITY,
  key: 'monthly_fee_gbp',
  value: 285,
  valueText: '285',
  source: {
    kind: 'upload',
    documentId: DOC,
    documentTitle: 'Brightside contract',
    chunkId: null,
    charStart: null,
    charEnd: null,
    quote: 'Monthly Fee: £285',
  },
  confidence: 0.9,
  state: 'conflicting',
  supersededById: null,
  conflictsWith: [],
  validFrom: null,
  validTo: null,
  observedAt: NOW,
  confirmedBy: null,
  confirmedAt: null,
  reviewerUserId: USER_ID,
  visibility: 'tenant',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})

const page = (items: unknown[]) => ({
  items,
  pagination: { page: 1, pageSize: 20, total: items.length, totalPages: 1 },
})

describe('docs', () => {
  it('list passes --status and prints the body unchanged with --json', async () => {
    const t = await setup()
    const body = page([doc({ status: 'failed', error: 'too long' })])
    const { fetch, calls } = mockFetch({ '/api/ai/documents': () => jsonResponse(body) })
    const { ctx, out, log } = await testContext({ store: t.store, fetch, json: true })
    await runDocsList(ctx, { status: 'failed' })
    expect(calls[0]?.url.searchParams.get('status')).toBe('failed')
    expect(JSON.parse(out.content())).toEqual(body)

    const human = await testContext({ store: t.store, fetch })
    await runDocsList(human.ctx)
    expect(human.out.content()).toContain('Brightside contract')
    expect(human.log.lines.join('\n')).toContain('docs retry <id>')
    expect(log.lines.join('\n')).not.toContain('docs retry')
  })

  it('list refuses an unknown --status before any request', async () => {
    const t = await setup()
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store: t.store, fetch })
    const error = await captureError(runDocsList(ctx, { status: 'done' }))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(calls).toHaveLength(0)
  })

  it('search posts the query and prints each passage, neutralised', async () => {
    const t = await setup()
    const hit = {
      chunkId: OTHER,
      documentId: DOC,
      title: 'Brightside\u001b]0;pwned\u0007 contract',
      text: 'Monthly Fee: £285 per month',
      seq: 0,
      documentPassages: 3,
      headingPath: 'Fees',
      page: null,
      charOffset: 0,
      score: 0.03,
      rank: 1,
      denseRank: 1,
      lexicalRank: 1,
      rerankScore: null,
    }
    const { fetch, calls } = mockFetch({
      '/api/ai/documents/search': () =>
        jsonResponse({ query: 'fee', hits: [hit], lexical: 'used' }),
    })
    const { ctx, out } = await testContext({ store: t.store, fetch })
    await runDocsSearch(ctx, ' fee ', { limit: 5 })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ query: 'fee', limit: 5 })
    expect(out.content()).toContain('Monthly Fee: £285')
    expect(out.content()).not.toContain('\u001b]0;')
  })

  it('ingest sends the file text with its name as the title', async () => {
    const t = await setup()
    const path = join(t.dir, 'price-list.md')
    await writeFile(path, '# Prices\n\nGritting: £40 per visit')
    const { fetch, calls } = mockFetch({
      '/api/ai/documents/ingest': () =>
        jsonResponse({ ...doc({ title: 'price-list' }), deduplicated: false }, 201),
    })
    const { ctx, out } = await testContext({ store: t.store, fetch })
    await runDocsIngest(ctx, path)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      title: 'price-list',
      text: '# Prices\n\nGritting: £40 per visit',
    })
    expect(out.content()).toContain('searchable now')
  })

  it('ingest refuses a binary, an empty and an oversized file without a request', async () => {
    const t = await setup()
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store: t.store, fetch })
    const pdf = join(t.dir, 'contract.pdf')
    const empty = join(t.dir, 'empty.txt')
    const big = join(t.dir, 'big.txt')
    await writeFile(pdf, '%PDF-1.7')
    await writeFile(empty, '  \n')
    await writeFile(big, 'x'.repeat(INGEST_TEXT_MAX_CHARS + 1))
    for (const path of [pdf, empty, big, join(t.dir, 'missing.txt')]) {
      expect(exitCodeFor(await captureError(runDocsIngest(ctx, path)))).toBe(EXIT_ERROR)
    }
    expect(calls).toHaveLength(0)
  })

  it('retry posts to the document and maps a 403 to exit 3', async () => {
    const t = await setup()
    const { fetch, calls } = mockFetch({
      [`/api/ai/documents/${DOC}/retry`]: () =>
        jsonResponse({ ...doc({ status: 'pending' }), job: 'document.index' }, 202),
    })
    const { ctx, out } = await testContext({ store: t.store, fetch })
    await runDocsRetry(ctx, DOC)
    expect(calls[0]?.init.method).toBe('POST')
    expect(out.content()).toContain('pending')

    const refused = mockFetch({
      [`/api/ai/documents/${DOC}/retry`]: () =>
        jsonResponse({ error: 'You can only retry documents you added', statusCode: 403 }, 403),
    })
    const other = await testContext({ store: t.store, fetch: refused.fetch })
    expect(exitCodeFor(await captureError(runDocsRetry(other.ctx, DOC)))).toBe(EXIT_FORBIDDEN)
  })
})

describe('facts', () => {
  const items = [
    {
      kind: 'fact',
      fact: fact(FACT, { conflictsWith: [OTHER] }),
      entity: { kind: 'staging', type: 'customer', id: ENTITY, name: 'Brightside Bakery' },
      conflicts: [fact(OTHER, { value: 300, valueText: '300', conflictsWith: [FACT] })],
    },
    {
      kind: 'possibleMatch',
      entity: {
        id: ENTITY,
        type: 'customer',
        name: 'Brightside',
        aliases: [],
        promotedTo: null,
        mergedInto: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      candidates: [{ kind: 'staging', id: OTHER, label: 'Brightside Bakery', score: 0.6 }],
      reviewerUserId: USER_ID,
    },
  ]

  it('review lists both kinds of item, with --mine passed through', async () => {
    const t = await setup()
    const { fetch, calls } = mockFetch({ '/api/knowledge/review': () => jsonResponse(page(items)) })
    const { ctx, out } = await testContext({ store: t.store, fetch })
    await runFactsReview(ctx, { mine: true })
    expect(calls[0]?.url.searchParams.get('mine')).toBe('true')
    const text = out.content()
    expect(text).toContain('conflict')
    expect(text).toContain('300')
    expect(text).toContain('same as?')

    const json = await testContext({ store: t.store, fetch, json: true })
    await runFactsReview(json.ctx)
    expect(JSON.parse(json.out.content())).toEqual(page(items))
  })

  it('says so plainly when the organisation does not have knowledge facts', async () => {
    const t = await setup()
    const { fetch } = mockFetch({
      '/api/knowledge/review': () =>
        jsonResponse({ error: 'Not found', statusCode: 404, code: 'feature_disabled' }, 404),
    })
    const { ctx } = await testContext({ store: t.store, fetch })
    const error = await captureError(runFactsReview(ctx))
    expect(error.message).toMatch(/not turned on/)
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
  })

  it('prefer posts the action and reports what changed with it', async () => {
    const t = await setup()
    const { fetch, calls } = mockFetch({
      [`/api/knowledge/facts/${FACT}/review`]: () =>
        jsonResponse({
          fact: fact(FACT, { state: 'accepted' }),
          affected: [fact(OTHER, { state: 'rejected' })],
        }),
    })
    const { ctx, out } = await testContext({ store: t.store, fetch })
    await runFactsSettle(ctx, 'prefer', FACT)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ action: 'prefer' })
    expect(out.content()).toContain(
      'monthly_fee_gbp is now accepted (1 other fact changed with it)'
    )
  })
})

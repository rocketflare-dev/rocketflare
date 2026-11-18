/**
 * The reranker seam (`services/ai/rerank.ts`, lifted from the global-search plugin): the
 * Cohere-style client and `applyRerank` against a fake `fetch`, and the Workers AI client against
 * a fake binding — no vendor is called. Proved:
 * each dialect's request carries only the fields that vendor takes (Voyage's `top_k`, Fireworks'
 * `return_documents: false`); each response shape (Cohere `results[]`, Voyage / Fireworks
 * `data[]`) parses to the same best-first scores; a vendor failure is a classified `RerankError`,
 * never its body; and applying one reorders the head, keeps the tail and a dropped document in
 * fused order, and on a timeout, an error or no reranker returns the list UNCHANGED with the reason;
 * Workers AI's logits are sigmoided onto [0, 1] and a vendor's probabilities are kept as they are.
 */
import { describe, expect, it } from 'vitest'
import {
  applyRerank,
  createRerankClient,
  createWorkersAiRerankClient,
  parseRerankResponse,
  parseWorkersAiRerank,
  type RerankClient,
  RerankError,
  rerankBody,
  rerankDialect,
  rerankFnOf,
  toUnitScores,
} from '@/api/services/ai/rerank'

const COHERE = 'https://api.cohere.com/v2'
const VOYAGE = 'https://api.voyageai.com/v1'
const FIREWORKS = 'https://api.fireworks.ai/inference/v1'

function fakeFetch(answer: (url: string, body: Record<string, unknown>) => Response) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url, body, auth: new Headers(init.headers).get('authorization') })
    return answer(url, body)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('dialects', () => {
  it('reads the dialect from the host, never a look-alike path', () => {
    expect(rerankDialect(COHERE)).toBe('cohere')
    expect(rerankDialect(VOYAGE)).toBe('voyage')
    expect(rerankDialect(FIREWORKS)).toBe('fireworks')
    expect(rerankDialect('https://proxy.example/voyageai.com/v1')).toBe('cohere')
    expect(rerankDialect('not a url')).toBe('cohere')
  })

  it('sends only the fields each vendor takes', () => {
    expect(rerankBody(COHERE, 'rerank-v3.5', 'q', ['a'], 3)).toEqual({
      model: 'rerank-v3.5',
      query: 'q',
      documents: ['a'],
      top_n: 3,
    })
    expect(rerankBody(VOYAGE, 'rerank-2.5-lite', 'q', ['a'], 3)).toEqual({
      model: 'rerank-2.5-lite',
      query: 'q',
      documents: ['a'],
      top_k: 3,
    })
    // Fireworks refuses unknown fields and returns the documents unless told not to.
    expect(rerankBody(FIREWORKS, 'fireworks/qwen3-reranker-8b', 'q', ['a'], 3)).toEqual({
      model: 'fireworks/qwen3-reranker-8b',
      query: 'q',
      documents: ['a'],
      top_n: 3,
      return_documents: false,
    })
    expect(rerankBody(COHERE, 'm', 'q', ['a'])).not.toHaveProperty('top_n')
  })

  it('parses Cohere, Voyage and Fireworks answers to the same best-first scores', () => {
    const cohere = parseRerankResponse(
      {
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.2 },
        ],
      },
      2
    )
    const voyage = parseRerankResponse(
      {
        data: [
          { index: 0, relevance_score: 0.2 },
          { index: 1, relevance_score: 0.9 },
        ],
        usage: { total_tokens: 41 },
      },
      2
    )
    const fireworks = parseRerankResponse(
      {
        data: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.2 },
        ],
        usage: { prompt_tokens: 40, total_tokens: 41 },
      },
      2
    )
    const order = [
      { index: 1, score: 0.9 },
      { index: 0, score: 0.2 },
    ]
    expect(cohere.results).toEqual(order)
    expect(voyage.results).toEqual(order)
    expect(fireworks.results).toEqual(order)
    expect(voyage.inputTokens).toBe(41)
    // Cohere bills search units, not tokens: null, so the meter estimates from the text.
    expect(cohere.inputTokens).toBeNull()
  })

  it('drops an entry it cannot place (out of range, duplicated, no score)', () => {
    const out = parseRerankResponse(
      {
        results: [
          { index: 5, relevance_score: 1 },
          { index: 0, relevance_score: 0.5 },
          { index: 0, relevance_score: 0.4 },
          { index: 1 },
        ],
      },
      2
    )
    expect(out.results).toEqual([{ index: 0, score: 0.5 }])
  })
})

describe('the client', () => {
  it('posts to {base}/rerank with the bearer key and the dialect body', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      Response.json({ data: [{ index: 0, relevance_score: 0.7 }], usage: { total_tokens: 9 } })
    )
    const client = createRerankClient({
      model: 'rerank-2.5-lite',
      apiKey: 'voyage-key',
      baseUrl: `${VOYAGE}/`,
      fetch: fetchImpl,
    })
    const out = await client.rerank('orders', ['one', 'two'], { topN: 1 })
    expect(calls[0]?.url).toBe(`${VOYAGE}/rerank`)
    expect(calls[0]?.auth).toBe('Bearer voyage-key')
    expect(calls[0]?.body).toMatchObject({ top_k: 1, documents: ['one', 'two'] })
    expect(out.results).toEqual([{ index: 0, score: 0.7 }])
  })

  it('turns a vendor failure into a classified RerankError without its body', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response('{"message":"invalid api key sk-live-abcdef0123456789"}', { status: 401 })
    )
    const client = createRerankClient({
      model: 'rerank-v3.5',
      apiKey: 'k',
      baseUrl: COHERE,
      fetch: fetchImpl,
    })
    const err = await client.rerank('q', ['a']).catch(e => e)
    expect(err).toBeInstanceOf(RerankError)
    expect((err as RerankError).code).toBe('auth')
    expect((err as RerankError).message).not.toContain('sk-live-abcdef0123456789')
  })

  it('classifies a rate limit and an outage', async () => {
    for (const [status, code] of [
      [429, 'rate_limited'],
      [503, 'unavailable'],
      [422, 'invalid_request'],
    ] as const) {
      const { fetchImpl } = fakeFetch(() => new Response('nope', { status }))
      const client = createRerankClient({
        model: 'm',
        apiKey: 'k',
        baseUrl: COHERE,
        fetch: fetchImpl,
      })
      const err = (await client.rerank('q', ['a']).catch(e => e)) as RerankError
      expect(err.code).toBe(code)
    }
  })

  it('refuses to build without a key, a base URL or a model', () => {
    const base = { model: 'm', apiKey: 'k', baseUrl: COHERE }
    expect(() => createRerankClient({ ...base, apiKey: '' })).toThrow(RerankError)
    expect(() => createRerankClient({ ...base, baseUrl: '' })).toThrow(RerankError)
    expect(() => createRerankClient({ ...base, model: '' })).toThrow(RerankError)
  })
})

/** A re-ranker that scores each document by `score(text)`, or behaves as `mode` says. */
function stubReranker(
  score: (text: string) => number,
  mode: 'ok' | 'fail' | 'hang' | 'deaf' = 'ok',
  sent: string[][] = []
): RerankClient {
  return {
    model: 'stub-rerank',
    async rerank(_q, documents, options) {
      sent.push([...documents])
      if (mode === 'fail') throw new RerankError('unavailable', 'down', 503)
      if (mode === 'hang') {
        await new Promise((_, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        )
      }
      // Ignores the signal entirely: the budget must still hold.
      if (mode === 'deaf') await new Promise(() => {})
      const results = documents
        .map((d, index) => ({ index, score: score(d) }))
        .filter(r => r.score >= 0)
        .sort((a, b) => b.score - a.score)
      return { results: toUnitScores(results), inputTokens: 5 }
    },
  }
}

describe('applyRerank', () => {
  const items = ['a', 'b', 'c', 'd', 'e']

  it('reorders the head, keeps a dropped item and the tail in fused order, and places each', async () => {
    // Scores: c best, then a; b is dropped (negative = not returned); d, e are past the head.
    const scores: Record<string, number> = { a: 0.5, b: -1, c: 0.9 }
    const out = await applyRerank(
      stubReranker(t => scores[t] ?? -1),
      'q',
      items,
      t => t,
      { candidates: 3 }
    )
    expect(out.items).toEqual(['c', 'a', 'b', 'd', 'e'])
    expect(out.outcome).toMatchObject({ applied: true, model: 'stub-rerank' })
    expect(out.placements.get('c')).toEqual({ score: 0.9, before: 3, after: 1 })
    expect(out.placements.get('a')).toEqual({ score: 0.5, before: 1, after: 2 })
    expect(out.placements.has('b')).toBe(false)
  })

  it('keeps the fused order, unchanged, and says why: none, failure, timeout, too few', async () => {
    const none = await applyRerank(null, 'q', items, t => t)
    expect(none.items).toEqual(items)
    expect(none.outcome).toEqual({ applied: false, reason: 'not_configured' })

    const failed = await applyRerank(
      stubReranker(() => 1, 'fail'),
      'q',
      items,
      t => t
    )
    expect(failed.items).toEqual(items)
    expect(failed.outcome).toMatchObject({ applied: false, reason: 'error', model: 'stub-rerank' })

    const slow = await applyRerank(
      stubReranker(() => 1, 'hang'),
      'q',
      items,
      t => t,
      {
        timeoutMs: 20,
      }
    )
    expect(slow.items).toEqual(items)
    expect(slow.outcome).toMatchObject({ applied: false, reason: 'timeout' })

    const deaf = await applyRerank(
      stubReranker(() => 1, 'deaf'),
      'q',
      items,
      t => t,
      {
        timeoutMs: 20,
      }
    )
    expect(deaf.outcome).toMatchObject({ applied: false, reason: 'timeout' })

    const sent: string[][] = []
    const one = await applyRerank(
      stubReranker(() => 1, 'ok', sent),
      'q',
      ['only'],
      t => t
    )
    expect(one.outcome).toMatchObject({ applied: false, reason: 'too_few' })
    expect(sent).toEqual([])
  })
})

describe('scores on one scale', () => {
  it('keeps probabilities and sigmoids logits, preserving the order', () => {
    const probs = [
      { index: 0, score: 0.9 },
      { index: 1, score: 0.1 },
    ]
    expect(toUnitScores(probs)).toBe(probs)
    const logits = toUnitScores([
      { index: 0, score: 4.2 },
      { index: 1, score: -3 },
      { index: 2, score: 0 },
    ])
    expect(logits.map(r => r.index)).toEqual([0, 1, 2])
    expect(logits[0]?.score).toBeCloseTo(0.985, 3)
    expect(logits[1]?.score).toBeCloseTo(0.047, 3)
    expect(logits[2]?.score).toBe(0.5)
    expect(logits.every(r => r.score >= 0 && r.score <= 1)).toBe(true)
  })

  it('reads a self-hosted logit answer onto [0, 1] too', () => {
    const out = parseRerankResponse(
      {
        results: [
          { index: 0, score: -2 },
          { index: 1, score: 3 },
        ],
      },
      2
    )
    expect(out.results.map(r => r.index)).toEqual([1, 0])
    expect(out.results.every(r => r.score > 0 && r.score < 1)).toBe(true)
  })
})

describe('the Workers AI reranker', () => {
  function fakeAi(answer: (inputs: Record<string, unknown>) => unknown) {
    const runs: { model: string; inputs: Record<string, unknown> }[] = []
    return {
      runs,
      ai: {
        async run(model: string, inputs: Record<string, unknown>) {
          runs.push({ model, inputs })
          return answer(inputs)
        },
      } as never,
    }
  }

  it('sends query + contexts to bge-reranker-base and reads { response: [{ id, score }] } best first', async () => {
    const { ai, runs } = fakeAi(() => ({
      response: [
        { id: 0, score: -4.1 },
        { id: 1, score: 2.3 },
      ],
    }))
    const client = createWorkersAiRerankClient({ ai })
    expect(client.model).toBe('@cf/baai/bge-reranker-base')
    const out = await client.rerank('sky colour', ['invoices are due', 'the sky is blue'])
    expect(runs[0]).toEqual({
      model: '@cf/baai/bge-reranker-base',
      inputs: {
        query: 'sky colour',
        contexts: [{ text: 'invoices are due' }, { text: 'the sky is blue' }],
      },
    })
    expect(out.results.map(r => r.index)).toEqual([1, 0])
    expect(out.results[0]?.score).toBeGreaterThan(0.9)
    // Workers AI reports no tokens: the meter estimates.
    expect(out.inputTokens).toBeNull()
    // The bare seam answers the same scores.
    expect(await rerankFnOf(client)('sky colour', ['a', 'b'])).toHaveLength(2)
  })

  it('is a RerankError on a binding failure, an odd shape or a stall — never a hang', async () => {
    const failing = createWorkersAiRerankClient({
      ai: fakeAi(() => {
        throw new Error('5006: bad input')
      }).ai,
    })
    expect(await failing.rerank('q', ['a', 'b']).catch(e => e)).toBeInstanceOf(RerankError)
    expect(() => parseWorkersAiRerank({ data: [] }, 2)).toThrow(RerankError)
    const stalled = createWorkersAiRerankClient({
      ai: { run: () => new Promise(() => {}) } as never,
      timeoutMs: 20,
    })
    expect(await stalled.rerank('q', ['a', 'b']).catch(e => e)).toBeInstanceOf(RerankError)
  })

  it('refuses to build without the binding', () => {
    expect(() => createWorkersAiRerankClient({ ai: undefined })).toThrow(RerankError)
  })
})

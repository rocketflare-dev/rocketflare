/**
 * The reranker seam. A reranker reads the query and each candidate passage TOGETHER (a
 * cross-encoder) and scores how well the passage answers it — what neither a vector nor a keyword
 * match can judge. `searchChunks` hands it the head of the RRF-fused list and keeps its order.
 *
 * **The seam is `RerankFn`**: `(query, documents) => Promise<RerankScore[]>`, best first, each
 * `{ index, score }` with `score` in [0, 1]. `RerankClient` is a `RerankFn` with the model it runs
 * and the tokens it billed; `resolveRerank` (`resolve.ts`) is the only place one is chosen.
 *
 * Two clients:
 *
 * - **Workers AI** (`createWorkersAiRerankClient`): `@cf/baai/bge-reranker-base` through
 *   `env.AI.run({ query, contexts: [{ text }] })` → `{ response: [{ id, score }] }`. The model's
 *   scores are logits ("mapped to [0, 1] by a sigmoid", its catalog entry says), so a batch with
 *   any score outside [0, 1] is sigmoided whole. `env.AI.run` cannot be aborted, so the call is
 *   raced against a deadline like every other Workers AI call.
 * - **Cohere-style HTTP** (`createRerankClient`): `POST {base}/rerank` behind a bearer key, the
 *   dialect from the base URL's HOST (`rerankDialect`):
 *
 * | dialect   | cap field | results     | usage                                   |
 * |-----------|-----------|-------------|-----------------------------------------|
 * | cohere    | `top_n`   | `results[]` | `meta.billed_units` (search units — no tokens) |
 * | voyage    | `top_k`   | `data[]`    | `usage.total_tokens`                    |
 * | fireworks | `top_n`   | `data[]`    | `usage.prompt_tokens` / `total_tokens`; unknown fields refused, document text returned unless `return_documents: false` |
 *
 * Each result is `{ index, relevance_score }` in all three (a self-hosted server answering `score`
 * is read too). Errors are `RerankError`s classified from the status, never carrying the vendor's
 * body (it may echo the key). `applyRerank` reorders a list within a time budget and NEVER throws:
 * no reranker, too few items, a timeout or a failure leaves the list unchanged and says why.
 *
 * Lifted from the global-search plugin, which will call this seam instead of its own copy.
 */
import { WORKERS_AI_RERANK_MODEL } from '@rocketflare/shared/ai/config'
import { traceStep } from '../../observability/context'
import { rerankAttributes } from '../../observability/genai-attributes'
import { withDeadline } from './client'
import type { AiEnv } from './types'

/** How many fused candidates a search hands the reranker. */
export const RERANK_CANDIDATES = 20
/**
 * How long a search waits for the reranker before answering in fused order. A cross-encoder over
 * 50 passages is ~100 ms on Workers AI and a few hundred ms to ~1 s over HTTP (measured on the
 * fixture: `docs/EVALS.md`); past this the reader gets the unreranked list rather than a stall.
 */
export const RERANK_TIMEOUT_MS = 3000
/** Characters of each candidate sent to the reranker — a chunk is ~3 200; titles ride in front. */
export const RERANK_DOCUMENT_MAX_CHARS = 4000

/** One scored candidate: its index in the documents handed in, and a relevance score in [0, 1]. */
export interface RerankScore {
  index: number
  score: number
}

/** THE seam: score `documents` against `query`, best first. Scores are in [0, 1]. */
export type RerankFn = (
  query: string,
  documents: readonly string[],
  options?: { topN?: number; signal?: AbortSignal }
) => Promise<RerankScore[]>

export interface RerankResult {
  results: RerankScore[]
  /** Tokens billed when the vendor reports them; null = not reported (estimate from the text). */
  inputTokens: number | null
}

export interface RerankClient {
  readonly model: string
  rerank(
    query: string,
    documents: readonly string[],
    options?: { topN?: number; signal?: AbortSignal }
  ): Promise<RerankResult>
}

/** A `RerankClient` as the bare seam. */
export const rerankFnOf =
  (client: RerankClient): RerankFn =>
  async (query, documents, options) =>
    (await client.rerank(query, documents, options)).results

export type RerankDialect = 'cohere' | 'voyage' | 'fireworks'

/** The dialect from the base URL's HOST — never a look-alike path. */
export function rerankDialect(baseUrl: string | null | undefined): RerankDialect {
  let host = ''
  try {
    host = baseUrl ? new URL(baseUrl).hostname.toLowerCase() : ''
  } catch {
    host = ''
  }
  if (host === 'voyageai.com' || host.endsWith('.voyageai.com')) return 'voyage'
  if (host === 'fireworks.ai' || host.endsWith('.fireworks.ai')) return 'fireworks'
  return 'cohere'
}

export type RerankErrorCode = 'auth' | 'rate_limited' | 'invalid_request' | 'unavailable'

/** A reranker failure, classified. The message never carries the vendor's response body. */
export class RerankError extends Error {
  constructor(
    readonly code: RerankErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'RerankError'
  }
}

function classify(status: number): RerankErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limited'
  if (status >= 400 && status < 500) return 'invalid_request'
  return 'unavailable'
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

/**
 * Scores onto [0, 1]: a batch already inside it is kept (Cohere, Voyage, Fireworks answer
 * probabilities); a batch with any score outside it is LOGITS (a raw cross-encoder — Workers AI's
 * BGE, a self-hosted server) and every score is sigmoided, so the order is kept and a threshold
 * reads the same whichever reranker answered.
 */
export function toUnitScores(results: RerankScore[]): RerankScore[] {
  if (results.every(r => r.score >= 0 && r.score <= 1)) return results
  return results.map(r => ({ index: r.index, score: sigmoid(r.score) }))
}

interface RerankWireResult {
  index?: unknown
  relevance_score?: unknown
  score?: unknown
}

export interface RerankWireResponse {
  results?: RerankWireResult[]
  data?: RerankWireResult[]
  usage?: { total_tokens?: unknown; prompt_tokens?: unknown }
  meta?: { tokens?: { input_tokens?: unknown } }
}

/** The request body for a dialect — only fields that dialect accepts (Fireworks refuses others). */
export function rerankBody(
  baseUrl: string | null | undefined,
  model: string,
  query: string,
  documents: readonly string[],
  topN?: number
): Record<string, unknown> {
  const dialect = rerankDialect(baseUrl)
  const body: Record<string, unknown> = { model, query, documents: [...documents] }
  if (topN !== undefined) body[dialect === 'voyage' ? 'top_k' : 'top_n'] = topN
  if (dialect === 'fireworks') body.return_documents = false
  return body
}

/** Results best first, from any of the three shapes; an entry with no usable index is dropped. */
export function parseRerankResponse(json: RerankWireResponse, count: number): RerankResult {
  const raw = json.results ?? json.data ?? []
  const results: RerankScore[] = []
  const seen = new Set<number>()
  for (const r of Array.isArray(raw) ? raw : []) {
    const index = num(r?.index)
    const score = num(r?.relevance_score) ?? num(r?.score)
    if (index === null || score === null || index < 0 || index >= count || seen.has(index)) continue
    seen.add(index)
    results.push({ index, score })
  }
  const unit = toUnitScores(results)
  unit.sort((a, b) => b.score - a.score || a.index - b.index)
  const tokens =
    num(json.usage?.total_tokens) ??
    num(json.usage?.prompt_tokens) ??
    num(json.meta?.tokens?.input_tokens)
  return { results: unit, inputTokens: tokens }
}

export interface RerankClientOptions {
  baseUrl: string | null | undefined
  model: string
  apiKey: string | null | undefined
  fetch?: typeof fetch
}

/** Unbound `fetch` throws "Illegal invocation" on Workers once it is called as a method. */
const outboundFetch: typeof fetch = (input, init) => fetch(input, init)

/** A Cohere-style `POST {base}/rerank` client (Cohere, Voyage, Fireworks, any compatible server). */
export function createRerankClient(opts: RerankClientOptions): RerankClient {
  if (!opts.apiKey) throw new RerankError('auth', 'An API key is required')
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '')
  if (!base) throw new RerankError('invalid_request', 'A base URL is required')
  if (!opts.model) throw new RerankError('invalid_request', 'A rerank model is required')
  const { apiKey, model } = opts
  const fetchImpl = opts.fetch ?? outboundFetch
  return {
    model,
    async rerank(query, documents, options = {}) {
      if (documents.length === 0) return { results: [], inputTokens: 0 }
      let res: Response
      try {
        res = await fetchImpl(`${base}/rerank`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(rerankBody(base, model, query, documents, options.topN)),
          signal: options.signal,
        })
      } catch (err) {
        if (options.signal?.aborted) throw err
        throw new RerankError('unavailable', 'The reranker could not be reached')
      }
      if (!res.ok) {
        // Drain without reading it into the message: a vendor body may echo the key.
        await res.body?.cancel().catch(() => {})
        throw new RerankError(
          classify(res.status),
          `The reranker answered ${res.status}`,
          res.status
        )
      }
      let json: RerankWireResponse
      try {
        json = (await res.json()) as RerankWireResponse
      } catch {
        throw new RerankError('unavailable', 'The reranker answered something that is not JSON')
      }
      return parseRerankResponse(json ?? {}, documents.length)
    },
  }
}

interface WorkersAiRerankBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>
}

/** Workers AI answers `{ response: [{ id, score }] }`; read into the shared shape. */
export function parseWorkersAiRerank(out: unknown, count: number): RerankResult {
  const response = (out as { response?: unknown } | null)?.response
  if (!Array.isArray(response)) {
    throw new RerankError('unavailable', 'Unexpected Workers AI rerank response shape')
  }
  return parseRerankResponse(
    {
      results: response.map(r => ({
        index: (r as { id?: unknown })?.id,
        score: (r as { score?: unknown })?.score,
      })),
    },
    count
  )
}

/**
 * Workers AI's reranker through the binding. `env.AI.run` takes no signal, so the call is raced
 * against `timeoutMs` (and the caller's signal) — waiting stops, the call itself runs on.
 * Workers AI reports no tokens: `inputTokens` is null and the meter estimates from the text.
 */
export function createWorkersAiRerankClient(opts: {
  ai: AiEnv['AI']
  model?: string
  timeoutMs?: number
}): RerankClient {
  const ai = opts.ai as WorkersAiRerankBinding | undefined
  if (!ai) throw new RerankError('unavailable', 'The AI binding is not configured')
  const model = opts.model || WORKERS_AI_RERANK_MODEL
  const timeoutMs = opts.timeoutMs ?? RERANK_TIMEOUT_MS
  return {
    model,
    async rerank(query, documents, options = {}) {
      if (documents.length === 0) return { results: [], inputTokens: 0 }
      const inputs: Record<string, unknown> = {
        query,
        // The schema refuses an empty context (`minLength: 1`).
        contexts: documents.map(text => ({ text: text || ' ' })),
      }
      if (options.topN !== undefined) inputs.top_k = options.topN
      let out: unknown
      try {
        out = await withDeadline(ai.run(model, inputs), timeoutMs, options.signal)
      } catch (err) {
        if (options.signal?.aborted) throw err
        throw new RerankError('unavailable', 'Workers AI did not rerank')
      }
      return { ...parseWorkersAiRerank(out, documents.length), inputTokens: null }
    },
  }
}

// ---- Applying a reranker ------------------------------------------------------------------------

/** Why a list was answered in its fused order. `disabled` = the caller asked for no reranking. */
export type RerankSkipReason = 'not_configured' | 'disabled' | 'too_few' | 'timeout' | 'error'

export interface RerankOutcome {
  applied: boolean
  model?: string
  reason?: RerankSkipReason
  latencyMs?: number
  /** What the reranker billed, when it said (null = estimate from the text sent). */
  inputTokens?: number | null
  /** The texts sent, for the meter's estimate. */
  sentChars?: number
}

/** One item's rerank facts: its score and its 1-based position before and after. */
export interface RerankPlacement {
  score: number
  before: number
  after: number
}

export interface ApplyRerankOptions {
  timeoutMs?: number
  candidates?: number
}

/**
 * Rerank `items` (already in fused order) by `query`: the first `candidates` are sent with
 * `textOf(item)`, reordered by the reranker's score, and followed by any it dropped and then the
 * rest — all in their fused order. Never throws: no reranker, a timeout or a provider failure
 * returns the items UNCHANGED with `applied: false` and the reason. Traced as `rerank <model>`.
 */
export async function applyRerank<T>(
  client: RerankClient | null,
  query: string,
  items: readonly T[],
  textOf: (item: T) => string,
  options: ApplyRerankOptions = {}
): Promise<{ items: T[]; placements: Map<T, RerankPlacement>; outcome: RerankOutcome }> {
  const unchanged = (outcome: RerankOutcome) => ({
    items: [...items],
    placements: new Map<T, RerankPlacement>(),
    outcome,
  })
  if (!client) return unchanged({ applied: false, reason: 'not_configured' })
  const model = client.model
  if (items.length < 2) return unchanged({ applied: false, reason: 'too_few', model })
  const head = items.slice(0, options.candidates ?? RERANK_CANDIDATES)
  const tail = items.slice(head.length)
  const texts = head.map(item => textOf(item).slice(0, RERANK_DOCUMENT_MAX_CHARS))
  const sentChars = query.length + texts.reduce((n, t) => n + t.length, 0)
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? RERANK_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('rerank timeout'))
    }, timeoutMs)
  })
  const startedAt = Date.now()
  try {
    const { results, inputTokens } = await Promise.race([
      traceStep(
        {
          name: `rerank ${model}`,
          kind: 'retrieval',
          input: { query, count: head.length },
          attributes: rerankAttributes({ model, candidates: head.length }),
        },
        () => client.rerank(query, texts, { signal: controller.signal }),
        r => ({ output: { scored: r.results.length, top: r.results.slice(0, 5) } })
      ),
      deadline,
    ])
    const scored = results.filter(r => r.index < head.length)
    const picked = new Set(scored.map(r => r.index))
    const order = [
      ...scored.map(r => ({ index: r.index, score: r.score as number | null })),
      ...head.map((_, index) => ({ index, score: null })).filter(e => !picked.has(e.index)),
    ]
    const placements = new Map<T, RerankPlacement>()
    const reordered = order.map((entry, position) => {
      const item = head[entry.index] as T
      if (entry.score !== null) {
        placements.set(item, { score: entry.score, before: entry.index + 1, after: position + 1 })
      }
      return item
    })
    return {
      items: [...reordered, ...tail],
      placements,
      outcome: {
        applied: true,
        model,
        latencyMs: Date.now() - startedAt,
        inputTokens,
        sentChars,
      },
    }
  } catch {
    return unchanged({
      applied: false,
      reason: controller.signal.aborted ? 'timeout' : 'error',
      model,
      latencyMs: Date.now() - startedAt,
      // A failed or abandoned call may still have been billed; the meter records an estimate.
      inputTokens: null,
      sentChars,
    })
  } finally {
    clearTimeout(timer)
  }
}

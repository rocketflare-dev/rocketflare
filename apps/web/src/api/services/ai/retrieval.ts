/**
 * Hybrid retrieval over `chunks`: dense cosine (`<=>` on the pgvector HNSW index) +
 * Postgres full-text (ANY query term — `anyTermTsquery` — matched and ranked by `ts_rank_cd`
 * against `chunks.search_vector`, the GENERATED tsvector over heading path + table header + text,
 * GIN-indexed — nothing is computed per query), fused by Reciprocal Rank Fusion (`RRF_K = 60`).
 * Each dense leg reads only the chunks whose `embedding_model` is the query vector's model — a
 * vector from another model is noise — so a document embedded by an older model is found lexically
 * until it is re-embedded. Each signal retrieves a wide candidate pool, the fusion decides the
 * order, the top `limit` come back with `denseRank`/`lexicalRank` so "did the vector search find
 * this or only the keyword one?" is answerable. Each hit also says WHERE in its document it sits —
 * `seq` (passage n of `documentPassages`), `headingPath`, `page`, and `charOffset`, the passage's
 * position in `documents.content`, so a reader can jump straight there with `get_document`. The
 * offset is the stored `chunks.char_start` (exact: the chunk is that slice of the text); a row
 * written before 0.37.0 has none and falls back to `position()` of its text, approximate by
 * construction (first occurrence, Postgres characters against JS's UTF-16). The tenant predicate
 * is on EVERY query; `documentId` and `filters` (source, content type, date added —
 * `documentFilterPredicate`) narrow further, ANDed with it and with the visibility predicate.
 *
 * **Reranking** (`rerank.ts`): the top `RERANK_CANDIDATES` (config, default 20) fused candidates go to the reranker
 * `resolveRerank` picks (the tenant's `rerank` row → Workers AI bge-reranker-base → none), are
 * reordered by its score (`rerankScore`, 0–1), filtered by `RERANK_MIN_SCORE` when that is set,
 * then cut to `limit`. No reranker, fewer than two candidates, `rerank: false`, a failure or a
 * timeout all answer the fused order — the retrieval span says which.
 *
 * **Metering**: the query embedding(s) and the rerank call are `ai_usage` rows
 * (`knowledge.embeddings`, `knowledge.rerank`), written alongside the passage lookup or through
 * the caller's `defer`, never able to fail the search.
 */
import type {
  SearchFilters,
  SearchHit,
  SearchLexical,
  SearchRequest,
} from '@rocketflare/shared/ai/embeddings'
import { KNOWLEDGE_USAGE_FEATURES } from '@rocketflare/shared/ai/usage'
import { and, eq, gte, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import { type Database, rows } from '../../../db/client'
import { chunks, documents } from '../../../db/schema'
import { traceEmbed, traceStep } from '../../observability/context'
import { rerankOutcomeAttributes } from '../../observability/genai-attributes'
import { type AccessScope, visibleDocuments } from '../access'
import { CHARS_PER_TOKEN } from './chunking'
import { AiNotConfiguredError } from './errors'
import { anyTermTsquery, candidatePoolSize, type FusedItem, fuseDenseLegs } from './fusion'
import { applyRerank, RERANK_CANDIDATES, type RerankOutcome } from './rerank'
import {
  type ResolvedEmbeddings,
  type ResolvedRerank,
  resolveEmbeddings,
  resolvePlatformEmbeddings,
  resolveRerank,
} from './resolve'
import type { AiEnv } from './types'
import { embedCounted, type KnowledgeUsageInput, recordKnowledgeUsage } from './usage'

export {
  anyTermTsquery,
  candidatePoolSize,
  type FusedItem,
  fuseByRank,
  fuseDenseLegs,
  LEXICAL_MAX_TERMS,
  RRF_K,
} from './fusion'

/**
 * Text-search configuration the lexical half indexes and queries with. The generated
 * `chunks.search_vector` spells it as a literal (a schema cannot import a service);
 * `tests/config/search-text-config.test.ts` fails when the two disagree.
 */
export const SEARCH_TEXT_CONFIG = 'english'

/**
 * Where a passage sits in its document, 1-based and 0 when absent, mapped to a 0-based offset or
 * null by the caller: the stored `char_start` + 1 when the row has one, else (a row written before
 * 0.37.0) `position()` of the chunk's text in `documents.content`. Exported so `locateChunks` here and `listDocumentPassages`
 * (`document-content.ts`) share ONE expression — a search hit and the passage list disagreeing
 * about where a passage starts is a deep link that lands in the wrong place. Both queries join
 * `chunks` to `documents`.
 */
export const chunkCharOffsetSql = sql<number>`coalesce(${chunks.charStart} + 1, position(${chunks.text} in coalesce(${documents.content}, '')))`

/** pgvector's text literal for a vector parameter: `[0.1,0.2,…]`. */
export function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}

interface Candidate {
  id: string
  documentId: string
  title: string
  text: string
  seq: number
  headingPath: string | null
  page: number | null
  source: string | null
  externalId: string | null
  /** Null = a PLATFORM chunk. */
  tenantId: string | null
}

/**
 * What `searchChunks` / `searchKnowledgeChunks` accept beyond the HTTP contract. Neither extra is
 * reachable from a request body: the `/search` route validates `searchRequestSchema` and passes
 * exactly that, so a client can never widen its own search onto the platform corpus.
 */
export interface SearchChunksRequest extends SearchRequest {
  /**
   * Narrow the TENANT corpus to documents whose `source` is one of these. Absent = every source;
   * `[]` = no tenant documents at all (a platform-only search, which then needs no tenant embedder).
   */
  sources?: readonly string[]
  /**
   * Also search the PLATFORM corpus (`documents.tenant_id IS NULL`) for these sources. Platform
   * chunks are matched against a query vector from the PLATFORM embedder
   * (`resolvePlatformEmbeddings`), never the tenant's: when the two models differ the query is
   * embedded once per model and each corpus gets its own dense leg, fused with the lexical leg by
   * the same RRF. A platform document embedded by a model other than today's platform one is
   * left out of the dense leg (its vectors would be noise) and still found lexically.
   */
  platformSources?: readonly string[]
  /** Checked between the embed and the queries; an aborted search throws its reason. */
  signal?: AbortSignal
  /**
   * `false` = answer in fused order without calling a reranker — for a caller that must not pay
   * for one (a bulk or internal search). Absent = rerank when a reranker resolves. Never read
   * from an HTTP body: `searchRequestSchema` has no such field.
   */
  rerank?: boolean
  /**
   * Where the usage write goes: a route passes its `defer` (`waitUntil`) so the response never
   * waits on the ledger. Absent = written alongside the passage lookup and awaited with it.
   */
  defer?: (write: () => Promise<unknown>) => void
}

/** A hit, with where it came from. `platform` = a tenant-less platform document. */
export interface KnowledgeChunkHit extends SearchHit {
  source: string | null
  externalId: string | null
  platform: boolean
}

export interface KnowledgeChunkSearch {
  hits: KnowledgeChunkHit[]
  /**
   * `used` = every corpus searched had a dense leg; `unavailable` = at least one was searched by
   * keyword alone (no embedder for it), so a paraphrase may have been missed.
   */
  semantic: 'used' | 'unavailable'
  /**
   * `no_terms` = the keyword leg had nothing to look for: every word of the query is a stopword
   * of `SEARCH_TEXT_CONFIG` (Postgres decides, `numnode(to_tsquery(…)) = 0`), or there was no word.
   */
  lexical: SearchLexical
  /** Whether a reranker ordered the hits, on which model, how long it took — or why not. */
  rerank: SearchRerankOutcome
}

export interface SearchRerankOutcome
  extends Pick<RerankOutcome, 'applied' | 'model' | 'reason' | 'latencyMs'> {
  /** Reranked hits dropped by `RERANK_MIN_SCORE`. */
  dropped?: number
}

/**
 * Hybrid search, scoped to what this reader may SEE. `access` carries the tenant, so there
 * is no separate `tenantId` argument to keep in step with it; the visibility predicate is ANDed
 * with the tenant predicate on both halves, never substituted for it.
 *
 * **Recall under a restrictive scope.** The dense half orders by `<=>` over the HNSW index and
 * takes the first `pool` rows that ALSO satisfy the predicate. An approximate index can exhaust
 * its candidate list before filling that pool, so a reader who may see one document out of a
 * thousand could get an empty dense half while the lexical half carries the whole result.
 * `hnsw.iterative_scan = relaxed_order` (pgvector ≥ 0.8) is the fix, and it is set `LOCAL` in a
 * transaction around the vector scan ALONE — only when a predicate is actually in play, so an
 * admin's search still costs one statement. A server whose pgvector predates the setting treats
 * `hnsw.iterative_scan` as a custom GUC placeholder and accepts it, which is why this is safe to
 * set unconditionally rather than probing the version.
 *
 * No tenant embeddings provider → `AiNotConfiguredError` (503), as it always has been. The
 * platform corpus (`platformSources`) is opt-in and never changes the answer when absent.
 */
export async function searchChunks(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  access: AccessScope,
  request: SearchChunksRequest
): Promise<SearchHit[]> {
  const { hits } = await searchKnowledgeChunks(db, cfg, env, access, request)
  return hits.map(({ source: _s, externalId: _e, platform: _p, ...hit }) => hit)
}

/**
 * `searchChunks` with provenance (`source`, `externalId`, `platform`) and the `semantic` report.
 * `lexicalFallback: true` turns a missing TENANT embedder into a keyword-only tenant leg
 * (`semantic: 'unavailable'`) instead of the 503 — for a caller such as a global search box that
 * should still answer something.
 */
export function searchKnowledgeChunks(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  access: AccessScope,
  request: SearchChunksRequest,
  options: { lexicalFallback?: boolean } = {}
): Promise<KnowledgeChunkSearch> {
  // A `retrieval` span under whatever is active (the `search_knowledge` tool span), with the
  // query embedding nested inside it. The hits are summarised — the passages are the TOOL's output.
  return traceStep(
    {
      name: 'retrieval search_chunks',
      kind: 'retrieval',
      input: {
        query: request.query,
        limit: request.limit ?? 10,
        documentId: request.documentId,
        ...(request.filters ? { filters: request.filters } : {}),
        ...(request.sources ? { sources: request.sources } : {}),
        ...(request.platformSources?.length ? { platformSources: request.platformSources } : {}),
      },
    },
    () => runSearch(db, cfg, env, access, request, options),
    result => ({
      output: result.hits.map(h => ({
        documentId: h.documentId,
        title: h.title,
        seq: h.seq,
        score: h.score,
      })),
      attributes: {
        'rocketflare.retrieval.hits': result.hits.length,
        ...rerankOutcomeAttributes(result.rerank),
      },
    })
  )
}

interface QueryVector {
  model: string
  provider: string
  literal: string
}

/**
 * Embed the query with one resolved embedder; null when it answered no vector. Pushes what the
 * call cost onto `usage` (a `knowledge.embeddings` row once the search is done).
 */
async function embedQuery(
  embeddings: Pick<ResolvedEmbeddings, 'client' | 'model' | 'provider'>,
  query: string,
  usage: KnowledgeUsageInput[],
  access: AccessScope
): Promise<QueryVector | null> {
  const [vector] = await traceEmbed(embeddings, [query], async () => {
    const counted = await embedCounted(embeddings.client, [query])
    usage.push({
      tenantId: access.tenantId,
      userId: access.userId,
      feature: KNOWLEDGE_USAGE_FEATURES.embeddings,
      provider: embeddings.provider,
      model: embeddings.model,
      inputTokens: counted.inputTokens,
    })
    return counted.vectors
  })
  return vector
    ? { model: embeddings.model, provider: embeddings.provider, literal: vectorLiteral(vector) }
    : null
}

/** What a reranker reads of a candidate: its title and section in front of the passage. */
function rerankText(c: Candidate): string {
  const where = c.headingPath ? `${c.title} › ${c.headingPath}` : c.title
  return `${where}\n\n${c.text}`
}

/**
 * Rerank the fused list's head (`applyRerank`, never throws), then apply `RERANK_MIN_SCORE`.
 * Returns the new order, each item's reranker score, the outcome for the span, and pushes the
 * reranker's usage (billed tokens, else a character estimate) when the call ran or timed out.
 */
async function rerankFused(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  access: AccessScope,
  request: SearchChunksRequest,
  fused: FusedItem<Candidate>[],
  usage: KnowledgeUsageInput[]
): Promise<{
  ordered: FusedItem<Candidate>[]
  scores: Map<FusedItem<Candidate>, number>
  outcome: SearchRerankOutcome
}> {
  const scores = new Map<FusedItem<Candidate>, number>()
  if (request.rerank === false) {
    return { ordered: fused, scores, outcome: { applied: false, reason: 'disabled' } }
  }
  if (fused.length < 2) {
    return { ordered: fused, scores, outcome: { applied: false, reason: 'too_few' } }
  }
  let reranker: ResolvedRerank | null
  try {
    reranker = await resolveRerank(db, cfg, env, access.tenantId)
  } catch {
    // A row that cannot build a client (no key, a bad URL) must not cost the reader the search.
    return { ordered: fused, scores, outcome: { applied: false, reason: 'error' } }
  }
  const { items, placements, outcome } = await applyRerank(
    reranker?.client ?? null,
    request.query,
    fused,
    f => rerankText(f.item),
    { candidates: cfg.RERANK_CANDIDATES ?? RERANK_CANDIDATES }
  )
  if (reranker && (outcome.applied || outcome.reason === 'timeout')) {
    usage.push({
      tenantId: access.tenantId,
      userId: access.userId,
      feature: KNOWLEDGE_USAGE_FEATURES.rerank,
      provider: reranker.provider,
      model: reranker.model,
      inputTokens: outcome.inputTokens ?? Math.ceil((outcome.sentChars ?? 0) / CHARS_PER_TOKEN),
    })
  }
  const summary: SearchRerankOutcome = {
    applied: outcome.applied,
    model: outcome.model,
    reason: outcome.reason,
    latencyMs: outcome.latencyMs,
  }
  if (!outcome.applied) return { ordered: items, scores, outcome: summary }
  for (const [item, placement] of placements) scores.set(item, placement.score)
  const min = cfg.RERANK_MIN_SCORE
  if (min === undefined) return { ordered: items, scores, outcome: summary }
  // A threshold is a relevance filter: only what the reranker scored at or above it survives.
  const kept = items.filter(item => (scores.get(item) ?? -1) >= min)
  return { ordered: kept, scores, outcome: { ...summary, dropped: items.length - kept.length } }
}

/**
 * Whether `terms` (an `anyTermTsquery`) leaves anything to match once Postgres has stemmed and
 * stopworded it — `and`, `because` are english stopwords, so a query of only those is empty. One
 * tiny statement, run alongside the search legs; no terms at all costs nothing.
 */
async function lexicalHasTerms(db: Database, terms: string | null): Promise<boolean> {
  if (!terms) return false
  const [row] = rows<{ n: number }>(
    await db.execute(sql`select numnode(to_tsquery(${SEARCH_TEXT_CONFIG}, ${terms}))::int as n`)
  )
  return Number(row?.n ?? 0) > 0
}

/** One UTC day in milliseconds — `createdTo` is inclusive, so the bound is the next midnight. */
const DAY_MS = 86_400_000

/**
 * The `filters` of a search as ONE predicate over `documents`, or undefined when there are none.
 * It only ever narrows: the caller ANDs it with the tenant and visibility predicates, never in
 * place of them. Exported for its test.
 */
export function documentFilterPredicate(filters: SearchFilters | undefined): SQL | undefined {
  if (!filters) return undefined
  return and(
    filters.sources?.length ? inArray(documents.source, [...filters.sources]) : undefined,
    filters.contentTypes?.length
      ? inArray(documents.contentType, [...filters.contentTypes])
      : undefined,
    filters.createdFrom
      ? gte(documents.createdAt, new Date(`${filters.createdFrom}T00:00:00.000Z`))
      : undefined,
    filters.createdTo
      ? lt(
          documents.createdAt,
          new Date(new Date(`${filters.createdTo}T00:00:00.000Z`).getTime() + DAY_MS)
        )
      : undefined
  )
}

async function runSearch(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  access: AccessScope,
  request: SearchChunksRequest,
  options: { lexicalFallback?: boolean }
): Promise<KnowledgeChunkSearch> {
  const tenantId = access.tenantId
  const limit = request.limit ?? 10
  // Every metered call this search makes; written once, at the end, never failing the search.
  const usage: KnowledgeUsageInput[] = []
  const notReranked: SearchRerankOutcome = { applied: false, reason: 'too_few' }
  const pool = candidatePoolSize(limit)
  const visible = visibleDocuments(access)
  const platformSources = [...new Set(request.platformSources ?? [])]
  const searchTenant = !request.sources || request.sources.length > 0
  const searchPlatform = platformSources.length > 0
  if (!searchTenant && !searchPlatform)
    return { hits: [], semantic: 'used', lexical: 'used', rerank: notReranked }
  const narrowed = documentFilterPredicate(request.filters)
  const scope = and(
    eq(chunks.tenantId, tenantId),
    visible,
    request.documentId ? eq(chunks.documentId, request.documentId) : undefined,
    request.sources ? inArray(documents.source, [...request.sources]) : undefined,
    narrowed
  )
  const platformScope = searchPlatform
    ? and(
        isNull(chunks.tenantId),
        inArray(documents.source, platformSources),
        request.documentId ? eq(chunks.documentId, request.documentId) : undefined,
        narrowed
      )
    : undefined

  // The tenant query vector: the tenant's embedder, exactly as before.
  let tenantVector: QueryVector | null = null
  let semantic: KnowledgeChunkSearch['semantic'] = 'used'
  if (searchTenant) {
    let embeddings: ResolvedEmbeddings | null = null
    try {
      embeddings = await resolveEmbeddings(db, cfg, env, tenantId)
    } catch (err) {
      if (!(options.lexicalFallback && err instanceof AiNotConfiguredError)) throw err
      semantic = 'unavailable'
    }
    if (embeddings) {
      tenantVector = await embedQuery(embeddings, request.query, usage, access)
      // The pre-platform behaviour: an embedder that answers no vector is an empty search.
      if (!tenantVector && !searchPlatform) {
        await writeUsage(db, request, usage)
        return {
          hits: [],
          semantic,
          lexical: (await lexicalHasTerms(db, anyTermTsquery(request.query))) ? 'used' : 'no_terms',
          rerank: notReranked,
        }
      }
    }
  }
  // The platform query vector: the PLATFORM embedder, reusing the tenant vector when the model
  // is the same one (the common case: both are Workers AI bge-m3).
  let platformVector: QueryVector | null = null
  if (searchPlatform) {
    const platform = resolvePlatformEmbeddings(cfg, env)
    if (!platform) semantic = 'unavailable'
    else if (
      tenantVector &&
      tenantVector.model === platform.model &&
      tenantVector.provider === platform.provider
    )
      platformVector = tenantVector
    else platformVector = await embedQuery(platform, request.query, usage, access)
    if (platform && !platformVector) semantic = 'unavailable'
  }
  request.signal?.throwIfAborted()

  const select = {
    id: chunks.id,
    documentId: chunks.documentId,
    title: documents.title,
    text: chunks.text,
    seq: chunks.seq,
    headingPath: chunks.headingPath,
    page: chunks.page,
    source: documents.source,
    externalId: documents.externalId,
    tenantId: chunks.tenantId,
  }
  // The tenant predicate is spelled out here rather than only in `scope`, so this closure reads as
  // tenant-scoped on its own — which is what `tests/config/unscoped-allowlist.test.ts` checks. Only
  // the chunks THIS query vector's model embedded: another model's vectors are noise.
  const denseQuery = (runner: Database, vector: QueryVector) =>
    runner
      .select(select)
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(and(eq(chunks.tenantId, tenantId), scope, eq(chunks.embeddingModel, vector.model)))
      .orderBy(sql`${chunks.embedding} <=> ${vector.literal}::vector`)
      .limit(pool)
  // The platform corpus: `tenant_id IS NULL` and a named source, never anything else — and only
  // the documents embedded by THIS query vector's model. Always under the iterative scan: the
  // source predicate is as restrictive as any visibility one.
  const platformDenseQuery = (vector: QueryVector) =>
    db.transaction(async tx => {
      await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`)
      return tx
        .select(select)
        .from(chunks)
        .innerJoin(documents, eq(documents.id, chunks.documentId))
        .where(and(isNull(chunks.tenantId), platformScope, eq(chunks.embeddingModel, vector.model)))
        .orderBy(sql`${chunks.embedding} <=> ${vector.literal}::vector`)
        .limit(pool)
    })

  // ONE dense leg when both corpora share a vector, one per corpus when they do not.
  const shared = tenantVector !== null && platformVector === tenantVector
  const tenantDense = (): Promise<Candidate[]> => {
    const vector = tenantVector
    if (!vector) return Promise.resolve([])
    return visible
      ? db.transaction(async tx => {
          await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`)
          return denseQuery(tx, vector)
        })
      : denseQuery(db, vector)
  }
  const sharedDense = (vector: QueryVector): Promise<Candidate[]> =>
    db.transaction(async tx => {
      await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`)
      return tx
        .select(select)
        .from(chunks)
        .innerJoin(documents, eq(documents.id, chunks.documentId))
        .where(
          and(
            or(
              and(eq(chunks.tenantId, tenantId), scope),
              and(isNull(chunks.tenantId), platformScope)
            ),
            eq(chunks.embeddingModel, vector.model)
          )
        )
        .orderBy(sql`${chunks.embedding} <=> ${vector.literal}::vector`)
        .limit(pool)
    })
  const denseLegs: Promise<Candidate[]>[] = shared
    ? [sharedDense(tenantVector as QueryVector)]
    : [
        ...(searchTenant ? [tenantDense()] : []),
        ...(platformVector ? [platformDenseQuery(platformVector)] : []),
      ]

  const terms = anyTermTsquery(request.query)
  const lexicalScope = searchPlatform
    ? searchTenant
      ? or(and(eq(chunks.tenantId, tenantId), scope), platformScope)
      : platformScope
    : scope
  const [hasTerms, lexical, ...dense] = await Promise.all([
    lexicalHasTerms(db, terms),
    terms
      ? db
          .select(select)
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(
            and(
              lexicalScope,
              sql`${chunks.searchVector} @@ to_tsquery(${SEARCH_TEXT_CONFIG}, ${terms})`
            )
          )
          .orderBy(
            sql`ts_rank_cd(${chunks.searchVector}, to_tsquery(${SEARCH_TEXT_CONFIG}, ${terms})) DESC`
          )
          .limit(pool)
      : Promise.resolve([] as Candidate[]),
    ...denseLegs,
  ])
  request.signal?.throwIfAborted()

  const fusedAll = fuseDenseLegs<Candidate>(dense, lexical, c => c.id)
  const reranked = await rerankFused(db, cfg, env, access, request, fusedAll, usage)
  request.signal?.throwIfAborted()
  const fused = reranked.ordered.slice(0, limit)
  const [located] = await Promise.all([
    locateChunks(
      db,
      tenantId,
      fused.map(f => f.item.id),
      searchPlatform ? platformSources : []
    ),
    writeUsage(db, request, usage),
  ])
  return {
    semantic,
    lexical: hasTerms ? 'used' : 'no_terms',
    rerank: reranked.outcome,
    hits: fused.map((f, index) => ({
      chunkId: f.item.id,
      documentId: f.item.documentId,
      title: f.item.title,
      text: f.item.text,
      seq: f.item.seq,
      headingPath: f.item.headingPath,
      page: f.item.page,
      documentPassages: located.get(f.item.id)?.documentPassages ?? 0,
      charOffset: located.get(f.item.id)?.charOffset ?? null,
      score: f.score,
      // The answer's own order: the reranked one when a reranker ran, else the fused one.
      rank: index + 1,
      denseRank: f.denseRank,
      lexicalRank: f.lexicalRank,
      rerankScore: reranked.scores.get(f) ?? null,
      source: f.item.source,
      externalId: f.item.externalId,
      platform: f.item.tenantId === null,
    })),
  }
}

/**
 * Record the search's metered calls: through the caller's `defer` when it gave one (the response
 * does not wait), else awaited here — alongside the passage lookup, so it costs no extra round
 * trip. `recordKnowledgeUsage` never throws.
 */
function writeUsage(
  db: Database,
  request: SearchChunksRequest,
  usage: KnowledgeUsageInput[]
): Promise<void> {
  if (usage.length === 0) return Promise.resolve()
  if (!request.defer) return recordKnowledgeUsage(db, usage)
  request.defer(() => recordKnowledgeUsage(db, usage))
  return Promise.resolve()
}

/**
 * Where each returned passage sits in its document: its character offset in `documents.content`
 * (0-based; null when the text cannot be located — a re-chunked or converted document) and how
 * many passages the document has. Only the hits being returned are looked up, so `position()`
 * runs over a handful of rows, never the candidate pool. Platform chunks are located only under
 * the platform sources this search named.
 */
async function locateChunks(
  db: Database,
  tenantId: string,
  chunkIds: string[],
  platformSources: readonly string[]
): Promise<Map<string, { charOffset: number | null; documentPassages: number }>> {
  if (chunkIds.length === 0) return new Map()
  const owner =
    platformSources.length > 0
      ? or(
          eq(chunks.tenantId, tenantId),
          and(isNull(chunks.tenantId), inArray(documents.source, [...platformSources]))
        )
      : eq(chunks.tenantId, tenantId)
  const rows = await db
    .select({
      id: chunks.id,
      // 1-based, 0 when absent; both are mapped below.
      position: chunkCharOffsetSql,
      documentPassages: documents.chunkCount,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(and(owner, inArray(chunks.id, chunkIds)))
  return new Map(
    rows.map(row => [
      row.id,
      {
        charOffset: Number(row.position) > 0 ? Number(row.position) - 1 : null,
        documentPassages: row.documentPassages,
      },
    ])
  )
}

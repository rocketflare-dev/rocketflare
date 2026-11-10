/**
 * Hybrid retrieval over `chunks`: dense cosine (`<=>` on the pgvector HNSW index) +
 * Postgres full-text (ANY query term — `anyTermTsquery` — ranked by `ts_rank_cd` over
 * `to_tsvector('english', text)`),
 * fused by Reciprocal Rank Fusion (`RRF_K = 60`). Each signal retrieves a wide candidate pool, the
 * fusion decides the order, the top `limit` come back with `denseRank`/`lexicalRank` so "did the
 * vector search find this or only the keyword one?" is answerable. Each hit also says WHERE in its
 * document it sits — `seq` (passage n of `documentPassages`) and `charOffset`, the character
 * position of the passage in `documents.content`, so a reader can jump straight there with
 * `get_document`. The offset is resolved with one `position()` query over the returned hits only
 * (never the whole candidate pool), so nothing is stored and no migration is needed. It is
 * approximate by construction — first occurrence, counted in Postgres characters against JS's
 * UTF-16 slicing — so with chunk overlap or non-BMP text a window can start slightly early; a
 * reader gets a shifted read, never an error. The tenant predicate is on
 * EVERY query; `documentId` narrows further. No rerank in v1 (a `RerankFn` seam is the documented
 * extension).
 */
import type { SearchHit, SearchRequest } from '@rocketflare/shared/ai/embeddings'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { chunks, documents } from '../../../db/schema'
import { traceEmbed, traceStep } from '../../observability/context'
import { type AccessScope, visibleDocuments } from '../access'
import { AiNotConfiguredError } from './errors'
import { anyTermTsquery, candidatePoolSize, fuseDenseLegs } from './fusion'
import { type ResolvedEmbeddings, resolveEmbeddings, resolvePlatformEmbeddings } from './resolve'
import type { AiEnv } from './types'

export {
  anyTermTsquery,
  candidatePoolSize,
  type FusedItem,
  fuseByRank,
  fuseDenseLegs,
  LEXICAL_MAX_TERMS,
  RRF_K,
} from './fusion'

/** Text-search configuration the lexical half indexes and queries with. */
export const SEARCH_TEXT_CONFIG = 'english'

/**
 * Where a passage sits in its document: `position()` of the chunk's text in `documents.content`,
 * 1-based and 0 when absent (a re-chunked or converted document), mapped to a 0-based offset or
 * null by the caller. Exported so `locateChunks` here and `listDocumentPassages`
 * (`document-content.ts`) share ONE expression — a search hit and the passage list disagreeing
 * about where a passage starts is a deep link that lands in the wrong place. Both queries join
 * `chunks` to `documents`.
 */
export const chunkCharOffsetSql = sql<number>`position(${chunks.text} in coalesce(${documents.content}, ''))`

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
      attributes: { 'rocketflare.retrieval.hits': result.hits.length },
    })
  )
}

interface QueryVector {
  model: string
  provider: string
  literal: string
}

/** Embed the query with one resolved embedder; null when it answered no vector. */
async function embedQuery(
  embeddings: Pick<ResolvedEmbeddings, 'client' | 'model' | 'provider'>,
  query: string
): Promise<QueryVector | null> {
  const [vector] = await traceEmbed(embeddings, [query], () => embeddings.client.embed([query]))
  return vector
    ? { model: embeddings.model, provider: embeddings.provider, literal: vectorLiteral(vector) }
    : null
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
  const pool = candidatePoolSize(limit)
  const visible = visibleDocuments(access)
  const platformSources = [...new Set(request.platformSources ?? [])]
  const searchTenant = !request.sources || request.sources.length > 0
  const searchPlatform = platformSources.length > 0
  if (!searchTenant && !searchPlatform) return { hits: [], semantic: 'used' }
  const scope = and(
    eq(chunks.tenantId, tenantId),
    visible,
    request.documentId ? eq(chunks.documentId, request.documentId) : undefined,
    request.sources ? inArray(documents.source, [...request.sources]) : undefined
  )
  const platformScope = searchPlatform
    ? and(
        isNull(chunks.tenantId),
        inArray(documents.source, platformSources),
        request.documentId ? eq(chunks.documentId, request.documentId) : undefined
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
      tenantVector = await embedQuery(embeddings, request.query)
      // The pre-platform behaviour: an embedder that answers no vector is an empty search.
      if (!tenantVector && !searchPlatform) return { hits: [], semantic }
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
    else platformVector = await embedQuery(platform, request.query)
    if (platform && !platformVector) semantic = 'unavailable'
  }
  request.signal?.throwIfAborted()

  const select = {
    id: chunks.id,
    documentId: chunks.documentId,
    title: documents.title,
    text: chunks.text,
    seq: chunks.seq,
    source: documents.source,
    externalId: documents.externalId,
    tenantId: chunks.tenantId,
  }
  // The tenant predicate is spelled out here rather than only in `scope`, so this closure reads as
  // tenant-scoped on its own — which is what `tests/config/unscoped-allowlist.test.ts` checks.
  const denseQuery = (runner: Database, vec: string) =>
    runner
      .select(select)
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(and(eq(chunks.tenantId, tenantId), scope))
      .orderBy(sql`${chunks.embedding} <=> ${vec}::vector`)
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
        .where(
          and(isNull(chunks.tenantId), platformScope, eq(documents.embeddingModel, vector.model))
        )
        .orderBy(sql`${chunks.embedding} <=> ${vector.literal}::vector`)
        .limit(pool)
    })

  // ONE dense leg when both corpora share a vector, one per corpus when they do not.
  const shared = tenantVector !== null && platformVector === tenantVector
  const tenantDense = (): Promise<Candidate[]> => {
    if (!tenantVector) return Promise.resolve([])
    const vec = tenantVector.literal
    return visible
      ? db.transaction(async tx => {
          await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`)
          return denseQuery(tx, vec)
        })
      : denseQuery(db, vec)
  }
  const sharedDense = (vector: QueryVector): Promise<Candidate[]> =>
    db.transaction(async tx => {
      await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`)
      return tx
        .select(select)
        .from(chunks)
        .innerJoin(documents, eq(documents.id, chunks.documentId))
        .where(
          or(
            and(eq(chunks.tenantId, tenantId), scope),
            and(isNull(chunks.tenantId), platformScope, eq(documents.embeddingModel, vector.model))
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
  const [lexical, ...dense] = await Promise.all([
    terms
      ? db
          .select(select)
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(
            and(
              lexicalScope,
              sql`to_tsvector(${SEARCH_TEXT_CONFIG}, ${chunks.text}) @@ to_tsquery(${SEARCH_TEXT_CONFIG}, ${terms})`
            )
          )
          .orderBy(
            sql`ts_rank_cd(to_tsvector(${SEARCH_TEXT_CONFIG}, ${chunks.text}), to_tsquery(${SEARCH_TEXT_CONFIG}, ${terms})) DESC`
          )
          .limit(pool)
      : Promise.resolve([] as Candidate[]),
    ...denseLegs,
  ])
  request.signal?.throwIfAborted()

  const fused = fuseDenseLegs<Candidate>(dense, lexical, c => c.id).slice(0, limit)
  const located = await locateChunks(
    db,
    tenantId,
    fused.map(f => f.item.id),
    searchPlatform ? platformSources : []
  )
  return {
    semantic,
    hits: fused.map(f => ({
      chunkId: f.item.id,
      documentId: f.item.documentId,
      title: f.item.title,
      text: f.item.text,
      seq: f.item.seq,
      documentPassages: located.get(f.item.id)?.documentPassages ?? 0,
      charOffset: located.get(f.item.id)?.charOffset ?? null,
      score: f.score,
      rank: f.rank,
      denseRank: f.denseRank,
      lexicalRank: f.lexicalRank,
      source: f.item.source,
      externalId: f.item.externalId,
      platform: f.item.tenantId === null,
    })),
  }
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

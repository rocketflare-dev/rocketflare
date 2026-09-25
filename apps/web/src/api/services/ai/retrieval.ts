/**
 * Hybrid retrieval over `chunks` (D17, D18): dense cosine (`<=>` on the pgvector HNSW index) +
 * Postgres full-text (`websearch_to_tsquery` / `ts_rank_cd` over `to_tsvector('english', text)`),
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
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { chunks, documents } from '../../../db/schema'
import { traceEmbed, traceStep } from '../../observability/context'
import { type AccessScope, visibleDocuments } from '../access'
import { resolveEmbeddings } from './resolve'
import type { AiEnv } from './types'

/** The RRF constant from the original paper — the de-facto default. */
export const RRF_K = 60
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

/** "Retrieve wide, fuse narrow": how many candidates each signal contributes before fusion. */
export function candidatePoolSize(limit: number): number {
  return Math.min(Math.max(limit * 4, 50), 200)
}

export interface FusedItem<T> {
  item: T
  score: number
  rank: number
  denseRank: number | null
  lexicalRank: number | null
}

/** Reciprocal Rank Fusion of two ordered candidate lists (best first). Pure. */
export function fuseByRank<T>(
  dense: T[],
  lexical: T[],
  keyOf: (item: T) => string,
  k = RRF_K
): FusedItem<T>[] {
  const entries = new Map<string, FusedItem<T>>()
  const add = (list: T[], signal: 'denseRank' | 'lexicalRank') => {
    list.forEach((item, index) => {
      const rank = index + 1
      const key = keyOf(item)
      const entry = entries.get(key) ?? {
        item,
        score: 0,
        rank: 0,
        denseRank: null,
        lexicalRank: null,
      }
      entry.score += 1 / (k + rank)
      entry[signal] = rank
      entries.set(key, entry)
    })
  }
  add(dense, 'denseRank')
  add(lexical, 'lexicalRank')
  return [...entries.values()]
    .sort((a, b) => b.score - a.score || keyOf(a.item).localeCompare(keyOf(b.item)))
    .map((entry, index) => ({ ...entry, rank: index + 1 }))
}

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
}

/**
 * Hybrid search, scoped to what this reader may SEE (D29). `access` carries the tenant, so there
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
 */
export function searchChunks(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  access: AccessScope,
  request: SearchRequest
): Promise<SearchHit[]> {
  // D32: a `retrieval` span under whatever is active (the `search_knowledge` tool span), with the
  // query embedding nested inside it. The hits are summarised — the passages are the TOOL's output.
  return traceStep(
    {
      name: 'retrieval search_chunks',
      kind: 'retrieval',
      input: { query: request.query, limit: request.limit ?? 10, documentId: request.documentId },
    },
    () => runSearch(db, cfg, env, access, request),
    hits => ({
      output: hits.map(h => ({
        documentId: h.documentId,
        title: h.title,
        seq: h.seq,
        score: h.score,
      })),
      attributes: { 'rocketflare.retrieval.hits': hits.length },
    })
  )
}

async function runSearch(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  access: AccessScope,
  request: SearchRequest
): Promise<SearchHit[]> {
  const tenantId = access.tenantId
  const limit = request.limit ?? 10
  const pool = candidatePoolSize(limit)
  const visible = visibleDocuments(access)
  const scope = and(
    eq(chunks.tenantId, tenantId),
    visible,
    request.documentId ? eq(chunks.documentId, request.documentId) : undefined
  )
  const embeddings = await resolveEmbeddings(db, cfg, env, tenantId)
  const [queryVector] = await traceEmbed(embeddings, [request.query], () =>
    embeddings.client.embed([request.query])
  )
  if (!queryVector) return []
  const vec = vectorLiteral(queryVector)

  const select = {
    id: chunks.id,
    documentId: chunks.documentId,
    title: documents.title,
    text: chunks.text,
    seq: chunks.seq,
  }
  // The tenant predicate is spelled out here rather than only in `scope`, so this closure reads as
  // tenant-scoped on its own — which is what `tests/config/unscoped-allowlist.test.ts` checks.
  const denseQuery = (runner: Database) =>
    runner
      .select(select)
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(and(eq(chunks.tenantId, tenantId), scope))
      .orderBy(sql`${chunks.embedding} <=> ${vec}::vector`)
      .limit(pool)

  const [dense, lexical] = await Promise.all([
    visible
      ? db.transaction(async tx => {
          await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`)
          return denseQuery(tx as unknown as Database)
        })
      : denseQuery(db),
    db
      .select(select)
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(
        and(
          scope,
          sql`to_tsvector(${SEARCH_TEXT_CONFIG}, ${chunks.text}) @@ websearch_to_tsquery(${SEARCH_TEXT_CONFIG}, ${request.query})`
        )
      )
      .orderBy(
        sql`ts_rank_cd(to_tsvector(${SEARCH_TEXT_CONFIG}, ${chunks.text}), websearch_to_tsquery(${SEARCH_TEXT_CONFIG}, ${request.query})) DESC`
      )
      .limit(pool),
  ])

  const fused = fuseByRank<Candidate>(dense, lexical, c => c.id).slice(0, limit)
  const located = await locateChunks(
    db,
    tenantId,
    fused.map(f => f.item.id)
  )
  return fused.map(f => ({
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
  }))
}

/**
 * Where each returned passage sits in its document: its character offset in `documents.content`
 * (0-based; null when the text cannot be located — a re-chunked or converted document) and how
 * many passages the document has. Only the hits being returned are looked up, so `position()`
 * runs over a handful of rows, never the candidate pool.
 */
async function locateChunks(
  db: Database,
  tenantId: string,
  chunkIds: string[]
): Promise<Map<string, { charOffset: number | null; documentPassages: number }>> {
  if (chunkIds.length === 0) return new Map()
  const rows = await db
    .select({
      id: chunks.id,
      // 1-based, 0 when absent; both are mapped below.
      position: chunkCharOffsetSql,
      documentPassages: documents.chunkCount,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(and(eq(chunks.tenantId, tenantId), inArray(chunks.id, chunkIds)))
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

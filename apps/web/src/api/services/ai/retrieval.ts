/**
 * Hybrid retrieval over `chunks` (D17, D18): dense cosine (`<=>` on the pgvector HNSW index) +
 * Postgres full-text (`websearch_to_tsquery` / `ts_rank_cd` over `to_tsvector('english', text)`),
 * fused by Reciprocal Rank Fusion (`RRF_K = 60`). Each signal retrieves a wide candidate pool, the
 * fusion decides the order, the top `limit` come back with `denseRank`/`lexicalRank` so "did the
 * vector search find this or only the keyword one?" is answerable. The tenant predicate is on
 * EVERY query; `documentId` narrows further. No rerank in v1 (a `RerankFn` seam is the documented
 * extension).
 */
import type { SearchHit, SearchRequest } from '@gmgo/shared/ai/embeddings'
import { and, eq, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { chunks, documents } from '../../../db/schema'
import { resolveEmbeddings } from './resolve'
import type { AiEnv } from './types'

/** The RRF constant from the original paper — the de-facto default. */
export const RRF_K = 60
/** Text-search configuration the lexical half indexes and queries with. */
export const SEARCH_TEXT_CONFIG = 'english'

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
}

export async function searchChunks(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  request: SearchRequest
): Promise<SearchHit[]> {
  const limit = request.limit ?? 10
  const pool = candidatePoolSize(limit)
  const scope = and(
    eq(chunks.tenantId, tenantId),
    request.documentId ? eq(chunks.documentId, request.documentId) : undefined
  )
  const embeddings = await resolveEmbeddings(db, cfg, env, tenantId)
  const [queryVector] = await embeddings.client.embed([request.query])
  if (!queryVector) return []
  const vec = vectorLiteral(queryVector)

  const select = {
    id: chunks.id,
    documentId: chunks.documentId,
    title: documents.title,
    text: chunks.text,
  }
  const [dense, lexical] = await Promise.all([
    db
      .select(select)
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(scope)
      .orderBy(sql`${chunks.embedding} <=> ${vec}::vector`)
      .limit(pool),
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

  return fuseByRank<Candidate>(dense, lexical, c => c.id)
    .slice(0, limit)
    .map(f => ({
      chunkId: f.item.id,
      documentId: f.item.documentId,
      title: f.item.title,
      text: f.item.text,
      score: f.score,
      rank: f.rank,
      denseRank: f.denseRank,
      lexicalRank: f.lexicalRank,
    }))
}

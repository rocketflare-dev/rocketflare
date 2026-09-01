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
  seq: number
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
    seq: chunks.seq,
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
      // `position()` is 1-based and 0 when absent; both are mapped below.
      position: sql<number>`position(${chunks.text} in coalesce(${documents.content}, ''))`,
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

/**
 * Memory recall (D36) — Hindsight's multi-arm retrieval, in Postgres, scoped by the reader.
 *
 * Three arms, each retrieving a wide pool under the SAME predicate (tenant AND `visibleMemories`
 * AND not superseded AND the time window), fused by Reciprocal Rank Fusion:
 *
 * - **dense** — cosine over the HNSW index (`<=>`), with `hnsw.iterative_scan = relaxed_order` set
 *   locally because the visibility predicate is ALWAYS in play here: one person's facts are a thin
 *   slice of a tenant's, and an approximate scan that runs out of candidates before it finds them
 *   returns nothing rather than something worse (`retrieval.ts` explains the setting);
 * - **lexical** — the stored, GIN-indexed `search_vector` (fact text + entity names);
 * - **entity** — the graph arm: facts linked to an entity the query NAMES (or the `entity` the
 *   caller passed), ranked by how many such entities they share, newest first. It is what finds
 *   "Alice prefers async stand-ups" for "what does Alice like?" when the embedding of the question
 *   is closer to a fact about somebody else's preferences.
 *
 * Time is a FILTER, not an arm: the caller (a model that knows today's date) passes `from`/`to`
 * as ISO dates, which costs no Worker CPU — Hindsight parses dates out of the query with
 * `dateparser`, which is exactly the thing a Worker should not do.
 */
import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { memories, memoryEntities, memoryEntityLinks } from '../../../../db/schema'
import { traceEmbed, traceStep } from '../../../observability/context'
import { type AccessScope, visibleMemories } from '../../access'
import { resolveEmbeddings } from '../resolve'
import { candidatePoolSize, fuseRankedArms, SEARCH_TEXT_CONFIG, vectorLiteral } from '../retrieval'
import type { AiEnv } from '../types'
import {
  entitiesForMemories,
  memoryColumns,
  memoryTimeOverlaps,
  normaliseEntityName,
  toMemoryDto,
} from './store'

/** Entity names shorter than this are never matched out of a query — "a", "it", "ok". */
const ENTITY_MATCH_MIN_CHARS = 3
/** Entities the graph arm may expand from in one query. */
const ENTITY_ARM_MAX_ENTITIES = 10

export type RecallArm = 'dense' | 'lexical' | 'entity'

export interface RecallRequest {
  query: string
  limit: number
  from?: Date
  to?: Date
  entity?: string
  includeHistorical?: boolean
}

export interface RecallHit {
  memory: ReturnType<typeof toMemoryDto>
  score: number
  rank: number
  ranks: Partial<Record<RecallArm, number>>
}

export function recallMemories(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  scope: AccessScope,
  request: RecallRequest
): Promise<RecallHit[]> {
  return traceStep(
    {
      name: 'retrieval recall_memories',
      kind: 'retrieval',
      input: {
        query: request.query,
        limit: request.limit,
        from: request.from?.toISOString(),
        to: request.to?.toISOString(),
        entity: request.entity,
      },
    },
    () => runRecall(db, cfg, env, scope, request),
    hits => ({
      // Ids and ranks only: the fact text is the TOOL's output, recorded once there.
      output: hits.map(h => ({ id: h.memory.id, score: h.score, ranks: h.ranks })),
      attributes: { 'rocketflare.retrieval.hits': hits.length },
    })
  )
}

async function runRecall(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  scope: AccessScope,
  request: RecallRequest
): Promise<RecallHit[]> {
  const tenantId = scope.tenantId
  const pool = candidatePoolSize(request.limit)
  const where = and(
    eq(memories.tenantId, tenantId),
    visibleMemories(scope),
    request.includeHistorical ? undefined : isNull(memories.invalidatedAt),
    memoryTimeOverlaps(request.from, request.to)
  )

  const embeddings = await resolveEmbeddings(db, cfg, env, tenantId)
  const [queryVector] = await traceEmbed(embeddings, [request.query], () =>
    embeddings.client.embed([request.query])
  )
  const select = { id: memories.id }

  const [dense, lexical, entity] = await Promise.all([
    queryVector
      ? db.transaction(async tx => {
          await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`)
          return tx
            .select(select)
            .from(memories)
            .where(and(eq(memories.tenantId, tenantId), where))
            .orderBy(sql`${memories.embedding} <=> ${vectorLiteral(queryVector)}::vector`)
            .limit(pool)
        })
      : Promise.resolve([] as { id: string }[]),
    db
      .select(select)
      .from(memories)
      .where(
        and(
          eq(memories.tenantId, tenantId),
          where,
          sql`${memories.searchVector} @@ websearch_to_tsquery(${SEARCH_TEXT_CONFIG}, ${request.query})`
        )
      )
      .orderBy(
        sql`ts_rank_cd(${memories.searchVector}, websearch_to_tsquery(${SEARCH_TEXT_CONFIG}, ${request.query})) DESC`
      )
      .limit(pool),
    entityArm(db, scope, where, request, pool),
  ])

  const fused = fuseRankedArms<{ id: string }, RecallArm>(
    { dense, lexical, entity },
    m => m.id
  ).slice(0, request.limit)
  if (fused.length === 0) return []

  const ids = fused.map(f => f.item.id)
  const [rows, entities] = await Promise.all([
    db
      .select(memoryColumns)
      .from(memories)
      .where(and(eq(memories.tenantId, tenantId), inArray(memories.id, ids))),
    entitiesForMemories(db, tenantId, ids),
  ])
  const byId = new Map(rows.map(r => [r.id, r]))
  return fused.flatMap(f => {
    const row = byId.get(f.item.id)
    if (!row) return []
    return [
      {
        memory: toMemoryDto(row, entities.get(row.id) ?? []),
        score: f.score,
        rank: f.rank,
        ranks: f.ranks,
      },
    ]
  })
}

/**
 * The graph arm. Entities are looked up in the reader's OWN partition plus the knowledge-owned
 * one (owner null) — never another person's — and the facts they lead to still pass the full
 * predicate, so following an edge can never reach a row the reader could not have searched for.
 *
 * Matching is by whole normalised name inside the normalised query (word boundaries by padding
 * with spaces), which is cheap, exact and explainable; an entity id from an earlier answer is the
 * precise route, through `entity`.
 */
async function entityArm(
  db: Database,
  scope: AccessScope,
  where: SQL | undefined,
  request: RecallRequest,
  pool: number
): Promise<{ id: string }[]> {
  const tenantId = scope.tenantId
  const partition = scope.userId
    ? sql`(${memoryEntities.ownerUserId} = ${scope.userId} or ${memoryEntities.ownerUserId} is null)`
    : sql`${memoryEntities.ownerUserId} is null`
  const named = request.entity ? normaliseEntityName(request.entity) : null
  const haystack = ` ${normaliseEntityName(request.query).replace(/[^\p{L}\p{N}' ]+/gu, ' ')} `
  const match = named
    ? eq(memoryEntities.normalisedName, named)
    : sql`length(${memoryEntities.normalisedName}) >= ${ENTITY_MATCH_MIN_CHARS} and position(' ' || ${memoryEntities.normalisedName} || ' ' in ${haystack}) > 0`
  const matched = await db
    .select({ id: memoryEntities.id })
    .from(memoryEntities)
    .where(and(eq(memoryEntities.tenantId, tenantId), partition, match))
    .orderBy(desc(memoryEntities.mentionCount))
    .limit(ENTITY_ARM_MAX_ENTITIES)
  if (matched.length === 0) return []

  const shared = sql<number>`count(distinct ${memoryEntityLinks.entityId})`
  return db
    .select({ id: memories.id })
    .from(memories)
    .innerJoin(memoryEntityLinks, eq(memoryEntityLinks.memoryId, memories.id))
    .where(
      and(
        eq(memories.tenantId, tenantId),
        where,
        eq(memoryEntityLinks.tenantId, tenantId),
        inArray(
          memoryEntityLinks.entityId,
          matched.map(e => e.id)
        )
      )
    )
    .groupBy(memories.id, memories.mentionedAt)
    .orderBy(desc(shared), desc(memories.mentionedAt))
    .limit(pool)
}

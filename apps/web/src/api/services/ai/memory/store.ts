/**
 * Reading and forgetting memories (D36) — the API's half. Every query here carries the tenant
 * predicate AND the reader's `visibleMemories` predicate; the WRITES (forget one, forget all) are
 * narrower still — a person may forget only what they own, whatever else they can see.
 */
import type { Memory, MemoryEntity, MemoryListQuery } from '@rocketflare/shared/ai/memory'
import { paginationMeta } from '@rocketflare/shared/pagination'
import { and, count, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { affected } from '../../../../db/client'
import { type MemoryRow, memories, memoryEntities, memoryEntityLinks } from '../../../../db/schema'
import { NotFoundError } from '../../../utils/core/errors'
import { type AccessScope, visibleMemories } from '../../access'
import { SEARCH_TEXT_CONFIG } from '../retrieval'

/** Lower-cased, whitespace collapsed, surrounding punctuation dropped — the entity resolution key. */
export function normaliseEntityName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`.,;:!?()[\]{}<>-]+|[\s"'`.,;:!?()[\]{}<>-]+$/g, '')
}

/**
 * `[start, end]` of what a memory is ABOUT, as SQL: the occurred range when it is known, else the
 * moment it was said. A filter `[from, to]` matches when the two intervals overlap.
 */
export function memoryTimeOverlaps(from: Date | undefined, to: Date | undefined): SQL | undefined {
  const start = sql`coalesce(${memories.occurredStart}, ${memories.mentionedAt})`
  const end = sql`coalesce(${memories.occurredEnd}, ${memories.occurredStart}, ${memories.mentionedAt})`
  return and(
    to ? sql`${start} <= ${to.toISOString()}::timestamptz` : undefined,
    from ? sql`${end} >= ${from.toISOString()}::timestamptz` : undefined
  )
}

/** The entity names each of these memories links to, in one query. */
export async function entitiesForMemories(
  db: Database,
  tenantId: string,
  memoryIds: string[]
): Promise<Map<string, { id: string; name: string }[]>> {
  const out = new Map<string, { id: string; name: string }[]>()
  if (memoryIds.length === 0) return out
  const rows = await db
    .select({
      memoryId: memoryEntityLinks.memoryId,
      id: memoryEntities.id,
      name: memoryEntities.name,
    })
    .from(memoryEntityLinks)
    .innerJoin(memoryEntities, eq(memoryEntities.id, memoryEntityLinks.entityId))
    .where(
      and(eq(memoryEntityLinks.tenantId, tenantId), inArray(memoryEntityLinks.memoryId, memoryIds))
    )
    .orderBy(memoryEntities.name)
  for (const row of rows) {
    const list = out.get(row.memoryId) ?? []
    list.push({ id: row.id, name: row.name })
    out.set(row.memoryId, list)
  }
  return out
}

type MemoryColumns = Omit<MemoryRow, 'embedding' | 'searchVector'>

/** The columns a reader gets — never the vector, never the generated tsvector. */
export const memoryColumns = {
  id: memories.id,
  tenantId: memories.tenantId,
  ownerUserId: memories.ownerUserId,
  visibility: memories.visibility,
  kind: memories.kind,
  text: memories.text,
  occurredStart: memories.occurredStart,
  occurredEnd: memories.occurredEnd,
  mentionedAt: memories.mentionedAt,
  embeddingModel: memories.embeddingModel,
  textSignals: memories.textSignals,
  sourceConversationId: memories.sourceConversationId,
  sourceMessageIds: memories.sourceMessageIds,
  invalidatedAt: memories.invalidatedAt,
  supersededById: memories.supersededById,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
}

export function toMemoryDto(row: MemoryColumns, entities: { id: string; name: string }[]): Memory {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind,
    visibility: row.visibility,
    occurredStart: row.occurredStart,
    occurredEnd: row.occurredEnd,
    mentionedAt: row.mentionedAt,
    entities,
    sourceConversationId: row.sourceConversationId,
    invalidatedAt: row.invalidatedAt,
    supersededById: row.supersededById,
    createdAt: row.createdAt,
  }
}

/** `GET /api/memory` — what this reader may see, newest said first. */
export async function listMemories(db: Database, scope: AccessScope, query: MemoryListQuery) {
  const where = and(
    eq(memories.tenantId, scope.tenantId),
    visibleMemories(scope),
    query.includeHistorical ? undefined : isNull(memories.invalidatedAt),
    memoryTimeOverlaps(
      query.from ? new Date(query.from) : undefined,
      query.to ? new Date(query.to) : undefined
    ),
    query.q
      ? sql`${memories.searchVector} @@ websearch_to_tsquery(${SEARCH_TEXT_CONFIG}, ${query.q})`
      : undefined
  )
  const [rows, [total]] = await Promise.all([
    db
      .select(memoryColumns)
      .from(memories)
      .where(where)
      .orderBy(desc(memories.mentionedAt), desc(memories.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ n: count() }).from(memories).where(where),
  ])
  const entities = await entitiesForMemories(
    db,
    scope.tenantId,
    rows.map(r => r.id)
  )
  return {
    items: rows.map(r => toMemoryDto(r, entities.get(r.id) ?? [])),
    pagination: paginationMeta(query.page, query.pageSize, total?.n ?? 0),
  }
}

/** Forget one memory the reader OWNS. Anything else — another person's, a shared one — is a 404. */
export async function forgetMemory(db: Database, scope: AccessScope, id: string): Promise<void> {
  if (!scope.userId) throw new NotFoundError('Memory not found')
  const deleted = affected(
    await db
      .delete(memories)
      .where(
        and(
          eq(memories.tenantId, scope.tenantId),
          eq(memories.ownerUserId, scope.userId),
          eq(memories.id, id)
        )
      )
  )
  if (deleted === 0) throw new NotFoundError('Memory not found')
  await pruneOrphanEntities(db, scope.tenantId, scope.userId)
}

/** Forget everything this person owns in this tenant, entities included. */
export async function forgetAllMemories(db: Database, scope: AccessScope): Promise<number> {
  if (!scope.userId) return 0
  const userId = scope.userId
  return db.transaction(async tx => {
    const deleted = affected(
      await tx
        .delete(memories)
        .where(and(eq(memories.tenantId, scope.tenantId), eq(memories.ownerUserId, userId)))
    )
    await tx
      .delete(memoryEntities)
      .where(
        and(eq(memoryEntities.tenantId, scope.tenantId), eq(memoryEntities.ownerUserId, userId))
      )
    return deleted
  })
}

/**
 * An entity no fact names any more is a name the person asked to forget, kept by accident. One
 * statement over the person's own partition, run after a single forget.
 */
async function pruneOrphanEntities(db: Database, tenantId: string, userId: string): Promise<void> {
  await db
    .delete(memoryEntities)
    .where(
      and(
        eq(memoryEntities.tenantId, tenantId),
        eq(memoryEntities.ownerUserId, userId),
        sql`not exists (select 1 from "memory_entity_links" l where l."entity_id" = ${memoryEntities.id})`
      )
    )
}

/** `GET /api/memory/entities` — the people and things this person's memory names, most-mentioned first. */
export async function listMemoryEntities(
  db: Database,
  scope: AccessScope,
  limit = 100
): Promise<MemoryEntity[]> {
  if (!scope.userId) return []
  const rows = await db
    .select({
      id: memoryEntities.id,
      name: memoryEntities.name,
      mentionCount: memoryEntities.mentionCount,
      firstSeenAt: memoryEntities.firstSeenAt,
      lastSeenAt: memoryEntities.lastSeenAt,
    })
    .from(memoryEntities)
    .where(
      and(eq(memoryEntities.tenantId, scope.tenantId), eq(memoryEntities.ownerUserId, scope.userId))
    )
    .orderBy(desc(memoryEntities.mentionCount), desc(memoryEntities.lastSeenAt))
    .limit(limit)
  return rows
}

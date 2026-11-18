/**
 * Reading knowledge facts as a PERSON or a model sees them (D43): every fact through its
 * document's visibility, with its conflicts narrowed to the ones the reader may see.
 *
 * **The reader's view of a state.** A fact `conflicting` only with facts from documents the
 * reader cannot open is, for them, a fact nobody disagrees with: it reads as the state it would
 * return to if those were gone (`restoredState` — `accepted` or `unconfirmed`), and its
 * `conflictsWith` names only visible facts. Otherwise a hidden document would leak one bit — "a
 * source you cannot see says otherwise". Admin-level readers see every fact, so their view IS
 * the stored state.
 *
 * Here: `selectFacts` (the one query), `toFact` / `viewState`, entity names (`entityNames`),
 * `getEntityCard`, `listReviewItems` (`GET /api/knowledge/review`), and the browse reads —
 * `readDocumentFacts` (a document's facts) and `listKnowledgeEntities` (the Facts view).
 */
import {
  type DocumentFactGroup,
  type DocumentFactsResponse,
  type EntityCard,
  type EntityKind,
  type Fact,
  type FactState,
  type KnowledgeEntity,
  type KnowledgeEntityList,
  type KnowledgeEntityListQuery,
  type KnowledgeEntitySummary,
  type KnowledgeReviewItem,
  type KnowledgeReviewQuery,
  OPEN_REVIEW_FACT_STATES,
  type PossibleMatchCandidate,
  SOURCE_KIND_LABELS,
} from '@rocketflare/shared/ai/knowledge-facts'
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { unionAll } from 'drizzle-orm/pg-core'
import type { Database } from '../../../db/client'
import {
  documents,
  type KnowledgeEntityRow,
  type KnowledgeFactRow,
  knowledgeEntities,
  knowledgeFacts,
} from '../../../db/schema'
import { NotFoundError } from '../../utils/core/errors'
import { type AccessScope, visibleDocuments } from '../access'
import { entityVisibleSql, restoredState, visibleConflictsSql } from './facts-sql'
import { knowledgeEntityType, knowledgeEntityTypes } from './registry'
import { resolverFor } from './resolve'
import { ACCEPT_CONFIDENCE } from './state'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One fact as read: the row, its document's title, and the conflict ids the reader may see. */
export interface ReadFact {
  row: KnowledgeFactRow
  documentTitle: string
  visibleConflicts: string[]
}

/** The tenant predicate AND the document's visibility — the base of every fact read. */
export function visibleFactsWhere(scope: AccessScope): SQL | undefined {
  return and(eq(knowledgeFacts.tenantId, scope.tenantId), visibleDocuments(scope))
}

/** The facts matching `where` that the reader may see, with what `toFact` needs. */
export async function selectFacts(
  db: Database,
  scope: AccessScope,
  where: SQL | undefined,
  options: { orderBy?: SQL[]; limit?: number } = {}
): Promise<ReadFact[]> {
  const query = db
    .select({
      row: getTableColumns(knowledgeFacts),
      documentTitle: documents.title,
      visibleConflicts: visibleConflictsSql(scope),
    })
    .from(knowledgeFacts)
    .innerJoin(
      documents,
      and(eq(documents.id, knowledgeFacts.documentId), eq(documents.tenantId, scope.tenantId))
    )
    .where(and(visibleFactsWhere(scope), where))
    .orderBy(
      ...(options.orderBy ?? [asc(knowledgeFacts.observedAt), asc(knowledgeFacts.createdAt)])
    )
  const found = await (options.limit ? query.limit(options.limit) : query)
  return found.map(r => ({
    row: r.row as KnowledgeFactRow,
    documentTitle: r.documentTitle,
    visibleConflicts: parseIds(r.visibleConflicts),
  }))
}

function parseIds(value: unknown): string[] {
  const list = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  return Array.isArray(list) ? list.map(String) : []
}

/** The state the reader sees (see the header). */
export function viewState(fact: ReadFact): FactState {
  const { row } = fact
  if (row.state === 'conflicting' && fact.visibleConflicts.length === 0) return restoredState(row)
  return row.state
}

/** A row as `factSchema`, in the reader's view. */
export function toFact(fact: ReadFact): Fact {
  const { row } = fact
  return {
    id: row.id,
    entityKind: row.entityKind,
    entityType: row.entityType,
    entityId: row.entityId,
    key: row.key,
    value: row.value,
    valueText: row.valueText,
    source: {
      kind: row.sourceKind,
      documentId: row.documentId,
      documentTitle: fact.documentTitle,
      chunkId: row.chunkId,
      charStart: row.charStart,
      charEnd: row.charEnd,
      quote: row.quote,
    },
    confidence: row.confidence,
    state: viewState(fact),
    supersededById: row.supersededById,
    conflictsWith: fact.visibleConflicts,
    validFrom: row.validFrom,
    validTo: row.validTo,
    observedAt: row.observedAt,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt,
    reviewerUserId: row.reviewerUserId,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** One visible fact by id, or the 404 an invisible one and an absent one share. */
export async function readVisibleFact(
  db: Database,
  scope: AccessScope,
  id: string
): Promise<ReadFact> {
  const [found] = await selectFacts(db, scope, eq(knowledgeFacts.id, id))
  if (!found) throw new NotFoundError('Fact not found')
  return found
}

// ── Entities ──────────────────────────────────────────────────────────────────────────────────

export interface EntityRef {
  kind: EntityKind
  type: string
  id: string
}

export const refKey = (r: EntityRef) => `${r.kind}:${r.type}:${r.id}`

export function toKnowledgeEntity(row: KnowledgeEntityRow): KnowledgeEntity {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    aliases: row.aliases,
    promotedTo:
      row.promotedType && row.promotedId ? { type: row.promotedType, id: row.promotedId } : null,
    mergedInto: row.mergedInto,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** A staging entity of the tenant the reader may see, or null. */
export async function readVisibleEntity(
  db: Database,
  scope: AccessScope,
  id: string
): Promise<KnowledgeEntityRow | null> {
  if (!UUID_RE.test(id)) return null
  const [row] = await db
    .select()
    .from(knowledgeEntities)
    .where(
      and(
        eq(knowledgeEntities.id, id),
        eq(knowledgeEntities.tenantId, scope.tenantId),
        entityVisibleSql(scope)
      )
    )
  return row ?? null
}

/**
 * The label of a domain row of a registered type: its `labelColumn`, tenant-scoped. Null when
 * the type has no table (or no such row).
 */
export async function domainLabel(
  db: Database,
  tenantId: string,
  type: string,
  id: string
): Promise<string | null> {
  const reg = knowledgeEntityType(type)
  if (!reg?.table || !reg.labelColumn) return null
  const columns = getTableColumns(reg.table)
  const idColumn = (reg.idColumn ?? columns.id) as AnyPgColumn | undefined
  const tenantColumn = columns.tenantId as AnyPgColumn | undefined
  if (!idColumn || !tenantColumn) return null
  const [row] = await db
    .select({ label: sql<string>`${reg.labelColumn}::text` })
    .from(reg.table)
    .where(and(eq(tenantColumn, tenantId), sql`${idColumn}::text = ${id}`))
    .limit(1)
  return row?.label ?? null
}

/**
 * Display names for entity refs: a staging entity's `name`; a domain row's label, else the name
 * of a staging entity promoted to it, else its id.
 */
export async function entityNames(
  db: Database,
  tenantId: string,
  refs: readonly EntityRef[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const staging = [...new Set(refs.filter(r => r.kind === 'staging').map(r => r.id))].filter(id =>
    UUID_RE.test(id)
  )
  if (staging.length > 0) {
    const rows = await db
      .select({
        id: knowledgeEntities.id,
        type: knowledgeEntities.type,
        name: knowledgeEntities.name,
      })
      .from(knowledgeEntities)
      .where(and(eq(knowledgeEntities.tenantId, tenantId), inArray(knowledgeEntities.id, staging)))
    for (const r of rows) out.set(refKey({ kind: 'staging', type: r.type, id: r.id }), r.name)
  }
  const domain = refs.filter(r => r.kind === 'domain')
  if (domain.length > 0) {
    const promoted = await db
      .select({
        type: knowledgeEntities.promotedType,
        id: knowledgeEntities.promotedId,
        name: knowledgeEntities.name,
      })
      .from(knowledgeEntities)
      .where(
        and(
          eq(knowledgeEntities.tenantId, tenantId),
          isNotNull(knowledgeEntities.promotedId),
          inArray(
            knowledgeEntities.promotedId,
            domain.map(r => r.id)
          )
        )
      )
      .orderBy(asc(knowledgeEntities.createdAt))
    for (const ref of domain) {
      const key = refKey(ref)
      if (out.has(key)) continue
      const label =
        (await domainLabel(db, tenantId, ref.type, ref.id)) ??
        promoted.find(p => p.type === ref.type && p.id === ref.id)?.name ??
        ref.id
      out.set(key, label)
    }
  }
  for (const ref of refs) if (!out.has(refKey(ref))) out.set(refKey(ref), ref.id)
  return out
}

/** Facts about one entity, every state, oldest first. */
function factsAbout(ref: EntityRef): SQL | undefined {
  return and(
    eq(knowledgeFacts.entityKind, ref.kind),
    eq(knowledgeFacts.entityType, ref.type),
    eq(knowledgeFacts.entityId, ref.id)
  )
}

/**
 * `GET /api/knowledge/entities/:type/:id`: a staging entity (by its uuid) or a domain row of a
 * registered type, and every fact about it the reader may see — every state, so the card is the
 * whole record (`rejected` and `superseded` included, labelled).
 *
 * 404 for: an entity in another tenant, a staging entity the reader may not see
 * (`entityVisibleSql`), an unregistered domain type, and a domain row the reader sees no fact
 * about (admins: a row that does not exist in its table and has no fact).
 */
export async function getEntityCard(
  db: Database,
  scope: AccessScope,
  type: string,
  id: string
): Promise<EntityCard> {
  const staging = await readVisibleEntity(db, scope, id)
  if (staging && staging.type === type) {
    const ref: EntityRef = { kind: 'staging', type, id: staging.id }
    const facts = await selectFacts(db, scope, factsAbout(ref))
    return {
      entity: {
        kind: 'staging',
        type,
        typeLabel: knowledgeEntityType(type)?.label ?? type,
        id: staging.id,
        name: staging.name,
        aliases: staging.aliases,
        promotedTo:
          staging.promotedType && staging.promotedId
            ? { type: staging.promotedType, id: staging.promotedId }
            : null,
        mergedInto: staging.mergedInto,
        promotable: isPromotable(staging),
        reviewerUserId: staging.reviewerUserId,
      },
      facts: facts.map(toFact),
    }
  }
  const reg = knowledgeEntityType(type)
  if (!reg) throw new NotFoundError('Entity not found')
  const ref: EntityRef = { kind: 'domain', type, id }
  const facts = await selectFacts(db, scope, factsAbout(ref))
  const label = await domainLabel(db, scope.tenantId, type, id)
  if (facts.length === 0 && !(scope.bypass && label !== null)) {
    throw new NotFoundError('Entity not found')
  }
  // The names of the staging entities promoted to this row are its aliases here.
  const promoted = await db
    .select({ name: knowledgeEntities.name, aliases: knowledgeEntities.aliases })
    .from(knowledgeEntities)
    .where(
      and(
        eq(knowledgeEntities.tenantId, scope.tenantId),
        eq(knowledgeEntities.promotedType, type),
        eq(knowledgeEntities.promotedId, id),
        entityVisibleSql(scope)
      )
    )
  const name = label ?? promoted[0]?.name ?? id
  const aliases = [
    ...new Set(promoted.flatMap(p => [p.name, ...p.aliases]).filter(n => n !== name)),
  ]
  return {
    entity: {
      kind: 'domain',
      type,
      typeLabel: reg.label,
      id,
      name,
      aliases,
      promotedTo: null,
      mergedInto: null,
      promotable: false,
      reviewerUserId: null,
    },
    facts: facts.map(toFact),
  }
}

/** Could `promoteEntity` find a row for it: unsettled, of a type with a table or a resolver. */
function isPromotable(row: KnowledgeEntityRow): boolean {
  if (row.mergedInto || row.promotedId) return false
  const reg = knowledgeEntityType(row.type)
  return Boolean(reg && (reg.table || resolverFor(reg)))
}

/**
 * Does the outer possible-match entity have a candidate the reader may see — a domain row, or a
 * staging entity visible to them? The inner `knowledge_entities` is UNALIASED, so it shadows the
 * outer one inside the subquery and `entityVisibleSql` binds to the candidate (`facts-sql.ts`).
 * Without it the item is dropped from the page but would still be counted in the total.
 */
function hasVisibleCandidateSql(scope: AccessScope): SQL {
  return sql`exists (select 1 from jsonb_array_elements(${knowledgeEntities.possibleMatches}) as pm(c) where pm.c->>'kind' = 'domain' or exists (select 1 from ${knowledgeEntities} where ${knowledgeEntities.tenantId} = ${scope.tenantId} and ${knowledgeEntities.id}::text = pm.c->>'id' and ${entityVisibleSql(scope)}))`
}

// ── The review list ───────────────────────────────────────────────────────────────────────────

const OPEN_STATES = sql.raw(OPEN_REVIEW_FACT_STATES.map(s => `'${s}'`).join(', '))

/**
 * Is the outer fact an open item IN THE READER'S VIEW? Stored `unconfirmed` always is; stored
 * `conflicting` is when a conflict is visible, or when it would read `unconfirmed` without them.
 */
function openForReader(scope: AccessScope): SQL {
  if (scope.bypass) return sql`${knowledgeFacts.state} in (${OPEN_STATES})`
  return sql`(${knowledgeFacts.state} = 'unconfirmed' or (${knowledgeFacts.state} = 'conflicting' and (json_array_length(${visibleConflictsSql(scope)}) > 0 or (${knowledgeFacts.confirmedAt} is null and ${knowledgeFacts.confidence} < ${ACCEPT_CONFIDENCE}))))`
}

export interface ReviewReader {
  scope: AccessScope
  userId: string
  /** `manage KnowledgeFact` — sees (and settles) everyone's items. */
  canManage: boolean
}

/**
 * `GET /api/knowledge/review`: the open items addressed to the reader (all of them for a
 * manager, unless `mine`), newest first, paginated across both kinds with one UNION.
 *
 * - a FACT is open in the reader's view (`openForReader`) and its document is visible;
 * - a POSSIBLE MATCH is a staging entity with `possible_matches`, not merged or promoted, that
 *   the reader may see (`entityVisibleSql`); a staging candidate the reader may not see is left
 *   out of `candidates`, and an item with none left is neither listed nor counted.
 */
export async function listReviewItems(
  db: Database,
  reader: ReviewReader,
  query: KnowledgeReviewQuery
): Promise<{ items: KnowledgeReviewItem[]; total: number }> {
  const { scope } = reader
  const onlyMine = !reader.canManage || query.mine === true
  const factWhere = and(
    visibleFactsWhere(scope),
    openForReader(scope),
    onlyMine ? eq(knowledgeFacts.reviewerUserId, reader.userId) : undefined,
    query.entityType ? eq(knowledgeFacts.entityType, query.entityType) : undefined,
    query.entityId ? eq(knowledgeFacts.entityId, query.entityId) : undefined
  )
  const entityWhere = and(
    eq(knowledgeEntities.tenantId, scope.tenantId),
    isNotNull(knowledgeEntities.possibleMatches),
    sql`jsonb_array_length(${knowledgeEntities.possibleMatches}) > 0`,
    isNull(knowledgeEntities.mergedInto),
    isNull(knowledgeEntities.promotedId),
    entityVisibleSql(scope),
    hasVisibleCandidateSql(scope),
    onlyMine ? eq(knowledgeEntities.reviewerUserId, reader.userId) : undefined,
    query.entityType ? eq(knowledgeEntities.type, query.entityType) : undefined,
    query.entityId ? sql`${knowledgeEntities.id}::text = ${query.entityId}` : undefined
  )
  const wantFacts = query.kind !== 'possibleMatch'
  const wantEntities = query.kind !== 'fact'

  const factsQ = db
    .select({
      kind: sql<string>`'fact'`.as('kind'),
      id: sql<string>`${knowledgeFacts.id}::text`.as('id'),
      at: sql<Date>`${knowledgeFacts.createdAt}`.as('at'),
    })
    .from(knowledgeFacts)
    .innerJoin(
      documents,
      and(eq(documents.id, knowledgeFacts.documentId), eq(documents.tenantId, scope.tenantId))
    )
    .where(factWhere)
  const entitiesQ = db
    .select({
      kind: sql<string>`'possibleMatch'`.as('kind'),
      id: sql<string>`${knowledgeEntities.id}::text`.as('id'),
      at: sql<Date>`${knowledgeEntities.updatedAt}`.as('at'),
    })
    .from(knowledgeEntities)
    .where(entityWhere)

  const [factCount] = wantFacts
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(knowledgeFacts)
        .innerJoin(
          documents,
          and(eq(documents.id, knowledgeFacts.documentId), eq(documents.tenantId, scope.tenantId))
        )
        .where(factWhere)
    : [{ n: 0 }]
  const [entityCount] = wantEntities
    ? await db.select({ n: sql<number>`count(*)::int` }).from(knowledgeEntities).where(entityWhere)
    : [{ n: 0 }]
  const total = Number(factCount?.n ?? 0) + Number(entityCount?.n ?? 0)

  const offset = (query.page - 1) * query.pageSize
  const ordered = sql`at desc, id`
  const page =
    wantFacts && wantEntities
      ? await unionAll(factsQ, entitiesQ).orderBy(ordered).limit(query.pageSize).offset(offset)
      : wantFacts
        ? await factsQ
            .orderBy(desc(knowledgeFacts.createdAt), knowledgeFacts.id)
            .limit(query.pageSize)
            .offset(offset)
        : await entitiesQ
            .orderBy(desc(knowledgeEntities.updatedAt), knowledgeEntities.id)
            .limit(query.pageSize)
            .offset(offset)

  const factIds = page.filter(p => p.kind === 'fact').map(p => p.id)
  const entityIds = page.filter(p => p.kind === 'possibleMatch').map(p => p.id)
  const facts = factIds.length
    ? await selectFacts(db, scope, inArray(knowledgeFacts.id, factIds))
    : []
  const partnerIds = [...new Set(facts.flatMap(f => f.visibleConflicts))]
  const partners = partnerIds.length
    ? await selectFacts(db, scope, inArray(knowledgeFacts.id, partnerIds))
    : []
  const factById = new Map(facts.map(f => [f.row.id, f]))
  const names = await entityNames(
    db,
    scope.tenantId,
    facts.map(f => ({ kind: f.row.entityKind, type: f.row.entityType, id: f.row.entityId }))
  )
  const partnerById = new Map(partners.map(f => [f.row.id, f]))

  const entities = entityIds.length
    ? await db
        .select()
        .from(knowledgeEntities)
        .where(
          and(
            eq(knowledgeEntities.tenantId, scope.tenantId),
            inArray(knowledgeEntities.id, entityIds)
          )
        )
    : []
  const entityById = new Map(entities.map(e => [e.id, e]))
  const visibleCandidates = await visibleStagingIds(
    db,
    scope,
    entities.flatMap(e =>
      (e.possibleMatches ?? []).filter(c => c.kind === 'staging').map(c => c.id)
    )
  )

  const items: KnowledgeReviewItem[] = []
  for (const p of page) {
    if (p.kind === 'fact') {
      const f = factById.get(p.id)
      if (!f) continue
      const ref: EntityRef = { kind: f.row.entityKind, type: f.row.entityType, id: f.row.entityId }
      items.push({
        kind: 'fact',
        fact: toFact(f),
        entity: { ...ref, name: names.get(refKey(ref)) ?? ref.id },
        conflicts: f.visibleConflicts
          .map(id => partnerById.get(id))
          .filter((x): x is ReadFact => Boolean(x))
          .map(toFact),
      })
    } else {
      const e = entityById.get(p.id)
      if (!e) continue
      const candidates = (e.possibleMatches ?? []).filter(
        (c: PossibleMatchCandidate) => c.kind === 'domain' || visibleCandidates.has(c.id)
      )
      if (candidates.length === 0) continue
      items.push({
        kind: 'possibleMatch',
        entity: toKnowledgeEntity(e),
        candidates,
        reviewerUserId: e.reviewerUserId,
      })
    }
  }
  return { items, total }
}

/** Which of these staging entity ids the reader may see. */
export async function visibleStagingIds(
  db: Database,
  scope: AccessScope,
  ids: readonly string[]
): Promise<Set<string>> {
  const wanted = [...new Set(ids)].filter(id => UUID_RE.test(id))
  if (wanted.length === 0) return new Set()
  const rows = await db
    .select({ id: knowledgeEntities.id })
    .from(knowledgeEntities)
    .where(
      and(
        eq(knowledgeEntities.tenantId, scope.tenantId),
        inArray(knowledgeEntities.id, wanted),
        entityVisibleSql(scope)
      )
    )
  return new Set(rows.map(r => r.id))
}

// ── Browsing ──────────────────────────────────────────────────────────────────────────────────

/** The states a browse view counts: what is current, not the history. */
const CURRENT_FACT_STATES = ['accepted', 'unconfirmed', 'conflicting'] as const

const typeLabelOf = (type: string) => knowledgeEntityType(type)?.label ?? type

/**
 * `GET /api/knowledge/documents/:id/facts`: every fact read from one document, grouped by entity
 * (by name), each group in the order the facts appear in the text. The document must be one the
 * reader may see — else the 404 an absent one gets — and every fact goes through `selectFacts`,
 * so its conflicts are narrowed to the visible ones like everywhere else.
 */
export async function readDocumentFacts(
  db: Database,
  scope: AccessScope,
  documentId: string
): Promise<DocumentFactsResponse> {
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, scope.tenantId),
        eq(documents.id, documentId),
        visibleDocuments(scope)
      )
    )
  if (!doc) throw new NotFoundError('Document not found')
  const facts = await selectFacts(db, scope, eq(knowledgeFacts.documentId, documentId), {
    orderBy: [sql`${knowledgeFacts.charStart} asc nulls last`, asc(knowledgeFacts.createdAt)],
  })
  const refs = new Map<string, EntityRef>()
  for (const f of facts) {
    const ref: EntityRef = { kind: f.row.entityKind, type: f.row.entityType, id: f.row.entityId }
    refs.set(refKey(ref), ref)
  }
  const names = await entityNames(db, scope.tenantId, [...refs.values()])
  const groups = new Map<string, DocumentFactGroup>()
  for (const f of facts) {
    const ref: EntityRef = { kind: f.row.entityKind, type: f.row.entityType, id: f.row.entityId }
    const key = refKey(ref)
    const group = groups.get(key) ?? {
      entity: { ...ref, name: names.get(key) ?? ref.id, typeLabel: typeLabelOf(ref.type) },
      facts: [],
    }
    group.facts.push(toFact(f))
    groups.set(key, group)
  }
  return {
    documentId,
    entityTypesRegistered: knowledgeEntityTypes().length,
    groups: [...groups.values()].sort((a, b) => a.entity.name.localeCompare(b.entity.name)),
  }
}

/** `%q%` for ILIKE, with the pattern characters of `q` itself escaped. */
const containsPattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`

/**
 * The outer fact's entity is named `q`: a staging entity's name or alias, or — for a domain row —
 * those of a staging entity promoted to it. A domain row's own label (its table's column) is not
 * searched: it lives in an app table this query cannot reach generically.
 */
function entityNamedSql(scope: AccessScope, q: string): SQL {
  const pattern = containsPattern(q)
  return sql`exists (select 1 from ${sql.raw('knowledge_entities ke')} where ke.tenant_id = ${scope.tenantId} and ((${knowledgeFacts.entityKind} = 'staging' and ke.id::text = ${knowledgeFacts.entityId}) or (${knowledgeFacts.entityKind} = 'domain' and ke.promoted_type = ${knowledgeFacts.entityType} and ke.promoted_id = ${knowledgeFacts.entityId})) and (ke.name ilike ${pattern} or exists (select 1 from unnest(ke.aliases) as al(a) where al.a ilike ${pattern})))`
}

/**
 * `GET /api/knowledge/entities`: the entities the reader may see a current fact about, with how
 * many such facts and how many need a look IN THE READER'S VIEW (`openForReader`) — one GROUP BY
 * over `knowledge_facts` joined to visible documents, so a fact from a hidden document is never
 * counted and an entity known only from hidden documents is never listed. Entities needing a look
 * first, then the most recently observed. The facets count entities over every visible current
 * fact, unfiltered, so a filter never hides its own alternatives.
 */
export async function listKnowledgeEntities(
  db: Database,
  scope: AccessScope,
  query: KnowledgeEntityListQuery,
  window: { limit: number; offset: number }
): Promise<{
  items: KnowledgeEntitySummary[]
  total: number
  facets: KnowledgeEntityList['facets']
}> {
  const current = and(
    visibleFactsWhere(scope),
    inArray(knowledgeFacts.state, [...CURRENT_FACT_STATES])
  )
  const where = and(
    current,
    query.type?.length ? inArray(knowledgeFacts.entityType, query.type) : undefined,
    query.sourceKind?.length ? inArray(knowledgeFacts.sourceKind, query.sourceKind) : undefined,
    query.q ? entityNamedSql(scope, query.q) : undefined
  )
  const open = sql<number>`(count(*) filter (where ${openForReader(scope)}))::int`
  const last = sql`max(${knowledgeFacts.observedAt})`
  const joinDocuments = and(
    eq(documents.id, knowledgeFacts.documentId),
    eq(documents.tenantId, scope.tenantId)
  )
  // A factory: drizzle builders are mutable, so the page's `.limit()` must not reach the count.
  const grouped = () =>
    db
      .select({
        kind: knowledgeFacts.entityKind,
        type: knowledgeFacts.entityType,
        id: knowledgeFacts.entityId,
        facts: sql<number>`(count(*))::int`.mapWith(Number).as('facts'),
        needsLook: open.mapWith(Number).as('needs_look'),
        lastObservedAt: last.mapWith(knowledgeFacts.observedAt).as('last_observed_at'),
      })
      .from(knowledgeFacts)
      .innerJoin(documents, joinDocuments)
      // The tenant spelled out here too (it is also in `where`), so this closure reads as
      // tenant-scoped on its own — what `tests/config/unscoped-allowlist.test.ts` checks.
      .where(and(eq(knowledgeFacts.tenantId, scope.tenantId), where))
      .groupBy(knowledgeFacts.entityKind, knowledgeFacts.entityType, knowledgeFacts.entityId)
      .having(query.needsLook ? sql`${open} > 0` : undefined)
  const distinctEntities = sql<number>`(count(distinct (${knowledgeFacts.entityKind}, ${knowledgeFacts.entityType}, ${knowledgeFacts.entityId})))::int`
  const [page, [total], types, sourceKinds] = await Promise.all([
    grouped()
      .orderBy(desc(sql`${open} > 0`), desc(last), asc(knowledgeFacts.entityId))
      .limit(window.limit)
      .offset(window.offset),
    db.select({ n: sql<number>`(count(*))::int`.mapWith(Number) }).from(grouped().as('g')),
    db
      .select({ value: knowledgeFacts.entityType, count: distinctEntities.mapWith(Number) })
      .from(knowledgeFacts)
      .innerJoin(documents, joinDocuments)
      .where(current)
      .groupBy(knowledgeFacts.entityType)
      .orderBy(knowledgeFacts.entityType),
    db
      .select({ value: knowledgeFacts.sourceKind, count: distinctEntities.mapWith(Number) })
      .from(knowledgeFacts)
      .innerJoin(documents, joinDocuments)
      .where(current)
      .groupBy(knowledgeFacts.sourceKind)
      .orderBy(knowledgeFacts.sourceKind),
  ])
  const refs: EntityRef[] = page.map(r => ({ kind: r.kind, type: r.type, id: r.id }))
  const names = await entityNames(db, scope.tenantId, refs)
  return {
    items: page.map(r => {
      const ref: EntityRef = { kind: r.kind, type: r.type, id: r.id }
      return {
        entity: { ...ref, name: names.get(refKey(ref)) ?? ref.id, typeLabel: typeLabelOf(r.type) },
        facts: r.facts,
        needsLook: r.needsLook,
        lastObservedAt: r.lastObservedAt,
      }
    }),
    total: total?.n ?? 0,
    facets: {
      types: types
        .map(t => ({ value: t.value, label: typeLabelOf(t.value), count: t.count }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      sourceKinds: sourceKinds.map(k => ({
        value: k.value,
        label: SOURCE_KIND_LABELS[k.value],
        count: k.count,
      })),
    },
  }
}

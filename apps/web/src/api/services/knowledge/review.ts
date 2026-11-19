/**
 * Settling knowledge review items (D43, decisions 4–5): a person's `confirm` / `reject` /
 * `prefer` on a fact, and `merge` / `promote` / `keepSeparate` on a staging entity.
 *
 * **Who.** The item's reviewer (`reviewerUserId` — the document's owner, or the person who
 * connected the integration), or anyone with `manage KnowledgeFact` (admin+). Somebody else gets
 * 403 — but only once the item is visible to them: a fact whose document they cannot see, or an
 * entity they may not see, is the 404 an absent one is.
 *
 * **What a person decides survives re-extraction.** `reject` and `prefer` write `rejected`, and
 * `confirm` / `prefer` set `confirmed_by` / `confirmed_at`. Re-extraction of OTHER documents never
 * touches them (`removeDocumentFacts` deletes only the re-read document's facts); re-extracting
 * the fact's OWN document keeps a decided fact and matches the new reading to it by entity, key
 * and value (`extract.ts`, step 2) — only a fact the new text no longer states goes.
 *
 * **Only what the reviewer can see is touched by choice.** `prefer` rejects the conflicts the
 * reviewer can see; one from a document hidden from them stays linked, so the preferred fact
 * stays `conflicting` for the admins who can see both sides. `reject` unlinks the rejected fact
 * from EVERY conflict, hidden ones included: a fact disagreeing with a rejected one is incoherent,
 * and restoring it reveals nothing to the reviewer (`affected` lists only facts they can see).
 *
 * **`prefer` never decides for somebody else.** Rejecting the other sides is settling them, so a
 * reader without `manage KnowledgeFact` may prefer only when every visible conflict is an item
 * they review and no other person confirmed; otherwise the whole action is a 403
 * `fact_conflict_needs_admin` and nothing changes — the conflict stays open for an admin, and the
 * reader can still `reject` their own side (`assertMaySettleConflicts`).
 *
 * **Merge and promote** move a staging entity's facts onto another entity, then decide again,
 * with `decideFactState`, every key BOTH held answerable facts for — the two may now agree
 * (corroboration) or disagree (a new conflict), reading the value verdicts a decision model gave
 * either side (`knowledge_value_judgements`, moved along). Keys only one side held keep their states. These
 * are person actions over HTTP, so there is no approval gate: `Tool.requiresApproval` is the gate
 * an AGENT tool would need, and none is exposed. Nothing here writes a domain column — promoting
 * records `promoted_type` / `promoted_id` on the staging row and re-points the facts.
 *
 * **Every action nudges** `entity.changed { entity: 'knowledge', id }` tenant-wide after its
 * transaction commits (`realtime`, trailing), so the review badge, the list and an open entity
 * page refetch. The payload is an id; what a reader then sees is what their own refetch returns.
 */
import type {
  EntityActionResponse,
  EntityTarget,
  FactReviewAction,
  FactReviewResponse,
  FactState,
} from '@rocketflare/shared/ai/knowledge-facts'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { and, asc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Database } from '../../../db/client'
import { type KnowledgeEntityRow, knowledgeEntities, knowledgeFacts } from '../../../db/schema'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/core/errors'
import type { AccessScope } from '../access'
import { nudge, type Realtime, realtimeEvent } from '../realtime'
import { normaliseName } from './entities'
import {
  type EntityRef,
  type ReviewReader,
  readVisibleEntity,
  readVisibleFact,
  selectFacts,
  toFact,
  toKnowledgeEntity,
  viewState,
} from './facts-read'
import { restoredStateSql } from './facts-sql'
import { loadJudged, moveJudgements } from './judgements'
import { knowledgeEntityType } from './registry'
import { resolverFor } from './resolve'
import { decideFactState, type HeldFact } from './state'
import { factCompareKey } from './values'

const ANSWERABLE: readonly FactState[] = ['accepted', 'unconfirmed', 'conflicting']

/** The one nudge every action sends — `knowledge` is the UI's query-key root for all of it. */
function nudgeKnowledge(realtime: Realtime | undefined, tenantId: string, id: string) {
  nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity: 'knowledge', id }))
}

function assertMayReview(reader: ReviewReader, reviewerUserId: string | null) {
  if (reader.canManage || reviewerUserId === reader.userId) return
  throw new ForbiddenError('Only the reviewer of this item or an admin can settle it')
}

// ── Facts ─────────────────────────────────────────────────────────────────────────────────────

/**
 * `prefer` rejects every visible conflict, so a reader who cannot manage may prefer only when
 * each of them is an item they could settle directly AND no other person has confirmed it. One
 * that fails is a 403 for the whole action (inside the transaction, so nothing is written): the
 * conflict stays for an admin, and the reader may still `reject` their own side.
 */
async function assertMaySettleConflicts(tx: Database, reader: ReviewReader, ids: string[]) {
  if (reader.canManage || ids.length === 0) return
  const others = await tx
    .select({
      reviewerUserId: knowledgeFacts.reviewerUserId,
      confirmedBy: knowledgeFacts.confirmedBy,
      confirmedAt: knowledgeFacts.confirmedAt,
    })
    .from(knowledgeFacts)
    .where(and(eq(knowledgeFacts.tenantId, reader.scope.tenantId), inArray(knowledgeFacts.id, ids)))
  const blocked = others.some(
    o =>
      o.reviewerUserId !== reader.userId ||
      (o.confirmedAt !== null && o.confirmedBy !== reader.userId)
  )
  if (blocked) {
    throw new ForbiddenError(
      'A fact this disagrees with is not yours to set aside, so an admin decides between them — you can still mark this one as not right',
      ERROR_CODES.factConflictNeedsAdmin
    )
  }
}

/**
 * Reject one fact inside `tx`: `rejected`, unlinked from every conflict; a fact left conflicting
 * with nothing, or superseded by it, returns to `accepted` / `unconfirmed`. Returns the ids whose
 * state or links changed (the fact itself included).
 */
async function rejectFact(tx: Database, tenantId: string, id: string): Promise<string[]> {
  const touched = new Set<string>([id])
  await tx
    .update(knowledgeFacts)
    .set({ state: 'rejected', conflictsWith: [], updatedAt: new Date() })
    .where(and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.id, id)))
  const unlinked = await tx
    .update(knowledgeFacts)
    .set({
      conflictsWith: sql`array_remove(${knowledgeFacts.conflictsWith}, ${id}::uuid)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        sql`${id}::uuid = any(${knowledgeFacts.conflictsWith})`
      )
    )
    .returning({ id: knowledgeFacts.id })
  for (const r of unlinked) touched.add(r.id)
  if (unlinked.length > 0) {
    await tx
      .update(knowledgeFacts)
      .set({ state: restoredStateSql })
      .where(
        and(
          eq(knowledgeFacts.tenantId, tenantId),
          inArray(
            knowledgeFacts.id,
            unlinked.map(r => r.id)
          ),
          eq(knowledgeFacts.state, 'conflicting'),
          sql`cardinality(${knowledgeFacts.conflictsWith}) = 0`
        )
      )
  }
  const restored = await tx
    .update(knowledgeFacts)
    .set({ state: restoredStateSql, supersededById: null, updatedAt: new Date() })
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        eq(knowledgeFacts.supersededById, id),
        eq(knowledgeFacts.state, 'superseded')
      )
    )
    .returning({ id: knowledgeFacts.id })
  for (const r of restored) touched.add(r.id)
  return [...touched]
}

/**
 * `POST /api/knowledge/facts/:id/review`. The order is the contract: visible (else 404) → may
 * review (else 403) → reviewable (409 `fact_not_reviewable` for `rejected` / `superseded`;
 * `confirm` on a fact conflicting in the reader's view is 409 `fact_conflicting`) → write.
 */
export async function reviewFact(
  db: Database,
  reader: ReviewReader,
  factId: string,
  action: FactReviewAction,
  realtime?: Realtime
): Promise<FactReviewResponse> {
  const { scope } = reader
  const before = await readVisibleFact(db, scope, factId)
  assertMayReview(reader, before.row.reviewerUserId)
  // In the reader's view: a fact superseded only by one they cannot see is reviewable for them.
  const viewed = viewState(before)
  if (!ANSWERABLE.includes(viewed)) {
    throw new ConflictError(
      `This fact is ${viewed} — there is nothing left to review`,
      ERROR_CODES.factNotReviewable
    )
  }
  if (action === 'confirm' && viewed === 'conflicting') {
    throw new ConflictError(
      'Another source disagrees with this fact: choose it with "prefer", or "reject" it',
      ERROR_CODES.factConflicting
    )
  }

  const touched = await db.transaction(async tx => {
    const ids = new Set<string>([factId])
    if (action === 'reject') {
      for (const id of await rejectFact(tx, scope.tenantId, factId)) ids.add(id)
      return ids
    }
    if (action === 'prefer') {
      await assertMaySettleConflicts(tx, reader, before.visibleConflicts)
      for (const other of before.visibleConflicts) {
        for (const id of await rejectFact(tx, scope.tenantId, other)) ids.add(id)
      }
    }
    // confirm, or the chosen side of a prefer: confirmed by this person; still `conflicting` only
    // while a conflict the reader could not see remains linked, and still `superseded` while the
    // later fact they could not see stands.
    await tx
      .update(knowledgeFacts)
      .set({
        state: sql`case when ${knowledgeFacts.state} = 'superseded' and ${knowledgeFacts.supersededById} is not null then 'superseded' when cardinality(${knowledgeFacts.conflictsWith}) > 0 then 'conflicting' else 'accepted' end`,
        confirmedBy: reader.userId,
        confirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(knowledgeFacts.tenantId, scope.tenantId), eq(knowledgeFacts.id, factId)))
    return ids
  })
  nudgeKnowledge(realtime, scope.tenantId, factId)

  const after = await selectFacts(db, scope, inArray(knowledgeFacts.id, [...touched]))
  const fact = after.find(f => f.row.id === factId)
  if (!fact) throw new NotFoundError('Fact not found')
  return {
    fact: toFact(fact),
    affected: after.filter(f => f.row.id !== factId).map(toFact),
  }
}

// ── Recomputing a key after a merge ───────────────────────────────────────────────────────────

/**
 * Decide again every answerable fact of one entity and key, oldest first, exactly as extraction
 * would have had they arrived in that order: each against the ones before it (`decideFactState`).
 * A fact a person confirmed counts as fully confident. `rejected` and `superseded` facts are
 * history and keep their state.
 */
export async function recomputeKey(
  tx: Database,
  tenantId: string,
  ref: EntityRef,
  key: string
): Promise<void> {
  const facts = await tx
    .select()
    .from(knowledgeFacts)
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        eq(knowledgeFacts.entityKind, ref.kind),
        eq(knowledgeFacts.entityType, ref.type),
        eq(knowledgeFacts.entityId, ref.id),
        eq(knowledgeFacts.key, key),
        inArray(knowledgeFacts.state, [...ANSWERABLE])
      )
    )
    .orderBy(asc(knowledgeFacts.observedAt), asc(knowledgeFacts.createdAt))
  interface Next {
    state: FactState
    conflictsWith: Set<string>
    supersededById: string | null
  }
  const next = new Map<string, Next>()
  const held: HeldFact[] = []
  const { judged } = await loadJudged(tx, tenantId, ref, key)
  for (const f of facts) {
    const decision = decideFactState(
      {
        valueKey: factCompareKey(f),
        confidence: f.confirmedAt ? 1 : f.confidence,
        validFrom: f.validFrom,
        validTo: f.validTo,
      },
      held
        .filter(h => ANSWERABLE.includes(next.get(h.id)?.state ?? h.state))
        .map(h => ({ ...h, state: next.get(h.id)?.state ?? h.state })),
      judged
    )
    next.set(f.id, {
      state: decision.state,
      conflictsWith: new Set(decision.conflictsWith),
      supersededById: decision.supersededBy,
    })
    for (const id of decision.conflictsWith) {
      const n = next.get(id)
      if (n) {
        n.state = 'conflicting'
        n.conflictsWith.add(f.id)
      }
    }
    for (const id of decision.supersedes) {
      const n = next.get(id)
      if (n) {
        n.state = 'superseded'
        n.supersededById = f.id
        n.conflictsWith.clear()
      }
    }
    for (const id of decision.confirms) {
      const n = next.get(id)
      if (n?.state === 'unconfirmed') n.state = 'accepted'
    }
    held.push({
      id: f.id,
      state: decision.state,
      valueKey: factCompareKey(f),
      validFrom: f.validFrom,
      validTo: f.validTo,
    })
  }
  for (const [id, n] of next) {
    await tx
      .update(knowledgeFacts)
      .set({
        state: n.state,
        conflictsWith: [...n.conflictsWith],
        supersededById: n.supersededById,
        updatedAt: new Date(),
      })
      .where(and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.id, id)))
  }
}

/** Keys with answerable facts on this entity. */
async function answerableKeys(
  tx: Database,
  tenantId: string,
  ref: EntityRef
): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ key: knowledgeFacts.key })
    .from(knowledgeFacts)
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        eq(knowledgeFacts.entityKind, ref.kind),
        eq(knowledgeFacts.entityType, ref.type),
        eq(knowledgeFacts.entityId, ref.id),
        inArray(knowledgeFacts.state, [...ANSWERABLE])
      )
    )
  return new Set(rows.map(r => r.key))
}

/** Re-point every fact of `from` at `to`, then recompute the keys both held. */
async function moveFacts(
  tx: Database,
  tenantId: string,
  from: EntityRef,
  to: EntityRef
): Promise<{ moved: number; recomputedKeys: string[] }> {
  const fromKeys = await answerableKeys(tx, tenantId, from)
  const toKeys = await answerableKeys(tx, tenantId, to)
  const moved = await tx
    .update(knowledgeFacts)
    .set({ entityKind: to.kind, entityType: to.type, entityId: to.id, updatedAt: new Date() })
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        eq(knowledgeFacts.entityKind, from.kind),
        eq(knowledgeFacts.entityType, from.type),
        eq(knowledgeFacts.entityId, from.id)
      )
    )
    .returning({ id: knowledgeFacts.id })
  await moveJudgements(tx, tenantId, from, to)
  const both = [...fromKeys].filter(k => toKeys.has(k)).sort()
  for (const key of both) await recomputeKey(tx, tenantId, to, key)
  return { moved: moved.length, recomputedKeys: both }
}

// ── Entities ──────────────────────────────────────────────────────────────────────────────────

/** The source of a merge / promote / keep-separate: visible (404), the reader's to settle (403). */
async function settleableEntity(
  db: Database,
  reader: ReviewReader,
  id: string
): Promise<KnowledgeEntityRow> {
  const row = await readVisibleEntity(db, reader.scope, id)
  if (!row) throw new NotFoundError('Entity not found')
  assertMayReview(reader, row.reviewerUserId)
  if (row.mergedInto || row.promotedId) {
    throw new ConflictError('This entity was already merged or promoted', ERROR_CODES.entitySettled)
  }
  return row
}

const targetNotFound = () =>
  new BadRequestError(
    'The target entity does not exist in this workspace (or is of another type)',
    ERROR_CODES.entityTargetNotFound
  )

/**
 * Does `id` name a row of `type` in this tenant? Through the registration's table (by its id
 * column), else its `resolve` over the entity's own names. A type with neither cannot be
 * promoted to.
 */
async function domainRowExists(
  db: Database,
  scope: AccessScope,
  entity: KnowledgeEntityRow,
  id: string
): Promise<boolean> {
  const reg = knowledgeEntityType(entity.type)
  if (reg?.table) {
    const columns = getTableColumns(reg.table)
    const idColumn = (reg.idColumn ?? columns.id) as AnyPgColumn
    const tenantColumn = columns.tenantId as AnyPgColumn
    const [row] = await db
      .select({ id: sql<string>`${idColumn}::text` })
      .from(reg.table)
      .where(and(eq(tenantColumn, scope.tenantId), sql`${idColumn}::text = ${id}`))
      .limit(1)
    return Boolean(row)
  }
  const resolver = reg ? resolverFor(reg) : null
  if (!resolver) {
    throw new BadRequestError(
      `Entity type ${entity.type} has no table or resolver to promote to`,
      ERROR_CODES.entityTypeNotPromotable
    )
  }
  for (const name of [entity.name, ...entity.aliases]) {
    const found = await resolver(name, { db, access: { ...scope, bypass: true }, limit: 20 })
    if (found.some(c => c.id === id)) return true
  }
  return false
}

/** `POST /api/knowledge/entities/:id/promote`. */
export async function promoteEntity(
  db: Database,
  reader: ReviewReader,
  entityId: string,
  domainId: string,
  realtime?: Realtime
): Promise<EntityActionResponse> {
  const entity = await settleableEntity(db, reader, entityId)
  if (!knowledgeEntityType(entity.type)) {
    throw new BadRequestError(
      `Entity type ${entity.type} is not registered`,
      ERROR_CODES.entityTypeNotPromotable
    )
  }
  if (!(await domainRowExists(db, reader.scope, entity, domainId))) throw targetNotFound()
  const tenantId = reader.scope.tenantId
  const to: EntityRef = { kind: 'domain', type: entity.type, id: domainId }
  const result = await db.transaction(async tx => {
    const [row] = await tx
      .update(knowledgeEntities)
      .set({
        promotedType: entity.type,
        promotedId: domainId,
        possibleMatches: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(knowledgeEntities.tenantId, tenantId),
          eq(knowledgeEntities.id, entity.id),
          isNull(knowledgeEntities.promotedId),
          isNull(knowledgeEntities.mergedInto)
        )
      )
      .returning()
    if (!row)
      throw new ConflictError(
        'This entity was already merged or promoted',
        ERROR_CODES.entitySettled
      )
    const { moved, recomputedKeys } = await moveFacts(
      tx,
      tenantId,
      { kind: 'staging', type: entity.type, id: entity.id },
      to
    )
    return { entity: toKnowledgeEntity(row), into: to, movedFacts: moved, recomputedKeys }
  })
  nudgeKnowledge(realtime, tenantId, entity.id)
  return result
}

/**
 * `POST /api/knowledge/entities/:id/merge`. Into a staging entity: same type, not itself, not
 * merged, visible to the reader. Its names become the target's aliases; the facts move to the
 * target — or, when the target was promoted, to the row it was promoted to. Into a domain row:
 * `promoteEntity`.
 */
export async function mergeEntity(
  db: Database,
  reader: ReviewReader,
  entityId: string,
  into: EntityTarget,
  realtime?: Realtime
): Promise<EntityActionResponse> {
  if (into.kind === 'domain') return promoteEntity(db, reader, entityId, into.id, realtime)
  const entity = await settleableEntity(db, reader, entityId)
  if (into.id === entity.id) {
    throw new BadRequestError(
      'An entity cannot be merged into itself',
      ERROR_CODES.entityTargetNotFound
    )
  }
  const target = await readVisibleEntity(db, reader.scope, into.id)
  if (!target || target.type !== entity.type || target.mergedInto) throw targetNotFound()
  const tenantId = reader.scope.tenantId
  const to: EntityRef =
    target.promotedType && target.promotedId
      ? { kind: 'domain', type: target.promotedType, id: target.promotedId }
      : { kind: 'staging', type: target.type, id: target.id }
  const result = await db.transaction(async tx => {
    const [row] = await tx
      .update(knowledgeEntities)
      .set({ mergedInto: target.id, possibleMatches: null, updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeEntities.tenantId, tenantId),
          eq(knowledgeEntities.id, entity.id),
          isNull(knowledgeEntities.promotedId),
          isNull(knowledgeEntities.mergedInto)
        )
      )
      .returning()
    if (!row)
      throw new ConflictError(
        'This entity was already merged or promoted',
        ERROR_CODES.entitySettled
      )
    const known = new Set([target.name, ...target.aliases].map(normaliseName))
    const fresh = [entity.name, ...entity.aliases].filter(n => {
      const k = normaliseName(n)
      if (known.has(k)) return false
      known.add(k)
      return true
    })
    if (fresh.length > 0) {
      await tx
        .update(knowledgeEntities)
        .set({ aliases: [...target.aliases, ...fresh], updatedAt: new Date() })
        .where(and(eq(knowledgeEntities.tenantId, tenantId), eq(knowledgeEntities.id, target.id)))
    }
    const { moved, recomputedKeys } = await moveFacts(
      tx,
      tenantId,
      { kind: 'staging', type: entity.type, id: entity.id },
      to
    )
    return { entity: toKnowledgeEntity(row), into: to, movedFacts: moved, recomputedKeys }
  })
  nudgeKnowledge(realtime, tenantId, entity.id)
  return result
}

/** `POST /api/knowledge/entities/:id/keep-separate` — "not the same": the possible match is closed. */
export async function keepEntitySeparate(
  db: Database,
  reader: ReviewReader,
  entityId: string,
  realtime?: Realtime
): Promise<EntityActionResponse> {
  const entity = await settleableEntity(db, reader, entityId)
  const [row] = await db
    .update(knowledgeEntities)
    .set({ possibleMatches: null, updatedAt: new Date() })
    .where(
      and(
        eq(knowledgeEntities.tenantId, reader.scope.tenantId),
        eq(knowledgeEntities.id, entity.id)
      )
    )
    .returning()
  if (!row) throw new NotFoundError('Entity not found')
  nudgeKnowledge(realtime, reader.scope.tenantId, entity.id)
  return { entity: toKnowledgeEntity(row), into: null, movedFacts: 0, recomputedKeys: [] }
}

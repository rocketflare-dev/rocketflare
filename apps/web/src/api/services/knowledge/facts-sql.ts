/**
 * The SQL fragments every reader of knowledge facts shares (D43): what a fact's state returns to
 * when its disagreement goes away, which of its conflicts a reader may see, and whether a reader
 * may see an entity at all.
 *
 * **A fact is read through its document.** There is no grants table for facts: a query over
 * `knowledge_facts` inner-joins `documents` and ANDs `visibleDocuments(scope)` onto the tenant
 * predicate, so a fact whose document you cannot see does not exist for you. The subqueries
 * below follow the same rule for the facts a row POINTS at — a conflict partner, an entity's
 * facts — and are written with a literal alias for the inner `knowledge_facts` (`kf2`) and an
 * UNALIASED inner `documents`, which shadows any outer one, because `visibleDocuments` renders
 * `"documents".…` and must bind to the inner row (`src/api/services/CLAUDE.md`, Visibility).
 */
import { type SQL, sql } from 'drizzle-orm'
import { documents, knowledgeEntities, knowledgeFacts } from '../../../db/schema'
import { type AccessScope, visibleDocuments } from '../access'
import { ACCEPT_CONFIDENCE } from './state'

/**
 * The state a fact returns to when what it disagreed with, or was replaced by, is gone: a person
 * confirmed it, or it was read confidently → `accepted`; else `unconfirmed`.
 */
export const restoredStateSql = sql`case when ${knowledgeFacts.confirmedAt} is not null or ${knowledgeFacts.confidence} >= ${ACCEPT_CONFIDENCE} then 'accepted' else 'unconfirmed' end`

/** The same decision in code, for a row already read. */
export function restoredState(fact: {
  confirmedAt: Date | null
  confidence: number
}): 'accepted' | 'unconfirmed' {
  return fact.confirmedAt !== null || fact.confidence >= ACCEPT_CONFIDENCE
    ? 'accepted'
    : 'unconfirmed'
}

/** `"documents"."tenant_id" = $t AND <visibility>` — for a subquery whose FROM has `documents`. */
function visibleDocumentIn(scope: AccessScope): SQL {
  const visible = visibleDocuments(scope)
  return visible
    ? sql`${documents.tenantId} = ${scope.tenantId} and ${visible}`
    : sql`${documents.tenantId} = ${scope.tenantId}`
}

/**
 * The ids in the outer fact's `conflicts_with` the reader may see, as a JSON array (JSON rather
 * than `uuid[]` so both drivers hand back a plain array from a raw column). Admin-level readers
 * see every one.
 */
export function visibleConflictsSql(scope: AccessScope): SQL<string[]> {
  return sql<
    string[]
  >`(select coalesce(json_agg(kf2.id), '[]'::json) from ${sql.raw('knowledge_facts kf2')} inner join ${documents} on ${documents.id} = kf2.document_id where kf2.tenant_id = ${scope.tenantId} and kf2.id = any(${knowledgeFacts.conflictsWith}) and ${visibleDocumentIn(scope)})`
}

/**
 * Is the outer fact `superseded` only by a fact the reader may not see? Then, for that reader, it
 * is the fact nothing replaced: it reads as its restored state (`restoredState`), with no
 * `supersededById`, and it is answerable and current like any other — else a hidden document
 * would leak "a later source you cannot see replaced this". Admin-level readers: never.
 */
export function supersededOutOfViewSql(scope: AccessScope): SQL {
  if (scope.bypass) return sql`false`
  return sql`(${knowledgeFacts.state} = 'superseded' and ${knowledgeFacts.supersededById} is not null and not exists (select 1 from ${sql.raw('knowledge_facts kf2')} inner join ${documents} on ${documents.id} = kf2.document_id where kf2.tenant_id = ${scope.tenantId} and kf2.id = ${knowledgeFacts.supersededById} and ${visibleDocumentIn(scope)}))`
}

/**
 * The outer fact's state is one of `states` IN THE READER'S VIEW — stored so, or superseded out of
 * their view (`supersededOutOfViewSql`) when `states` holds the state it then reads as.
 */
export function stateInViewSql(scope: AccessScope, states: readonly string[]): SQL {
  const stored = sql`${knowledgeFacts.state} in (${sql.join(
    states.map(s => sql`${s}`),
    sql`, `
  )})`
  const restored = states.filter(s => s === 'accepted' || s === 'unconfirmed')
  if (scope.bypass || restored.length === 0) return stored
  return sql`(${stored} or (${supersededOutOfViewSql(scope)} and ${restoredStateSql} in (${sql.join(
    restored.map(s => sql`${s}`),
    sql`, `
  )})))`
}

/**
 * Is the outer `knowledge_entities` row visible to the reader? Admin-level: always. Otherwise
 * when at least one fact the reader may see is about it — or about where it went (the staging
 * entity it was merged into, the domain row it was promoted to). A staging entity has no
 * visibility of its own; its name came from a document, and a name read from a restricted
 * document must not reach somebody who cannot open it.
 */
export function entityVisibleSql(scope: AccessScope): SQL {
  if (scope.bypass) return sql`true`
  const e = knowledgeEntities
  return sql`exists (select 1 from ${sql.raw('knowledge_facts kf2')} inner join ${documents} on ${documents.id} = kf2.document_id where kf2.tenant_id = ${scope.tenantId} and ${visibleDocumentIn(scope)} and (
    (kf2.entity_kind = 'staging' and kf2.entity_id = ${e.id}::text)
    or (${e.mergedInto} is not null and kf2.entity_kind = 'staging' and kf2.entity_id = ${e.mergedInto}::text)
    or (${e.promotedId} is not null and kf2.entity_kind = 'domain' and kf2.entity_type = ${e.promotedType} and kf2.entity_id = ${e.promotedId})
  ))`
}

/** Does the reader see at least one fact about this entity? (For a domain row, which has no row of ours.) */
export function factsAboutVisibleSql(
  scope: AccessScope,
  ref: { kind: 'domain' | 'staging'; type: string; id: string }
): SQL {
  return sql`exists (select 1 from ${sql.raw('knowledge_facts kf2')} inner join ${documents} on ${documents.id} = kf2.document_id where kf2.tenant_id = ${scope.tenantId} and ${visibleDocumentIn(scope)} and kf2.entity_kind = ${ref.kind} and kf2.entity_type = ${ref.type} and kf2.entity_id = ${ref.id})`
}

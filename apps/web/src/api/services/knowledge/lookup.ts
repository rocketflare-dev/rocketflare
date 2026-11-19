/**
 * Facts for a MODEL (D43): what `lookup_facts` and `search_knowledge`'s `facts` block answer —
 * facts grouped by entity, each cited (document title and quote) and labelled with its state in
 * the reader's view, through the same visibility as every other fact read (`facts-read.ts`).
 *
 * - **Answerable only.** `accepted`, `unconfirmed` and `conflicting`; `rejected` never;
 *   `superseded` only when `asOf` falls inside its validity window (it WAS true then). With
 *   `asOf`, a fact whose window excludes that day is left out.
 * - **Both sides.** A conflicting fact's other sides are on the same entity and key, so they come
 *   back in the same group, each with its own source; `preferred` marks the side an answer leads
 *   with (`preferredFact` over the visible sides) — both are always to be cited.
 */
import {
  ANSWERABLE_FACT_STATES,
  type FactHit,
  type FactHitGroup,
  type LookupFactsResult,
  parseValueRef,
  preferredFact,
} from '@rocketflare/shared/ai/knowledge-facts'
import { and, asc, eq, inArray, or, type SQL, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { knowledgeFacts } from '../../../db/schema'
import type { AccessScope } from '../access'
import { entitiesMentionedIn, type FoundEntity, findEntitiesByName } from './entities'
import {
  type EntityRef,
  entityNames,
  type ReadFact,
  refKey,
  selectFacts,
  viewState,
} from './facts-read'
import { stateInViewSql } from './facts-sql'
import { knowledgeEntityTypes } from './registry'

/** Entities one lookup resolves a name to. */
export const LOOKUP_MAX_ENTITIES = 5
/** Facts one answer carries; the rest are counted in `omitted`. */
export const LOOKUP_MAX_FACTS = 60
/** Entities and facts `search_knowledge` adds for the entities a query mentions. */
export const SEARCH_FACTS_MAX_ENTITIES = 3
export const SEARCH_FACTS_MAX_FACTS = 24

export const FACTS_NOTE =
  'Each fact has a `state`. accepted: state it, citing its document. unconfirmed: use it but say it is unconfirmed. conflicting: the sources disagree — give EVERY side for that key with its value and the document it came from, never just one; you may lead with the side marked `preferred`. superseded: it was true for the dates in its validity window, not now.'

export interface LookupFactsInput {
  entity?: string
  type?: string
  key?: string
  /** ISO day: the facts that were true then. */
  asOf?: string
}

/** Answerable in the reader's view: a fact superseded only out of it is answerable for them. */
function stateWhere(scope: AccessScope, asOf: Date | null): SQL | undefined {
  if (!asOf) return stateInViewSql(scope, ANSWERABLE_FACT_STATES)
  return and(
    inArray(knowledgeFacts.state, [...ANSWERABLE_FACT_STATES, 'superseded']),
    sql`(${knowledgeFacts.validFrom} is null or ${knowledgeFacts.validFrom} <= ${asOf})`,
    sql`(${knowledgeFacts.validTo} is null or ${knowledgeFacts.validTo} >= ${asOf})`
  )
}

function refWhere(refs: readonly EntityRef[]): SQL | undefined {
  return or(
    ...refs.map(r =>
      and(
        eq(knowledgeFacts.entityKind, r.kind),
        eq(knowledgeFacts.entityType, r.type),
        eq(knowledgeFacts.entityId, r.id)
      )
    )
  )
}

/** `{ names }` for a fact whose value names an entity, or nothing. */
function namedBy(
  valueRef: string | null,
  names: ReadonlyMap<string, string>
): Pick<FactHit, 'names'> {
  const v = parseValueRef(valueRef)
  if (!v) return {}
  return { names: { ...v, name: names.get(refKey(v)) ?? v.id } }
}

/** Group read facts by entity (in first-seen order) as `factHitSchema`s. */
async function toGroups(
  db: Database,
  scope: AccessScope,
  facts: readonly ReadFact[],
  known: ReadonlyMap<string, string> = new Map()
): Promise<FactHitGroup[]> {
  const refs = new Map<string, EntityRef>()
  for (const f of facts) {
    const ref: EntityRef = { kind: f.row.entityKind, type: f.row.entityType, id: f.row.entityId }
    refs.set(refKey(ref), ref)
  }
  // The entities `refs` keys name ("Marcus" → the person Marcus Bell), named the same way.
  const named = new Map<string, EntityRef>()
  for (const f of facts) {
    const v = parseValueRef(f.row.valueRef)
    if (v) named.set(refKey(v), v)
  }
  const unnamed = [...refs.values(), ...named.values()].filter(r => !known.has(refKey(r)))
  const names = new Map([...known, ...(await entityNames(db, scope.tenantId, unnamed))])
  const byId = new Map(facts.map(f => [f.row.id, f]))
  const groups = new Map<string, FactHitGroup>()
  for (const f of facts) {
    const ref: EntityRef = { kind: f.row.entityKind, type: f.row.entityType, id: f.row.entityId }
    const key = refKey(ref)
    const entity = { ...ref, name: names.get(key) ?? ref.id }
    const group = groups.get(key) ?? { entity, facts: [] }
    const state = viewState(f)
    const sides =
      state === 'conflicting'
        ? [f, ...f.visibleConflicts.map(id => byId.get(id)).filter((x): x is ReadFact => !!x)]
        : [f]
    const preferred =
      sides.length < 2 ||
      preferredFact(
        sides.map(s => ({ ...s, observedAt: s.row.observedAt, sourceKind: s.row.sourceKind }))
      )?.row.id === f.row.id
    const hit: FactHit = {
      factId: f.row.id,
      entity,
      key: f.row.key,
      value: f.row.value,
      valueText: f.row.valueText,
      ...namedBy(f.row.valueRef, names),
      state,
      preferred,
      conflictsWith: f.visibleConflicts,
      sourceKind: f.row.sourceKind,
      documentId: f.row.documentId,
      documentTitle: f.documentTitle,
      quote: f.row.quote,
      validFrom: f.row.validFrom,
      validTo: f.row.validTo,
      observedAt: f.row.observedAt,
    }
    group.facts.push(hit)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** Read the facts for these entities (and filters), capped, oldest first per entity and key. */
async function readFor(
  db: Database,
  scope: AccessScope,
  where: SQL | undefined,
  asOf: Date | null,
  max: number
): Promise<{ facts: ReadFact[]; omitted: number }> {
  const found = await selectFacts(db, scope, and(where, stateWhere(scope, asOf)), {
    orderBy: [
      asc(knowledgeFacts.entityType),
      asc(knowledgeFacts.entityId),
      asc(knowledgeFacts.key),
      asc(knowledgeFacts.observedAt),
    ],
    limit: max + 1,
  })
  if (found.length <= max) return { facts: found, omitted: 0 }
  return { facts: found.slice(0, max), omitted: found.length - max }
}

function namesOf(found: readonly FoundEntity[]): Map<string, string> {
  return new Map(found.map(e => [refKey(e), e.name]))
}

const unknownEntityHint = (name: string) =>
  `No entity called "${name}" is known. Try another spelling, a shorter name, or search_knowledge.`

/** `lookup_facts`. */
export async function lookupFacts(
  db: Database,
  scope: AccessScope,
  input: LookupFactsInput
): Promise<LookupFactsResult> {
  const asOf = input.asOf ? new Date(`${input.asOf}T00:00:00Z`) : null
  if (!input.entity && !input.type && !input.key) {
    return {
      entities: [],
      hint: 'Name an `entity` (a customer, a supplier…), a `type`, or a `key` to look up.',
    }
  }
  let found: FoundEntity[] = []
  if (input.entity) {
    found = await findEntitiesByName(db, scope, input.entity, {
      types: input.type ? [input.type] : undefined,
      registrations: knowledgeEntityTypes(),
      limit: LOOKUP_MAX_ENTITIES,
    })
    if (found.length === 0) return { entities: [], hint: unknownEntityHint(input.entity) }
  }
  const where = and(
    found.length > 0 ? refWhere(found) : undefined,
    input.type ? eq(knowledgeFacts.entityType, input.type) : undefined,
    input.key ? eq(knowledgeFacts.key, input.key) : undefined
  )
  const { facts, omitted } = await readFor(db, scope, where, asOf, LOOKUP_MAX_FACTS)
  const entities = await toGroups(db, scope, facts, namesOf(found))
  const result: LookupFactsResult = { entities }
  if (entities.length === 0) {
    result.hint = input.key
      ? `No fact with key "${input.key}" is held${asOf ? ` for ${input.asOf}` : ''}. Try without the key, or search_knowledge.`
      : 'No facts are held for that. Try search_knowledge for the documents themselves.'
  } else {
    result.note = FACTS_NOTE
  }
  if (omitted > 0) {
    result.omitted = omitted
    result.hint = `${omitted} more fact(s) matched — narrow with \`key\` or \`type\`.`
  }
  return result
}

/** `search_knowledge`'s `facts` block: the facts about the entities the query names. */
export async function factsForQuery(
  db: Database,
  scope: AccessScope,
  query: string
): Promise<FactHitGroup[]> {
  const found = await entitiesMentionedIn(db, scope, query, SEARCH_FACTS_MAX_ENTITIES)
  if (found.length === 0) return []
  const { facts } = await readFor(db, scope, refWhere(found), null, SEARCH_FACTS_MAX_FACTS)
  return toGroups(db, scope, facts, namesOf(found))
}

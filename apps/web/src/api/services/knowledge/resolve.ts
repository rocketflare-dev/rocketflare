/**
 * Checking a registration's table and columns, and the DEFAULT resolver a type with a table but
 * no `resolve` gets: trigram similarity (`pg_trgm`) of the mention against the label column and
 * every alias column, inside the reader's tenant, best first.
 *
 * **No identifier here comes from text.** The table and the columns are the drizzle objects the
 * registration handed over, checked to belong together (`registrationTableIssues`) before anything
 * runs; drizzle renders them as quoted identifiers. The mention is a bound parameter. The tenant
 * predicate is the table's own `tenantId` column against `scope.access.tenantId`, always.
 */
import type { EntityCandidate } from '@rocketflare/shared/ai/knowledge-facts'
import { and, desc, eq, getTableColumns, getTableName, type SQL, sql } from 'drizzle-orm'
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core'
import { knowledgeFacts } from '../../../db/schema'
import type { EntityResolver, EntityTypeRegistration } from './types'

/** `pg_trgm`'s own default `similarity_threshold`: below it, two names share too little. */
export const DEFAULT_RESOLVE_MIN_SCORE = 0.3

interface ResolvedColumns {
  table: PgTable
  tenant: AnyPgColumn
  id: AnyPgColumn
  label: AnyPgColumn
  aliases: readonly AnyPgColumn[]
}

function belongsTo(table: PgTable, column: AnyPgColumn): boolean {
  return Object.values(getTableColumns(table)).includes(column)
}

/**
 * What is wrong with a registration's table half — `[]` when it is usable. A type with no table
 * is fine (staging only) as long as it names no columns either.
 */
export function registrationTableIssues(reg: EntityTypeRegistration): string[] {
  const issues: string[] = []
  const columns = [
    ['idColumn', reg.idColumn],
    ['labelColumn', reg.labelColumn],
    ...(reg.aliasColumns ?? []).map((c, i) => [`aliasColumns[${i}]`, c] as const),
  ] as const
  if (!reg.table) {
    for (const [name, column] of columns) {
      if (column) issues.push(`${name} is set but the type has no table`)
    }
    return issues
  }
  const table = reg.table
  const tableName = getTableName(table)
  const all = getTableColumns(table)
  if (!all.tenantId) issues.push(`table ${tableName} has no tenantId column`)
  if (!reg.idColumn && !all.id) issues.push(`table ${tableName} has no id column; set idColumn`)
  if (!reg.resolve && !reg.labelColumn) {
    issues.push('labelColumn is required when the type has a table and no resolve')
  }
  for (const [name, column] of columns) {
    if (column && !belongsTo(table, column)) {
      issues.push(`${name} is not a column of ${tableName}`)
    }
  }
  return issues
}

function columnsOf(reg: EntityTypeRegistration): ResolvedColumns {
  const issues = registrationTableIssues(reg)
  if (!reg.table || !reg.labelColumn || issues.length > 0) {
    throw new Error(
      `entity type ${reg.type}: ${issues.join('; ') || 'no table to resolve against'}`
    )
  }
  const all = getTableColumns(reg.table)
  return {
    table: reg.table,
    tenant: all.tenantId as AnyPgColumn,
    id: reg.idColumn ?? (all.id as AnyPgColumn),
    label: reg.labelColumn,
    aliases: reg.aliasColumns ?? [],
  }
}

/** Similarity of one column to the mention; a `text[]` column scores its best element. */
function similarityOf(column: AnyPgColumn, name: string): SQL {
  if (column.dataType === 'array') {
    return sql`coalesce((select max(similarity(a, ${name})) from unnest(${column}) as a), 0)`
  }
  return sql`coalesce(similarity(${column}::text, ${name}), 0)`
}

/**
 * The resolver a registration with a table gets when it brings none. Builds its column set once
 * (throwing on a bad registration, which `knowledgeEntityTypes()` has already refused).
 */
export function defaultEntityResolver(
  reg: EntityTypeRegistration,
  minScore = DEFAULT_RESOLVE_MIN_SCORE
): EntityResolver {
  const cols = columnsOf(reg)
  return async (name, scope) => {
    const mention = name.trim()
    if (mention === '' || scope.limit <= 0) return []
    const scores = [cols.label, ...cols.aliases].map(c => similarityOf(c, mention))
    const score = scores.length === 1 ? scores[0] : sql`greatest(${sql.join(scores, sql`, `)})`
    const found = await scope.db
      .select({
        id: sql<string>`${cols.id}::text`,
        label: sql<string>`${cols.label}::text`,
        score: sql<number>`(${score})::float8`,
      })
      .from(cols.table)
      .where(and(eq(cols.tenant, scope.access.tenantId), sql`${score} >= ${minScore}`))
      .orderBy(desc(score))
      .limit(scope.limit)
    return found.map(
      (row): EntityCandidate => ({
        id: row.id,
        label: row.label,
        score: Math.min(1, Math.max(0, Number(row.score))),
      })
    )
  }
}

/**
 * At or above it a row's label (or alias) counts as MENTIONED in a free-text query — the same bar
 * the staging side uses (`MENTION_MIN_SCORE` in `entities.ts`).
 */
export const DEFAULT_MENTION_MIN_SCORE = 0.7

/** How far a word of the query must match: `word_similarity(label, query)` — the LABEL's share. */
function mentionOf(column: AnyPgColumn, query: string): SQL {
  if (column.dataType === 'array') {
    return sql`coalesce((select max(word_similarity(a, ${query})) from unnest(${column}) as a where length(a) >= 3), 0)`
  }
  return sql`coalesce(case when length(${column}::text) >= 3 then word_similarity(${column}::text, ${query}) end, 0)`
}

/**
 * The mention finder a type with a table gets when it brings none: rows whose label or an alias
 * appears in the query (the reverse question of the resolver — "does this query name a row?",
 * not "which row is this name?"), inside the tenant, and ONLY rows some fact is about: a row
 * nobody wrote a fact on has nothing for the facts block, and leaving it out keeps the scan to
 * the rows knowledge already touches.
 */
export function defaultMentionFinder(
  reg: EntityTypeRegistration,
  minScore = DEFAULT_MENTION_MIN_SCORE
): EntityResolver {
  const cols = columnsOf(reg)
  return async (query, scope) => {
    const text = query.trim()
    if (text === '' || scope.limit <= 0) return []
    const scores = [cols.label, ...cols.aliases].map(c => mentionOf(c, text))
    const score = scores.length === 1 ? scores[0] : sql`greatest(${sql.join(scores, sql`, `)})`
    const tenantId = scope.access.tenantId
    const found = await scope.db
      .select({
        id: sql<string>`${cols.id}::text`,
        label: sql<string>`${cols.label}::text`,
        score: sql<number>`(${score})::float8`,
      })
      .from(cols.table)
      .where(
        and(
          eq(cols.tenant, tenantId),
          sql`${score} >= ${minScore}`,
          sql`exists (select 1 from ${knowledgeFacts} kf where kf.tenant_id = ${tenantId} and kf.entity_kind = 'domain' and kf.entity_type = ${reg.type} and kf.entity_id = ${cols.id}::text and kf.state <> 'rejected')`
        )
      )
      .orderBy(desc(score))
      .limit(scope.limit)
    return found.map(
      (row): EntityCandidate => ({
        id: row.id,
        label: row.label,
        score: Math.min(1, Math.max(0, Number(row.score))),
      })
    )
  }
}

/**
 * The registration's own `mentions`, else the default over its label and alias columns, else
 * null (a staging-only type, or one with a custom `resolve` and no `labelColumn`).
 */
export function mentionFinderFor(reg: EntityTypeRegistration): EntityResolver | null {
  if (reg.mentions) return reg.mentions
  if (!reg.table || !reg.labelColumn) return null
  return defaultMentionFinder(reg)
}

/** Below it a typed query does not match a row in the Promote picker. */
export const ROW_SEARCH_MIN_SCORE = 0.3

/**
 * The Promote picker's search over a type's rows: what a PERSON typing finds, so a partial word
 * matches (`word_similarity(query, label)` — the share of the QUERY found in the label: "Bright"
 * finds "Brightside Bakery Ltd") as well as a whole name (`similarity`). Never used to link a
 * mention — that is the resolver's stricter question, where a part-name must not win.
 */
export function defaultRowSearch(
  reg: EntityTypeRegistration,
  minScore = ROW_SEARCH_MIN_SCORE
): EntityResolver {
  const cols = columnsOf(reg)
  const searchOf = (column: AnyPgColumn, q: string): SQL =>
    column.dataType === 'array'
      ? sql`coalesce((select max(greatest(similarity(a, ${q}), word_similarity(${q}, a))) from unnest(${column}) as a), 0)`
      : sql`coalesce(greatest(similarity(${column}::text, ${q}), word_similarity(${q}, ${column}::text)), 0)`
  return async (query, scope) => {
    const q = query.trim()
    if (q === '' || scope.limit <= 0) return []
    const scores = [cols.label, ...cols.aliases].map(c => searchOf(c, q))
    const score = scores.length === 1 ? scores[0] : sql`greatest(${sql.join(scores, sql`, `)})`
    const found = await scope.db
      .select({
        id: sql<string>`${cols.id}::text`,
        label: sql<string>`${cols.label}::text`,
        score: sql<number>`(${score})::float8`,
      })
      .from(cols.table)
      .where(and(eq(cols.tenant, scope.access.tenantId), sql`${score} >= ${minScore}`))
      .orderBy(desc(score), cols.label)
      .limit(scope.limit)
    return found.map(
      (row): EntityCandidate => ({
        id: row.id,
        label: row.label,
        score: Math.min(1, Math.max(0, Number(row.score))),
      })
    )
  }
}

/**
 * The picker's search for a type: the default over its label and aliases, else its own
 * `resolve` (a type with a custom resolver and no `labelColumn`), else null (no table).
 */
export function rowSearchFor(reg: EntityTypeRegistration): EntityResolver | null {
  if (reg.table && reg.labelColumn) return defaultRowSearch(reg)
  return resolverFor(reg)
}

/** The registration's own `resolve`, else the default over its table, else null (staging only). */
export function resolverFor(reg: EntityTypeRegistration): EntityResolver | null {
  if (reg.resolve) return reg.resolve
  if (!reg.table) return null
  return defaultEntityResolver(reg)
}

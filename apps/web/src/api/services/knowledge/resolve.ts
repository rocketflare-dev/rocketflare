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

/** The registration's own `resolve`, else the default over its table, else null (staging only). */
export function resolverFor(reg: EntityTypeRegistration): EntityResolver | null {
  if (reg.resolve) return reg.resolve
  if (!reg.table) return null
  return defaultEntityResolver(reg)
}

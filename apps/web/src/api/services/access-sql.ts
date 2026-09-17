/**
 * The pure SQL half of resource visibility (D29) — the part an installed PLUGIN may import.
 *
 * `services/access.ts` composes the registry, and to do that it reads the plugin barrel. So a
 * plugin's own visibility resource cannot import a value from it: the barrel imports the plugin,
 * the plugin imports the composer, and the cycle resolves with `serverPlugins` still `undefined`
 * at module evaluation — `VISIBILITY_RESOURCES` then throws on `undefined.flatMap` at import time,
 * which takes the whole Worker down rather than failing one request (D31, measured in Phase C).
 *
 * This file is therefore a LEAF: drizzle and nothing else. Everything here is re-exported from
 * `./access.ts`, so core code is unchanged and only a plugin has to know the distinction.
 */
import { type SQL, sql } from 'drizzle-orm'

export interface AccessScope {
  tenantId: string
  userId: string | null
  groupIds: string[]
  /** Admin-level readers see every row in the tenant. */
  bypass: boolean
}

/**
 * `exists (select 1 from <junction> j where j.<fk> = <resource>.id and j.group_id = any($ids))`.
 *
 * The subquery is written with a LITERAL alias and raw column names rather than drizzle column
 * objects. That is not stylistic: drizzle renders a column object with whatever table alias is in
 * scope where the fragment is spliced, so `${documentGroups.documentId}` inside a query over
 * `documents` comes out as `"documents"."document_id"` — a column that does not exist, and a 500
 * rather than a wrong answer. The alias here is local to the subquery and cannot be captured.
 *
 * The ids go in as one bound parameter each — never interpolated, and never as a single array
 * parameter, whose type Postgres cannot infer inside a subquery.
 */
export function sharedWithMyGroups(
  scope: AccessScope,
  junction: string,
  foreignKey: string,
  resourceId: SQL
): SQL {
  if (scope.groupIds.length === 0) return sql`false`
  const ids = sql.join(
    scope.groupIds.map(id => sql`${id}`),
    sql`, `
  )
  return sql`exists (select 1 from ${sql.raw(`"${junction}" j`)} where ${sql.raw(`j."${foreignKey}"`)} = ${resourceId} and ${sql.raw(`j."group_id"`)} in (${ids}))`
}

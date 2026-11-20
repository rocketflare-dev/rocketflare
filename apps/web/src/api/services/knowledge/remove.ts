/**
 * Removing knowledge facts and undoing what they did to the rest — for re-extraction
 * (`extract.ts`) and for deleting a document. Kept apart from the extraction pipeline so the
 * ingest path can delete a document without importing the model plumbing or the visibility
 * module (which reaches the plugin barrel at load).
 */
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type DocumentRow, documents, knowledgeFacts } from '../../../db/schema'
import { ACCEPT_CONFIDENCE } from './state'

/**
 * The state a fact returns to when what it disagreed with, or was replaced by, is gone: a person
 * confirmed it, or it was read confidently → `accepted`; else `unconfirmed`.
 */
export const restoredStateSql = sql`case when ${knowledgeFacts.confirmedAt} is not null or ${knowledgeFacts.confidence} >= ${ACCEPT_CONFIDENCE} then 'accepted' else 'unconfirmed' end`

const uuidArray = (ids: readonly string[]) =>
  sql`ARRAY[${sql.join(
    ids.map(id => sql`${id}`),
    sql`, `
  )}]::uuid[]`

/**
 * A fact a PERSON settled: confirmed (`confirmed_at` set — by `confirm` or as the chosen side of a
 * `prefer`) or `rejected` (only a review writes it: `reject`, or the losing side of a `prefer`).
 */
export const decidedSql = sql`(${knowledgeFacts.confirmedAt} is not null or ${knowledgeFacts.state} = 'rejected')`

/**
 * Delete facts and undo what they did to the rest: their ids leave every `conflicts_with`, a fact
 * left conflicting with nothing — or superseded by a fact that no longer exists (the FK set it
 * null) — returns to `accepted` (a person confirmed it, or it was read confidently) or
 * `unconfirmed`. A person's decisions on OTHER facts (`rejected`, a confirmation) are untouched.
 */
export async function removeFacts(
  db: Database,
  tenantId: string,
  where: SQL | undefined
): Promise<number> {
  return db.transaction(async tx => {
    const removed = await tx
      .delete(knowledgeFacts)
      .where(and(eq(knowledgeFacts.tenantId, tenantId), where))
      .returning({ id: knowledgeFacts.id })
    if (removed.length === 0) return 0
    const ids = uuidArray(removed.map(r => r.id))
    await tx
      .update(knowledgeFacts)
      .set({
        conflictsWith: sql`array(select x from unnest(${knowledgeFacts.conflictsWith}) as x where x <> all(${ids}))`,
      })
      .where(
        and(eq(knowledgeFacts.tenantId, tenantId), sql`${knowledgeFacts.conflictsWith} && ${ids}`)
      )
    await tx
      .update(knowledgeFacts)
      .set({ state: restoredStateSql })
      .where(
        and(
          eq(knowledgeFacts.tenantId, tenantId),
          sql`((${knowledgeFacts.state} = 'conflicting' and cardinality(${knowledgeFacts.conflictsWith}) = 0) or (${knowledgeFacts.state} = 'superseded' and ${knowledgeFacts.supersededById} is null))`
        )
      )
    return removed.length
  })
}

/**
 * Delete a document's facts (`removeFacts`). With `keepDecided`, the facts a person settled stay
 * for the run to match against what it reads again (`extractDocumentFacts` in `extract.ts`, step 2) — and because
 * they stay IN THE TABLE rather than in memory, a run that fails half-way and is retried still
 * finds them.
 */
export async function removeDocumentFacts(
  db: Database,
  tenantId: string,
  documentId: string,
  options: { keepDecided?: boolean } = {}
): Promise<number> {
  return removeFacts(
    db,
    tenantId,
    and(
      eq(knowledgeFacts.documentId, documentId),
      options.keepDecided ? sql`not ${decidedSql}` : undefined
    )
  )
}

/**
 * Delete the tenant's documents matching every one of `conditions`, in one transaction with the repair their facts
 * need: the facts go through `removeFacts` first, so a fact one of them superseded or conflicted
 * with is current again, instead of the cascade leaving it superseded by nothing or conflicting
 * with a fact that no longer exists. Returns the deleted rows (chunks cascade with them).
 */
export async function deleteDocumentsWithFacts(
  db: Database,
  tenantId: string,
  ...conditions: [SQL, ...SQL[]]
): Promise<DocumentRow[]> {
  return db.transaction(async tx => {
    const doomed = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), ...conditions))
      .for('update')
    if (doomed.length === 0) return []
    const ids = doomed.map(d => d.id)
    await removeFacts(tx, tenantId, inArray(knowledgeFacts.documentId, ids))
    return tx
      .delete(documents)
      .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, ids)))
      .returning()
  })
}

/**
 * The two nudges a knowledge write sends, after it commits:
 *
 * - `entity.changed { entity: 'knowledge', id? }` tenant-wide: the review list, entity pages and
 *   the Facts view. Only an OPEN page refetches on it, so it costs what people are looking at.
 * - `entity.changed { entity: 'knowledge-review-count' }` to the REVIEWERS whose items moved: the
 *   "for me" badge on the Knowledge nav item. Every member has the badge mounted, so a
 *   tenant-wide nudge for it would make every member refetch on every settle. The count is
 *   `reviewer_user_id = me`, so a person whose items did not change has nothing to refetch.
 *
 * Reviewers are read from the facts and entities the write touched (`reviewersOfFacts`,
 * `reviewersOfDocument`), never guessed. A missed reviewer refreshes on the next page load; the
 * UI's own mutations invalidate the count for the person acting.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { knowledgeFacts } from '../../../db/schema'
import { nudge, nudgeUsers, type Realtime, realtimeEvent } from '../realtime'

/** The UI's query-key root for the review badge (`queryKeys.knowledgeReviewCount`). */
export const REVIEW_COUNT_ENTITY = 'knowledge-review-count'

/** The reviewers of these facts (ids that no longer exist are skipped). */
export async function reviewersOfFacts(
  db: Database,
  tenantId: string,
  factIds: readonly string[]
): Promise<string[]> {
  if (factIds.length === 0) return []
  const rows = await db
    .selectDistinct({ id: knowledgeFacts.reviewerUserId })
    .from(knowledgeFacts)
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        inArray(knowledgeFacts.id, [...factIds]),
        isNotNull(knowledgeFacts.reviewerUserId)
      )
    )
  return rows.flatMap(r => (r.id ? [r.id] : []))
}

/** The reviewers of every fact on one entity (after a merge or promote re-decided its keys). */
export async function reviewersOfEntity(
  db: Database,
  tenantId: string,
  ref: { kind: string; type: string; id: string }
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: knowledgeFacts.reviewerUserId })
    .from(knowledgeFacts)
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        sql`${knowledgeFacts.entityKind} = ${ref.kind}`,
        eq(knowledgeFacts.entityType, ref.type),
        eq(knowledgeFacts.entityId, ref.id),
        isNotNull(knowledgeFacts.reviewerUserId)
      )
    )
  return rows.flatMap(r => (r.id ? [r.id] : []))
}

/**
 * The reviewers of one document's facts AND of every fact in conflict with one of them: the
 * people whose open items a (re-)extraction of the document can add or settle. Read before the
 * old facts go and again after the new ones land.
 */
export async function reviewersOfDocument(
  db: Database,
  tenantId: string,
  documentId: string
): Promise<string[]> {
  const ofDocument = sql`(select coalesce(array_agg(d.id), '{}'::uuid[]) from ${knowledgeFacts} d where d.tenant_id = ${tenantId} and d.document_id = ${documentId})`
  const rows = await db
    .selectDistinct({ id: knowledgeFacts.reviewerUserId })
    .from(knowledgeFacts)
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        isNotNull(knowledgeFacts.reviewerUserId),
        sql`(${knowledgeFacts.documentId} = ${documentId} or ${knowledgeFacts.conflictsWith} && ${ofDocument})`
      )
    )
  return rows.flatMap(r => (r.id ? [r.id] : []))
}

/** Both nudges. `reviewers` may repeat or hold nulls; an empty set sends only the page nudge. */
export function nudgeKnowledgeChange(
  realtime: Realtime | undefined,
  tenantId: string,
  reviewers: Iterable<string | null | undefined>,
  id?: string
): void {
  nudge(
    realtime,
    realtimeEvent('entity.changed', tenantId, { entity: 'knowledge', ...(id ? { id } : {}) })
  )
  const userIds = [...new Set([...reviewers].filter((r): r is string => !!r))]
  if (userIds.length === 0) return
  nudgeUsers(
    realtime,
    userIds,
    realtimeEvent('entity.changed', tenantId, { entity: REVIEW_COUNT_ENTITY })
  )
}

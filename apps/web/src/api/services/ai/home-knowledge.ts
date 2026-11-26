/**
 * The knowledge part of `GET /api/home/summary`: the newest documents the reader may open, how
 * many there are, how many are still being indexed, and — with the tenant's `knowledge-facts`
 * flag — the facts extracted from each. Every read is the tenant predicate AND
 * `visibleDocuments(scope)`, exactly as the documents list, so Home never shows a document (or a
 * count that includes one) its reader could not open.
 */
import type { HomeKnowledge } from '@rocketflare/shared/home'
import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { documents, knowledgeFacts } from '../../../db/schema'
import type { AuthContext } from '../../types'
import { accessScopeOf, visibleDocuments } from '../access'

/** How many documents the list shows. */
export const HOME_RECENT_DOCUMENTS = 5

export async function homeKnowledge(
  db: Database,
  auth: AuthContext & { tenantId: string }
): Promise<HomeKnowledge | null> {
  if (!auth.ability.can('read', 'Document')) return null
  const scope = accessScopeOf(auth)
  const where = and(eq(documents.tenantId, auth.tenantId), visibleDocuments(scope))
  const [recent, [totals]] = await Promise.all([
    db
      .select({
        id: documents.id,
        title: documents.title,
        status: documents.status,
        error: documents.error,
        chunkCount: documents.chunkCount,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(where)
      .orderBy(desc(documents.createdAt))
      .limit(HOME_RECENT_DOCUMENTS),
    db
      .select({
        total: count(),
        pending: sql<number>`count(*) filter (where ${documents.status} = 'pending')::int`,
      })
      .from(documents)
      .where(where),
  ])

  // Facts are read through their document, and every document here is one the reader may open.
  const factsOn = auth.features.includes('knowledge-facts')
  const facts =
    factsOn && recent.length > 0
      ? await db
          .select({ documentId: knowledgeFacts.documentId, n: count() })
          .from(knowledgeFacts)
          .where(
            and(
              eq(knowledgeFacts.tenantId, auth.tenantId),
              inArray(
                knowledgeFacts.documentId,
                recent.map(d => d.id)
              ),
              ne(knowledgeFacts.state, 'rejected')
            )
          )
          .groupBy(knowledgeFacts.documentId)
      : []
  const factsBy = new Map(facts.map(f => [f.documentId, Number(f.n)]))

  return {
    recent: recent.map(d => ({ ...d, factCount: factsOn ? (factsBy.get(d.id) ?? 0) : null })),
    total: Number(totals?.total ?? 0),
    pending: Number(totals?.pending ?? 0),
  }
}

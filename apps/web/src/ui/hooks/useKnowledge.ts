/**
 * Knowledge facts (D43): the review list (`GET /api/knowledge/review`), the count of MY open
 * items for the Knowledge nav badge, an entity page (`GET /entities/:type/:id`), and the actions
 * that settle an item — `POST /facts/:id/review { confirm | reject | prefer }`, and
 * `POST /entities/:id/merge | promote | keep-separate`.
 *
 * Everything sits under the one `['knowledge']` root, which the server nudges after every action
 * and every extraction run — so nothing here polls, and a settled item simply updates in place
 * when the family is invalidated. **No success toasts**: the item changing is the answer. A 409
 * (somebody settled it first, or it is now in conflict) is not an error to shout about: the hook
 * refetches and the caller shows `alert-info`; anything else toasts.
 *
 * Every query takes `enabled` — the caller passes the flag-AND-permission check — so a tenant
 * without `knowledge-facts` never fires a request that would 404.
 */
import {
  type EntityActionResponse,
  type EntityTarget,
  entityActionResponseSchema,
  entityCardSchema,
  type FactReviewAction,
  type FactReviewResponse,
  factReviewResponseSchema,
  type KNOWLEDGE_REVIEW_KINDS,
  knowledgeReviewListSchema,
  mentionedFactsResponseSchema,
} from '@rocketflare/shared/ai/knowledge-facts'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, showToast } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export interface ReviewFilters {
  page?: number
  pageSize?: number
  kind?: (typeof KNOWLEDGE_REVIEW_KINDS)[number] | ''
  entityType?: string
  entityId?: string
  /** An admin narrowing the list to their own items (a member only ever sees theirs). */
  mine?: boolean
}

export function useReviewItems(filters: ReviewFilters, enabled = true) {
  const clean = cleanFilters(filters)
  return useQuery({
    queryKey: queryKeys.knowledge.review(clean),
    queryFn: () =>
      api.get(`/api/knowledge/review${toSearchParams(clean)}`, {
        schema: knowledgeReviewListSchema,
      }),
    enabled,
    placeholderData: keepPreviousData,
  })
}

/** My open items, for the nav badge: one row fetched, the total read. Fed by the nudge. */
export function useMyReviewCount(enabled = true) {
  return useQuery({
    queryKey: queryKeys.knowledge.reviewCount,
    queryFn: () =>
      api.get('/api/knowledge/review?mine=true&pageSize=1', { schema: knowledgeReviewListSchema }),
    enabled,
    select: data => data.pagination.total,
  })
}

export function useEntityCard(type: string | undefined, id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.knowledge.entity(type ?? '', id ?? ''),
    queryFn: () =>
      api.get(
        `/api/knowledge/entities/${encodeURIComponent(type ?? '')}/${encodeURIComponent(id ?? '')}`,
        { schema: entityCardSchema }
      ),
    enabled: enabled && Boolean(type && id),
  })
}

/** A 409 means the item moved under us: refetch and let the caller say so, quietly. */
export const isStaleItem = (error: unknown) => error instanceof ApiError && error.status === 409

function useKnowledgeMutation<V, R>(mutationFn: (vars: V) => Promise<R>) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.all })
  return useMutation({
    mutationFn,
    onSuccess: refresh,
    onError: error => {
      if (isStaleItem(error)) {
        void refresh()
        return
      }
      showToast(error instanceof ApiError ? error.message : 'That could not be saved', 'error')
    },
  })
}

export function useReviewFact() {
  return useKnowledgeMutation<{ factId: string; action: FactReviewAction }, FactReviewResponse>(
    ({ factId, action }) =>
      api.post(
        `/api/knowledge/facts/${encodeURIComponent(factId)}/review`,
        { action },
        { schema: factReviewResponseSchema, showErrorToast: false }
      )
  )
}

export function useMergeEntity() {
  return useKnowledgeMutation<{ entityId: string; into: EntityTarget }, EntityActionResponse>(
    ({ entityId, into }) =>
      api.post(
        `/api/knowledge/entities/${encodeURIComponent(entityId)}/merge`,
        { into },
        { schema: entityActionResponseSchema, showErrorToast: false }
      )
  )
}

export function usePromoteEntity() {
  return useKnowledgeMutation<{ entityId: string; id: string }, EntityActionResponse>(
    ({ entityId, id }) =>
      api.post(
        `/api/knowledge/entities/${encodeURIComponent(entityId)}/promote`,
        { id },
        { schema: entityActionResponseSchema, showErrorToast: false }
      )
  )
}

export function useKeepEntitySeparate() {
  return useKnowledgeMutation<{ entityId: string }, EntityActionResponse>(({ entityId }) =>
    api.post(`/api/knowledge/entities/${encodeURIComponent(entityId)}/keep-separate`, undefined, {
      schema: entityActionResponseSchema,
      showErrorToast: false,
    })
  )
}

/**
 * The Search page's facts block: the facts about the entities a query names
 * (`GET /api/knowledge/mentioned?q=`). Keyed on the query, so a repeated search is a cache hit.
 */
export function useMentionedFacts(q: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.knowledge.mentioned(q),
    queryFn: () =>
      api.get(`/api/knowledge/mentioned${toSearchParams({ q })}`, {
        schema: mentionedFactsResponseSchema,
      }),
    enabled: enabled && q.trim().length > 0,
  })
}

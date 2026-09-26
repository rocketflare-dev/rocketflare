/**
 * Thumbs on AI answers (D33): `useMyFeedback(target, ids)` reads the caller's own votes on a set of
 * answers (`GET /api/feedback/mine`) so the thumbs draw their state; `useRateAnswer()` sets a vote
 * (`POST /api/feedback`) or withdraws it (`DELETE /api/feedback/:target/:targetId`) when the same
 * thumb is pressed twice. Every member may rate an answer they can read; reading everyone's votes
 * is admin-only and lives in the CLI (`rocketflare feedback list`), not here.
 */
import {
  type FeedbackRating,
  type FeedbackTarget,
  feedbackMineResponseSchema,
  feedbackSchema,
} from '@rocketflare/shared/ai/evals'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export function useMyFeedback(target: FeedbackTarget, targetIds: readonly string[]) {
  return useQuery({
    queryKey: queryKeys.ai.feedback.mine(target, targetIds),
    queryFn: async () => {
      const params = new URLSearchParams({ target, targetIds: targetIds.join(',') })
      const res = await api.get(`/api/feedback/mine?${params}`, {
        schema: feedbackMineResponseSchema,
      })
      return new Map(res.items.map(f => [f.targetId, f.rating]))
    },
    enabled: targetIds.length > 0,
    staleTime: 60_000,
  })
}

export interface RateAnswerInput {
  target: FeedbackTarget
  targetId: string
  /** `null` withdraws the vote. */
  rating: FeedbackRating | null
}

export function useRateAnswer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ target, targetId, rating }: RateAnswerInput) =>
      rating === null
        ? api.delete(`/api/feedback/${target}/${targetId}`)
        : api.post('/api/feedback', { target, targetId, rating }, { schema: feedbackSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.ai.feedback.all }),
  })
}

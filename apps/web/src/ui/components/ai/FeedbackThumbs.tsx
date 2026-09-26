/**
 * Thumbs up/down on an AI answer (D33) — an assistant message in chat, or a finished agent run's
 * output. Pressing a thumb votes; pressing the same thumb again withdraws the vote. The vote is
 * stored in `ai_feedback` and recorded in the answer's trace, and a thumbs-down is where
 * `rocketflare feedback list --rating down` → `rocketflare evals promote` starts.
 *
 * The state comes from the parent (one `useMyFeedback` query per page of answers, not one per
 * bubble); this component only renders it and fires the mutation.
 */
import { HandThumbDownIcon, HandThumbUpIcon } from '@heroicons/react/24/outline'
import {
  HandThumbDownIcon as HandThumbDownSolid,
  HandThumbUpIcon as HandThumbUpSolid,
} from '@heroicons/react/24/solid'
import type { FeedbackRating, FeedbackTarget } from '@rocketflare/shared/ai/evals'
import { useRateAnswer } from '@/ui/hooks/useFeedback'

export interface FeedbackThumbsProps {
  target: FeedbackTarget
  targetId: string
  /** The caller's current vote, or undefined when they have not rated this answer. */
  rating?: FeedbackRating
}

export function FeedbackThumbs({ target, targetId, rating }: FeedbackThumbsProps) {
  const rate = useRateAnswer()
  const vote = (next: FeedbackRating) =>
    rate.mutate({ target, targetId, rating: rating === next ? null : next })
  const Up = rating === 1 ? HandThumbUpSolid : HandThumbUpIcon
  const Down = rating === -1 ? HandThumbDownSolid : HandThumbDownIcon
  return (
    <span className="inline-flex items-center gap-0.5" data-testid="feedback-thumbs">
      <button
        type="button"
        className={`btn btn-ghost btn-xs btn-square ${rating === 1 ? 'text-success' : ''}`}
        aria-label="Good answer"
        aria-pressed={rating === 1}
        disabled={rate.isPending}
        onClick={() => vote(1)}
      >
        <Up className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={`btn btn-ghost btn-xs btn-square ${rating === -1 ? 'text-error' : ''}`}
        aria-label="Bad answer"
        aria-pressed={rating === -1}
        disabled={rate.isPending}
        onClick={() => vote(-1)}
      >
        <Down className="h-3.5 w-3.5" />
      </button>
    </span>
  )
}

/**
 * The pieces every knowledge-facts surface (D43) shows a fact with — the entity page, the review
 * list on the Knowledge page, and (the badge alone) the chat's entity cards:
 *
 * - `FactStateBadge` — the state, in `.status-badge` tones;
 * - `FactItem` — value, state, validity, the source document (a link to the passage) and the
 *   verbatim quote, then `FactDoubt` when the fact is open;
 * - `FactDoubt` — the inline "Is this still right?": Confirm, Not right (reject) and, on a
 *   conflicting fact, Use this one (prefer). Only for the item's reviewer or a manager; anyone
 *   else gets one sentence, never a disabled control. No success toast — the item updates in
 *   place when the `['knowledge']` family refetches; a 409 is `alert-info`.
 *
 * Markdown-free (a quote is document text: rendered verbatim), and NOT in the eager
 * `components/shared` barrel — every importer is a lazy page.
 */
import { CheckIcon, HandThumbUpIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { documentPath } from '@rocketflare/shared/ai/embeddings'
import {
  type Fact,
  type FactReviewAction,
  type FactState,
  OPEN_REVIEW_FACT_STATES,
} from '@rocketflare/shared/ai/knowledge-facts'
import { Link } from 'react-router'
import { useAuth } from '@/ui/hooks/useAuth'
import { isStaleItem, useReviewFact } from '@/ui/hooks/useKnowledge'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { formatDate } from '@/ui/lib/format'

const STATE_LABELS: Record<FactState, string> = {
  accepted: 'Accepted',
  unconfirmed: 'Unconfirmed',
  conflicting: 'Conflicting',
  superseded: 'Superseded',
  rejected: 'Rejected',
}

/** `.status-badge` tones from index.css: open states are "waiting for a person", history is grey. */
const STATE_TONE: Record<FactState, string> = {
  accepted: 'accepted',
  unconfirmed: 'awaiting-review',
  conflicting: 'awaiting-review',
  superseded: 'archived',
  rejected: 'rejected',
}

export function FactStateBadge({ state }: { state: FactState }) {
  return (
    <span className="status-badge" data-status={STATE_TONE[state]}>
      {STATE_LABELS[state]}
    </span>
  )
}

/** `monthly_fee_gbp` → "Monthly fee gbp". */
export function factKeyLabel(key: string): string {
  const words = key.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const isOpenFact = (state: FactState) =>
  (OPEN_REVIEW_FACT_STATES as readonly FactState[]).includes(state)

/** "from 1 Jan 2026", "until …", "1 Jan 2026 – 31 Dec 2026", or null when the source gave none. */
export function validityLabel(fact: Pick<Fact, 'validFrom' | 'validTo'>): string | null {
  const { validFrom, validTo } = fact
  if (validFrom && validTo) return `${formatDate(validFrom)} – ${formatDate(validTo)}`
  if (validFrom) return `from ${formatDate(validFrom)}`
  if (validTo) return `until ${formatDate(validTo)}`
  return null
}

/** May the signed-in person settle an item addressed to `reviewerUserId`? The route's own rule. */
export function useCanSettle() {
  const { user } = useAuth()
  const { can } = usePermissions()
  const manager = can('manage', 'KnowledgeFact')
  const updater = can('update', 'KnowledgeFact')
  return (reviewerUserId: string | null) =>
    updater && (manager || (reviewerUserId !== null && reviewerUserId === user?.id))
}

export function FactDoubt({ fact }: { fact: Fact }) {
  const canSettle = useCanSettle()
  const review = useReviewFact()
  if (!isOpenFact(fact.state)) return null
  if (!canSettle(fact.reviewerUserId)) {
    return (
      <p className="text-xs text-muted mt-2">
        Waiting for the person who added its document to check it.
      </p>
    )
  }
  const busy = review.isPending && review.variables?.factId === fact.id
  const act = (action: FactReviewAction) => review.mutate({ factId: fact.id, action })
  const conflicting = fact.state === 'conflicting'
  return (
    <div className="mt-2" data-testid={`fact-doubt-${fact.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-secondary">Is this still right?</span>
        {conflicting ? (
          <button
            type="button"
            className="btn btn-xs btn-outline"
            disabled={busy}
            onClick={() => act('prefer')}
          >
            <HandThumbUpIcon className="w-3.5 h-3.5" />
            Use this one
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-xs btn-outline"
            disabled={busy}
            onClick={() => act('confirm')}
          >
            <CheckIcon className="w-3.5 h-3.5" />
            Confirm
          </button>
        )}
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          disabled={busy}
          onClick={() => act('reject')}
        >
          <XMarkIcon className="w-3.5 h-3.5" />
          Not right
        </button>
      </div>
      {review.isError && isStaleItem(review.error) && review.variables?.factId === fact.id && (
        <p role="status" className="alert alert-info text-xs mt-2 py-1.5">
          {review.error.message} — showing it as it stands now.
        </p>
      )}
    </div>
  )
}

/** One fact with its source. `showKey` for a list that is not already grouped by key. */
export function FactItem({ fact, showKey = false }: { fact: Fact; showKey?: boolean }) {
  const validity = validityLabel(fact)
  const { source } = fact
  return (
    <div className="py-3" data-fact={fact.id}>
      <div className="flex flex-wrap items-center gap-2">
        {showKey && <span className="text-sm text-secondary">{factKeyLabel(fact.key)}:</span>}
        <span className="font-medium break-words">{fact.valueText}</span>
        <FactStateBadge state={fact.state} />
        {validity && <span className="text-xs text-muted">{validity}</span>}
        {fact.confirmedAt && (
          <span className="text-xs text-muted">confirmed {formatDate(fact.confirmedAt)}</span>
        )}
      </div>
      <div className="text-xs text-muted mt-1">
        From{' '}
        <Link
          to={documentPath(source.documentId, { offset: source.charStart, chunk: source.chunkId })}
          className="link link-primary"
        >
          {source.documentTitle}
        </Link>{' '}
        · {formatDate(fact.observedAt)}
      </div>
      {source.quote && (
        <blockquote className="mt-1.5 border-l-2 border-[color:var(--border-subtle)] pl-3 text-sm text-secondary whitespace-pre-wrap break-words">
          {source.quote}
        </blockquote>
      )}
      <FactDoubt fact={fact} />
    </div>
  )
}

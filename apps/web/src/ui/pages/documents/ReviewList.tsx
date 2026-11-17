/**
 * The Knowledge page's "To review" view (`/documents?view=review`, D43): the open review items —
 * facts that are unconfirmed or whose sources disagree, and entities that might be one we already
 * know — addressed to me, or to everyone for a manager ("Only mine" narrows it). Not a queue
 * product: a filtered list, each item settled in place and linking to its entity page. Shown only
 * behind `KNOWLEDGE_FACTS_GUARD`; refreshed by the `['knowledge']` nudge, never polled.
 */
import { CheckBadgeIcon } from '@heroicons/react/24/outline'
import type { KnowledgeReviewItem } from '@rocketflare/shared/ai/knowledge-facts'
import { useState } from 'react'
import { ReviewItem } from '@/ui/components/knowledge/ReviewItem'
import { EmptyState, PaginationControls, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { type ReviewFilters, useReviewItems } from '@/ui/hooks/useKnowledge'
import { usePermissions } from '@/ui/hooks/usePermissions'

export function ReviewList() {
  const { can } = usePermissions()
  const manager = can('manage', 'KnowledgeFact')
  const [page, setPage] = useState(1)
  const [kind, setKind] = useState<ReviewFilters['kind']>('')
  const [mine, setMine] = useState(false)
  const list = useReviewItems({ page, kind, mine: manager && mine ? true : undefined })
  const items = withoutRepeatedConflicts(list.data?.items ?? [])

  return (
    <SectionPanel
      flush
      title="To review"
      description={
        manager
          ? 'Facts read from documents that need a person: everyone’s, or only yours.'
          : 'Facts read from your documents that need you: confirm them, or say they are not right.'
      }
      actions={
        <>
          {manager && (
            <label className="label text-xs gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={mine}
                onChange={e => {
                  setMine(e.target.checked)
                  setPage(1)
                }}
              />
              Only mine
            </label>
          )}
          <label htmlFor="review-kind" className="sr-only">
            Kind
          </label>
          <select
            id="review-kind"
            className="select select-xs"
            value={kind}
            onChange={e => {
              setKind(e.target.value as ReviewFilters['kind'])
              setPage(1)
            }}
          >
            <option value="">Everything</option>
            <option value="fact">Facts</option>
            <option value="possibleMatch">Possible matches</option>
          </select>
        </>
      }
    >
      {list.isLoading ? (
        <div className="p-4">
          <SkeletonRows rows={3} />
        </div>
      ) : list.isError ? (
        <p className="p-4 text-sm text-error" role="alert">
          The review list could not be loaded.
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={CheckBadgeIcon}
          size="sm"
          message="Nothing to review"
          description="When a document is read and a fact looks doubtful, or two documents disagree, it shows up here."
        />
      ) : (
        <>
          <ul className="divide-y divide-[color:var(--border-subtle)]" aria-label="Review items">
            {items.map(item => (
              <ReviewItem key={item.kind === 'fact' ? item.fact.id : item.entity.id} item={item} />
            ))}
          </ul>
          {list.data && (
            <div className="px-5 pb-4">
              <PaginationControls
                pagination={list.data.pagination}
                onPageChange={setPage}
                isLoading={list.isFetching}
              />
            </div>
          )}
        </>
      )}
    </SectionPanel>
  )
}

/**
 * Each side of a conflict is its own open item (the API counts facts), but the first side's item
 * already shows every other side with its own actions — so a later item whose fact is one of
 * those is dropped from the page rather than showing the same disagreement twice.
 */
export function withoutRepeatedConflicts(items: readonly KnowledgeReviewItem[]) {
  const shown = new Set<string>()
  const out: KnowledgeReviewItem[] = []
  for (const item of items) {
    if (item.kind === 'fact') {
      if (shown.has(item.fact.id)) continue
      shown.add(item.fact.id)
      for (const other of item.conflicts) shown.add(other.id)
    }
    out.push(item)
  }
  return out
}

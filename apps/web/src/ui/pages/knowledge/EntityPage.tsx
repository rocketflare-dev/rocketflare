/**
 * `/knowledge/entities/:type/:id` (D43) — one entity and every fact about it the reader may see
 * (`GET /api/knowledge/entities/:type/:id`): grouped by key, the current facts first — value,
 * state, validity, source document (a link to the passage) and quote, with the inline doubt on an
 * open one — then superseded and rejected facts as that key's history. Both sides of a conflict
 * sit together under their key, each with its source and "Use this one".
 *
 * A staging entity also shows its possible match (Merge / Keep separate, from
 * `GET /review?kind=possibleMatch&entityId=`) and, where its type can be promoted, a Promote picker;
 * a merged or promoted one says where it went. Guard: `KNOWLEDGE_FACTS_GUARD` (the flag AND
 * `read KnowledgeFact`); everything here refreshes on the `['knowledge']` nudge.
 */
import { CubeIcon } from '@heroicons/react/24/outline'
import {
  type EntityCard,
  entityPath,
  type Fact,
  type FactState,
} from '@rocketflare/shared/ai/knowledge-facts'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { FactItem, factKeyLabel, useCanSettle } from '@/ui/components/knowledge/FactParts'
import { PossibleMatch } from '@/ui/components/knowledge/PossibleMatch'
import { EmptyState, PageHeader, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useDebounce } from '@/ui/hooks/useDebounce'
import {
  isStaleItem,
  useEntityCard,
  usePromoteCandidates,
  usePromoteEntity,
  useReviewItems,
} from '@/ui/hooks/useKnowledge'
import { ApiError } from '@/ui/lib/api-client'

/** Current first: the order a key's facts are listed in. History follows, newest first. */
const CURRENT: readonly FactState[] = ['conflicting', 'unconfirmed', 'accepted']
const HISTORY: readonly FactState[] = ['superseded', 'rejected']

export interface KeyGroup {
  key: string
  current: Fact[]
  history: Fact[]
}

/** Facts grouped by key (keys in first-seen order), each group split into current and history. Pure. */
export function groupFactsByKey(facts: readonly Fact[]): KeyGroup[] {
  const groups = new Map<string, KeyGroup>()
  for (const fact of facts) {
    const group = groups.get(fact.key) ?? { key: fact.key, current: [], history: [] }
    if (HISTORY.includes(fact.state)) group.history.push(fact)
    else group.current.push(fact)
    groups.set(fact.key, group)
  }
  const newest = (a: Fact, b: Fact) => b.observedAt.getTime() - a.observedAt.getTime()
  for (const g of groups.values()) {
    g.current.sort((a, b) => CURRENT.indexOf(a.state) - CURRENT.indexOf(b.state) || newest(a, b))
    g.history.sort(newest)
  }
  return [...groups.values()]
}

export default function EntityPage() {
  const { type = '', id = '' } = useParams()
  const card = useEntityCard(type, id)
  const breadcrumbs = [
    { label: 'Knowledge', to: '/documents' },
    { label: 'To review', to: '/documents?view=review' },
  ]

  if (card.isLoading) {
    return (
      <div className="max-w-6xl">
        <PageHeader title="Entity" breadcrumbs={breadcrumbs} />
        <SectionPanel>
          <SkeletonRows rows={4} />
        </SectionPanel>
      </div>
    )
  }
  if (card.isError || !card.data) {
    const missing = card.error instanceof ApiError && card.error.status === 404
    return (
      <div className="max-w-6xl">
        <PageHeader title="Entity" breadcrumbs={breadcrumbs} />
        <SectionPanel>
          <EmptyState
            icon={CubeIcon}
            message={missing ? 'Nothing found here' : 'This entity could not be loaded'}
            description={
              missing
                ? 'It may have been merged away, or every document that mentions it is one you cannot open.'
                : undefined
            }
          />
        </SectionPanel>
      </div>
    )
  }
  return <EntityView card={card.data} breadcrumbs={breadcrumbs} />
}

function EntityView({
  card,
  breadcrumbs,
}: {
  card: EntityCard
  breadcrumbs: { label: string; to?: string }[]
}) {
  const { entity, facts } = card
  const staging = entity.kind === 'staging'
  const open = !entity.mergedInto && !entity.promotedTo
  const matches = useReviewItems(
    { kind: 'possibleMatch', entityId: entity.id, pageSize: 5 },
    staging && open
  )
  const match = matches.data?.items.find(i => i.kind === 'possibleMatch')
  const groups = groupFactsByKey(facts)

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={entity.name}
        breadcrumbs={[...breadcrumbs, { label: entity.name }]}
        badge={<span className="badge badge-ghost badge-sm">{entity.typeLabel}</span>}
        description={
          entity.aliases.length > 0 ? `Also called ${entity.aliases.join(', ')}` : undefined
        }
      />

      {entity.mergedInto && (
        <div role="status" className="alert alert-info text-sm mb-6">
          <span>
            Merged into{' '}
            <Link to={entityPath(entity.type, entity.mergedInto)} className="link">
              another entity
            </Link>
            ; its facts are there now.
          </span>
        </div>
      )}
      {entity.promotedTo && (
        <div role="status" className="alert alert-info text-sm mb-6">
          <span>
            Linked to{' '}
            <Link to={entityPath(entity.promotedTo.type, entity.promotedTo.id)} className="link">
              a {entity.typeLabel.toLowerCase()} record
            </Link>
            ; its facts are there now.
          </span>
        </div>
      )}

      {match?.kind === 'possibleMatch' && (
        <SectionPanel
          className="mb-6"
          title="Possible match"
          description="Facts are kept apart until somebody says whether these are the same."
        >
          <PossibleMatch
            entity={match.entity}
            candidates={match.candidates}
            reviewerUserId={match.reviewerUserId}
          />
        </SectionPanel>
      )}

      <SectionPanel
        flush
        className="mb-6"
        title="Facts"
        description="What documents say about it, each with the passage it was read from."
      >
        {groups.length === 0 ? (
          <EmptyState
            icon={CubeIcon}
            size="sm"
            message="No facts you can see"
            description="Facts are read from documents; the ones about this entity are in documents you cannot open, or were moved."
          />
        ) : (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {groups.map(group => (
              <li key={group.key} className="px-5 py-3" data-fact-key={group.key}>
                <h3 className="text-sm font-semibold">{factKeyLabel(group.key)}</h3>
                {group.current.length > 1 && group.current.some(f => f.state === 'conflicting') && (
                  <p className="text-xs text-muted mt-0.5">
                    Sources disagree — both are shown with where they came from.
                  </p>
                )}
                <div className="divide-y divide-[color:var(--border-subtle)]">
                  {group.current.map(fact => (
                    <FactItem key={fact.id} fact={fact} />
                  ))}
                </div>
                {group.history.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-xs text-muted cursor-pointer select-none">
                      History ({group.history.length})
                    </summary>
                    <div className="divide-y divide-[color:var(--border-subtle)] opacity-80">
                      {group.history.map(fact => (
                        <FactItem key={fact.id} fact={fact} />
                      ))}
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionPanel>

      {staging && open && entity.promotable && (
        <PromotePanel
          entityId={entity.id}
          typeLabel={entity.typeLabel}
          reviewerUserId={entity.reviewerUserId}
        />
      )}
    </div>
  )
}

/**
 * "This is that record of ours": a search over the type's rows (`usePromoteCandidates`, the
 * entity's own name until something is typed), each match with its own Link button. Reviewer or
 * manager only.
 */
function PromotePanel({
  entityId,
  typeLabel,
  reviewerUserId,
}: {
  entityId: string
  typeLabel: string
  reviewerUserId: string | null
}) {
  const canSettle = useCanSettle()
  const allowed = canSettle(reviewerUserId)
  const promote = usePromoteEntity()
  const [search, setSearch] = useState('')
  const q = useDebounce(search, 250)
  const candidates = usePromoteCandidates(entityId, q, allowed)
  // A control only where the save would succeed; nobody else is shown a form they cannot use.
  if (!allowed) return null
  const rows = candidates.data?.candidates ?? []
  return (
    <SectionPanel
      className="mb-6"
      title={`Link to an existing record (${typeLabel})`}
      description="If this is one you already keep, pick it: the facts move onto that record. Nothing in the record itself is changed."
    >
      <div className="mb-3">
        <label htmlFor="promote-search" className="label text-sm font-medium">
          Find a {typeLabel.toLowerCase()}
        </label>
        <input
          id="promote-search"
          type="search"
          className="input input-sm w-72"
          value={search}
          maxLength={200}
          placeholder={candidates.data?.query}
          onChange={e => setSearch(e.target.value)}
          disabled={promote.isPending}
        />
      </div>
      {candidates.isPending ? (
        <SkeletonRows rows={2} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">
          No {typeLabel.toLowerCase()} matches “{candidates.data?.query ?? q}”.
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--border-subtle)]">
          {rows.map(row => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-2">
              <span className="text-sm">{row.label}</span>
              <button
                type="button"
                className="btn btn-sm btn-outline"
                aria-label={`Link to ${row.label}`}
                disabled={promote.isPending}
                onClick={() => promote.mutate({ entityId, id: row.id })}
              >
                Link
              </button>
            </li>
          ))}
        </ul>
      )}
      {promote.isError && isStaleItem(promote.error) && (
        <p role="status" className="alert alert-info text-xs mt-2 py-1.5">
          {promote.error.message} — showing it as it stands now.
        </p>
      )}
    </SectionPanel>
  )
}

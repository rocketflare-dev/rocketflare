/**
 * A staging entity that might be a row we already know (D43): its candidates, each with Merge
 * ("these are the same" — a domain candidate makes it a promote), and one Keep separate ("not the
 * same"). Shown on the entity page and in the review list. Same rules as `FactDoubt`: only the
 * item's reviewer or a manager acts; no success toast; a 409 is `alert-info`.
 */
import { ArrowsPointingInIcon } from '@heroicons/react/24/outline'
import {
  entityPath,
  type KnowledgeEntity,
  type PossibleMatchCandidate,
} from '@rocketflare/shared/ai/knowledge-facts'
import { Link } from 'react-router'
import { isStaleItem, useKeepEntitySeparate, useMergeEntity } from '@/ui/hooks/useKnowledge'
import { useCanSettle } from './FactParts'

export interface PossibleMatchProps {
  entity: KnowledgeEntity
  candidates: readonly PossibleMatchCandidate[]
  reviewerUserId: string | null
}

export function PossibleMatch({ entity, candidates, reviewerUserId }: PossibleMatchProps) {
  const canSettle = useCanSettle()(reviewerUserId)
  const merge = useMergeEntity()
  const keep = useKeepEntitySeparate()
  const busy =
    (merge.isPending && merge.variables?.entityId === entity.id) ||
    (keep.isPending && keep.variables?.entityId === entity.id)
  const stale =
    (merge.isError && isStaleItem(merge.error) && merge.error) ||
    (keep.isError && isStaleItem(keep.error) && keep.error)

  return (
    <div data-possible-match={entity.id}>
      <p className="text-sm text-secondary">
        <span className="font-medium text-[color:var(--text-primary)]">{entity.name}</span> might be
        the same as:
      </p>
      <ul className="mt-2 space-y-1.5">
        {candidates.map(c => (
          <li key={`${c.kind}:${c.id}`} className="flex flex-wrap items-center gap-2 text-sm">
            {c.kind === 'staging' ? (
              <Link to={entityPath(entity.type, c.id)} className="link link-primary">
                {c.label}
              </Link>
            ) : (
              <span>{c.label}</span>
            )}
            <span className="badge badge-ghost badge-sm">
              {c.kind === 'domain' ? 'existing record' : 'from documents'}
            </span>
            <span className="text-xs text-muted tabular-nums">
              {Math.round(c.score * 100)}% alike
            </span>
            {canSettle && (
              <button
                type="button"
                className="btn btn-xs btn-outline"
                disabled={busy}
                aria-label={`Merge ${entity.name} into ${c.label}`}
                onClick={() =>
                  merge.mutate({
                    entityId: entity.id,
                    into:
                      c.kind === 'domain'
                        ? { kind: 'domain', id: c.id }
                        : { kind: 'staging', id: c.id },
                  })
                }
              >
                <ArrowsPointingInIcon className="w-3.5 h-3.5" />
                Merge
              </button>
            )}
          </li>
        ))}
      </ul>
      {canSettle ? (
        <button
          type="button"
          className="btn btn-xs btn-ghost mt-2"
          disabled={busy}
          onClick={() => keep.mutate({ entityId: entity.id })}
        >
          Keep separate
        </button>
      ) : (
        <p className="text-xs text-muted mt-2">
          Waiting for the person who added its document to decide.
        </p>
      )}
      {stale && (
        <p role="status" className="alert alert-info text-xs mt-2 py-1.5">
          {stale.message} — showing it as it stands now.
        </p>
      )}
    </div>
  )
}

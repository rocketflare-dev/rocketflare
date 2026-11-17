/**
 * One open review item (D43) as the review list renders it: a FACT (with every visible other side
 * of its conflict, each with its own source and "Use this one", so a disagreement is settled
 * where both sides can be read) or a POSSIBLE MATCH. Each links to its entity's page.
 */
import { entityPath, type KnowledgeReviewItem } from '@rocketflare/shared/ai/knowledge-facts'
import { Link } from 'react-router'
import { FactItem, factKeyLabel } from './FactParts'
import { PossibleMatch } from './PossibleMatch'

export function ReviewItem({ item }: { item: KnowledgeReviewItem }) {
  if (item.kind === 'possibleMatch') {
    return (
      <li className="px-5 py-4" data-review-item={item.entity.id}>
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-xs text-muted">Possible match</span>
          <Link to={entityPath(item.entity.type, item.entity.id)} className="text-xs link">
            Open entity
          </Link>
        </div>
        <PossibleMatch
          entity={item.entity}
          candidates={item.candidates}
          reviewerUserId={item.reviewerUserId}
        />
      </li>
    )
  }
  const { fact, entity, conflicts } = item
  return (
    <li className="px-5 py-4" data-review-item={fact.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          <Link to={entityPath(entity.type, entity.id)} className="link link-primary font-medium">
            {entity.name}
          </Link>
          <span className="text-muted"> · {factKeyLabel(fact.key)}</span>
        </span>
        <span className="text-xs text-muted">
          {conflicts.length > 0 ? 'Sources disagree' : 'Not sure it was read right'}
        </span>
      </div>
      <div className="divide-y divide-[color:var(--border-subtle)]">
        <FactItem fact={fact} />
        {conflicts.map(other => (
          <FactItem key={other.id} fact={other} />
        ))}
      </div>
    </li>
  )
}

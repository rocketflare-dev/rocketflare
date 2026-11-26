/**
 * The compact card a chat answer shows per knowledge-facts entity its tools touched (D43) —
 * `lookup_facts`, or `search_knowledge`'s facts block: the name and type, the facts the tool
 * returned with their state badges, and a link to the entity page. Built from the turn's
 * `CUSTOM kit.entity` events while streaming, and from the persisted `toolCalls` by the same pure
 * mapper (`entityCardsFromToolCalls`) afterwards. Markdown-free. An inset, not a panel: it sits
 * inside the answer's bubble (and above Search results), and a panel there would be a nested card.
 */
import { CubeIcon } from '@heroicons/react/24/outline'
import type { ChatEntityCard } from '@rocketflare/shared/ai/knowledge-facts'
import { Link } from 'react-router'
import { FactStateBadge, factKeyLabel } from './FactParts'

export function EntityFactsCard({ card }: { card: ChatEntityCard }) {
  return (
    <article className="surface-inset p-3" data-entity={card.entity.id}>
      <div className="flex items-start gap-3">
        <CubeIcon className="w-5 h-5 shrink-0 mt-0.5 text-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link to={card.href} className="link link-primary font-medium truncate">
              {card.entity.name}
            </Link>
            <span className="badge badge-ghost badge-sm">{card.entity.type}</span>
          </div>
          <ul className="mt-1.5 space-y-1">
            {card.facts.map(f => (
              <li key={f.factId} className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-secondary">{factKeyLabel(f.key)}:</span>
                <span className="font-medium">{f.valueText}</span>
                {f.state !== 'accepted' && <FactStateBadge state={f.state} />}
              </li>
            ))}
          </ul>
          {card.moreFacts > 0 && (
            <Link to={card.href} className="text-xs link mt-1 inline-block">
              {card.moreFacts} more on its page
            </Link>
          )}
        </div>
      </div>
    </article>
  )
}

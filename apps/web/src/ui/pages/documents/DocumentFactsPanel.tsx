/**
 * The document viewer's Facts tab (D43): the facts read from THIS document, grouped by the entity
 * they are about (`GET /api/knowledge/documents/:id/facts`, every state, labelled — as on the
 * entity page). The entity name opens its page; each fact shows its key, value, state and quote,
 * "Show in document" deep-links the quote (`?tab=document&offset=&end=`, marked in the Plain
 * view), and an open fact carries the inline "Is this still right?" (`FactDoubt`) — nothing here is
 * a queue. Only rendered behind `KNOWLEDGE_FACTS_GUARD`; markdown-free.
 */
import { CubeIcon } from '@heroicons/react/24/outline'
import {
  type DocumentFactGroup,
  entityPath,
  type Fact,
} from '@rocketflare/shared/ai/knowledge-facts'
import { Link } from 'react-router'
import {
  FactDoubt,
  FactStateBadge,
  factKeyLabel,
  validityLabel,
} from '@/ui/components/knowledge/FactParts'
import {
  EmptyState,
  ProvenanceQuote,
  SectionPanel,
  SkeletonRows,
  sourceFromFact,
} from '@/ui/components/shared'
import { useDocumentFacts } from '@/ui/hooks/useKnowledge'

export function DocumentFactsPanel({ documentId }: { documentId: string }) {
  const facts = useDocumentFacts(documentId)
  if (facts.isLoading)
    return (
      <SectionPanel>
        <SkeletonRows rows={4} />
      </SectionPanel>
    )
  if (facts.isError || !facts.data)
    return (
      <SectionPanel>
        <p className="text-sm text-error" role="alert">
          The facts could not be loaded.
        </p>
      </SectionPanel>
    )
  const { groups, entityTypesRegistered } = facts.data
  if (groups.length === 0)
    return (
      <SectionPanel>
        <EmptyState
          icon={CubeIcon}
          size="sm"
          message="No facts were read from this document"
          description={
            entityTypesRegistered === 0
              ? 'Fact extraction has no entity types to look for yet, so it reads nothing. A developer registers them (APP_ENTITY_TYPES in api/services/knowledge/entity-types.ts, or a plugin).'
              : 'Facts are read when a document is indexed. This one named none of the entity types the workspace tracks, or it was indexed before extraction was turned on.'
          }
        />
      </SectionPanel>
    )
  return (
    <div className="space-y-4">
      <p className="text-sm text-secondary">
        {count(groups)} read from this document about {groups.length}{' '}
        {groups.length === 1 ? 'entity' : 'entities'}.
      </p>
      {groups.map(group => (
        <EntityGroup
          key={`${group.entity.kind}:${group.entity.type}:${group.entity.id}`}
          group={group}
        />
      ))}
    </div>
  )
}

function count(groups: DocumentFactGroup[]): string {
  const n = groups.reduce((sum, g) => sum + g.facts.length, 0)
  return `${n} ${n === 1 ? 'fact' : 'facts'}`
}

function EntityGroup({ group }: { group: DocumentFactGroup }) {
  const { entity } = group
  return (
    <SectionPanel
      flush
      title={
        <span className="inline-flex items-center gap-2 flex-wrap">
          <CubeIcon className="w-4 h-4 text-muted" aria-hidden="true" />
          <Link to={entityPath(entity.type, entity.id)} className="link link-primary">
            {entity.name}
          </Link>
          <span className="badge badge-ghost badge-sm font-normal">{entity.typeLabel}</span>
        </span>
      }
    >
      <ul
        className="divide-y divide-[color:var(--border-subtle)]"
        aria-label={`Facts about ${entity.name}`}
      >
        {group.facts.map(fact => (
          <DocumentFactRow key={fact.id} fact={fact} />
        ))}
      </ul>
    </SectionPanel>
  )
}

function DocumentFactRow({ fact }: { fact: Fact }) {
  const validity = validityLabel(fact)
  const { source } = fact
  return (
    <li className="px-5 py-3 text-sm" data-fact={fact.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-secondary">{factKeyLabel(fact.key)}:</span>
        <span className="font-medium break-words">{fact.valueText}</span>
        <FactStateBadge state={fact.state} />
        {validity && <span className="text-xs text-muted">{validity}</span>}
      </div>
      <ProvenanceQuote quote={source.quote} to={sourceFromFact(source).quoteTo} />
      <FactDoubt fact={fact} />
    </li>
  )
}

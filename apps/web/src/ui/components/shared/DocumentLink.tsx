/**
 * One knowledge document on ONE LINE — the inline form of a `Provenance` source (type icon,
 * title, the one fact that still fits beside it). Kept as its own name because plugins import
 * it; new code passes sources to `Provenance` (`layout="inline"`) instead.
 *
 * `DocumentCard` is the right shape where the document IS the content (Search results). This is
 * the shape for a reference inside something else.
 *
 * **Markdown-free by construction**: it lives in the barrel `App.tsx` imports eagerly.
 *
 * It takes primitives rather than a `DocumentCard` object so a CITATION (`{ documentId, title }`)
 * can use it too; `documentLinkProps(card)` is the adapter for the callers that hold a card.
 */
import type { DocumentCard as DocumentCardData } from '@rocketflare/shared/ai/embeddings'
import { ProvenanceLink, passagesLabel } from './Provenance'

export interface DocumentLinkProps {
  to: string
  title: string
  /** One short fact after the title — a passage count, a size. Anything longer belongs on a card. */
  meta?: string
  /** Only rendered when it is not `indexed`: "this one is still converting" is worth the space. */
  status?: DocumentCardData['status']
  id?: string
  /** "PDF", "Markdown"… picks the icon and is shown before `meta`. */
  typeLabel?: string | null
}

export function DocumentLink({ to, title, meta, status, id, typeLabel }: DocumentLinkProps) {
  return (
    <ProvenanceLink
      className="flex text-sm"
      source={{ id: id ?? to, to, title, meta, status, typeLabel }}
    />
  )
}

/** A `DocumentCard` as a one-liner: everything that survives the width, nothing that does not. */
export function documentLinkProps(card: DocumentCardData): DocumentLinkProps {
  return {
    id: card.id,
    to: card.href,
    title: card.title,
    meta: passagesLabel(card.passages) ?? undefined,
    status: card.status,
    typeLabel: card.typeLabel,
  }
}

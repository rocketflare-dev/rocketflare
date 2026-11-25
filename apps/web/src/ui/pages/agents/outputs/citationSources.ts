/**
 * An agent's citations (`{ documentId, title }` — all the output stores) as `Provenance` sources,
 * filled in with each document's type and passage count from its card. The cards are the SAME
 * cached `documents.card(id)` entries the answer's inline document links read, so a citation the
 * answer also links costs no second request. A card that fails (the document was deleted since
 * the run) leaves the citation as it was stored: the title, linking to the viewer.
 */
import { useQueries } from '@tanstack/react-query'
import { type ProvenanceSource, sourceFromCard, sourceFromCitation } from '@/ui/components/shared'
import { documentCardQueryOptions } from '@/ui/hooks/useDocuments'

/** A citation as an agent output stores it — any agent's, not one example's. */
export interface Citation {
  documentId: string
  title: string
}

export function useCitationSources(citations: readonly Citation[]): ProvenanceSource[] {
  const cards = useQueries({
    queries: citations.map(c => ({ ...documentCardQueryOptions(c.documentId), retry: false })),
  })
  return citations.map((citation, index) => {
    const card = cards[index]?.data
    // The title the agent cited stays: it is the name the answer used.
    return card ? { ...sourceFromCard(card), title: citation.title } : sourceFromCitation(citation)
  })
}

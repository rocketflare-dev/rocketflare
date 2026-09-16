/**
 * One knowledge document on ONE LINE — icon, title, and the one fact that still fits beside it.
 *
 * `DocumentCard` is the right shape where the document IS the content (Search results, a citation
 * standing alone in an answer). It is the wrong shape inside a dense list: a run timeline's tool
 * result cites four documents, and four cards push the next stage off the screen. This is the same
 * data rendered as what it is in that context — a link.
 *
 * **Markdown-free by construction**, like `DocumentCard` beside it: heroicons, `react-router-dom`
 * and the shared types only, because it lives in the barrel `App.tsx` imports eagerly.
 *
 * It takes primitives rather than a `DocumentCard` object so a CITATION (`{ documentId, title }` —
 * all `research-topic` returns) can use it too; `documentLinkProps(card)` is the adapter for the
 * callers that do hold a card, so the two sites cannot drift on what "one line" means.
 */
import { DocumentTextIcon } from '@heroicons/react/24/outline'
import type { DocumentCard as DocumentCardData } from '@rocketflare/shared/ai/embeddings'
import { Link } from 'react-router-dom'

const STATUS_LABELS: Record<DocumentCardData['status'], string> = {
  pending: 'Indexing',
  indexed: 'Indexed',
  failed: 'Failed',
}

const STATUS_TONE: Record<DocumentCardData['status'], string> = {
  pending: 'pending',
  indexed: 'completed',
  failed: 'failed',
}

export interface DocumentLinkProps {
  to: string
  title: string
  /** One short fact after the title — a passage count, a size. Anything longer belongs on a card. */
  meta?: string
  /** Only rendered when it is not `indexed`: "this one is still converting" is worth the space. */
  status?: DocumentCardData['status']
  id?: string
}

export function DocumentLink({ to, title, meta, status, id }: DocumentLinkProps) {
  return (
    <span className="flex items-center gap-1.5 min-w-0 text-sm" data-document={id}>
      <DocumentTextIcon className="w-4 h-4 shrink-0 text-muted" aria-hidden="true" />
      <Link to={to} className="link link-primary truncate">
        {title}
      </Link>
      {meta && <span className="text-xs text-muted tabular-nums shrink-0">{meta}</span>}
      {status && status !== 'indexed' && (
        <span className="status-badge shrink-0" data-status={STATUS_TONE[status]}>
          {STATUS_LABELS[status]}
        </span>
      )}
    </span>
  )
}

/** A `DocumentCard` as a one-liner: everything that survives the width, nothing that does not. */
export function documentLinkProps(card: DocumentCardData): DocumentLinkProps {
  return {
    id: card.id,
    to: card.href,
    title: card.title,
    meta: `${card.passages} ${card.passages === 1 ? 'passage' : 'passages'}`,
    status: card.status,
  }
}

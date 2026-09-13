/**
 * The compact form one knowledge document takes wherever it is cited — a Search result header, an
 * agent run's sources, a chat answer (D18). **Markdown-free by construction**: heroicons,
 * `react-router-dom`, the shared schemas and `lib/format` only. That is what lets it live in the
 * `components/shared` barrel `App.tsx` imports eagerly — `components/ai/Markdown` must stay in the
 * lazy chat and agents chunks, so a card that rendered markdown could never be used from Search.
 *
 * `excerpt` is the head of the document's text, not a summary and not a thumbnail (there is no
 * `documents.summary` column and no rasterisation on Workers): it is null while a document is
 * still converting, and for a converted PDF it is usually the cover page.
 */
import { DocumentTextIcon } from '@heroicons/react/24/outline'
import type { DocumentCard as DocumentCardData } from '@rocketflare/shared/ai/embeddings'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { formatBytes } from '@/ui/lib/format'

const STATUS_LABELS: Record<DocumentCardData['status'], string> = {
  pending: 'Indexing',
  indexed: 'Indexed',
  failed: 'Failed',
}

/** `.status-badge` tones from index.css. */
const STATUS_TONE: Record<DocumentCardData['status'], string> = {
  pending: 'pending',
  indexed: 'completed',
  failed: 'failed',
}

export interface DocumentCardProps {
  card: DocumentCardData
  /** Where the title links; defaults to the card's own `href` (the viewer). */
  to?: string
  /** Drop the excerpt and tighten the padding — for a list header above its own hits. */
  dense?: boolean
  /** Rendered under the excerpt: actions, hit counts, whatever the caller owns. */
  footer?: ReactNode
}

export function DocumentCard({ card, to, dense = false, footer }: DocumentCardProps) {
  return (
    <article
      className={`surface-panel rounded-lg ${dense ? 'p-3' : 'p-4'}`}
      data-document={card.id}
    >
      <div className="flex items-start gap-3">
        <DocumentTextIcon className="w-5 h-5 shrink-0 mt-0.5 text-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link to={to ?? card.href} className="link link-primary font-medium truncate">
              {card.title}
            </Link>
            {/* A tool-derived card may know no type; a guessed "Text" on a PDF is worse than none. */}
            {card.typeLabel && <span className="badge badge-ghost badge-sm">{card.typeLabel}</span>}
            {card.status !== 'indexed' && (
              <span className="status-badge" data-status={STATUS_TONE[card.status]}>
                {STATUS_LABELS[card.status]}
              </span>
            )}
          </div>
          <p className="text-xs text-muted tabular-nums mt-0.5">
            {card.passages} {card.passages === 1 ? 'passage' : 'passages'}
            {/* A card built from a tool result knows no size; omit it rather than render "0 B". */}
            {card.sizeBytes !== null && ` · ${formatBytes(card.sizeBytes)}`}
          </p>
          {!dense && card.excerpt && (
            <p className="text-sm text-secondary mt-2 line-clamp-3 break-words">{card.excerpt}</p>
          )}
          {footer && <div className="mt-2">{footer}</div>}
        </div>
      </div>
    </article>
  )
}

/**
 * Where an answer came from — the one treatment for "the AI shows its working". A chat answer,
 * an agent's output, a timeline tool result and a knowledge fact all name their sources the
 * same way: the document (type icon, title linking to it, one short fact), the passage it was read
 * from when the data carries it, and, for work an agent did, one line saying how it got there.
 *
 * Two layouts of the same data:
 * - `list` (default) — a numbered list under a small heading, set apart from the answer above it
 *   by a hairline. For an answer that stands on its own (chat, an agent's output).
 * - `inline` — the sources on one wrapping line, no heading. For a reference inside something
 *   else (a timeline row, the source of a fact).
 *
 * Nothing to show (no sources and no work line) renders nothing: an answer with no provenance
 * says so in its own words if it needs to, never through an empty box.
 *
 * **Markdown-free by construction**, like `DocumentCard`: heroicons, `react-router` and the shared
 * types only, because it lives in the barrel `App.tsx` imports eagerly. Quotes are document text,
 * rendered verbatim.
 */
import {
  CodeBracketIcon,
  DocumentIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  QueueListIcon,
  TableCellsIcon,
} from '@heroicons/react/24/outline'
import type { DocumentCard, DocumentStatus } from '@rocketflare/shared/ai/embeddings'
import { documentPath } from '@rocketflare/shared/ai/embeddings'
import type { ComponentType, SVGProps } from 'react'
import { Link } from 'react-router'

export interface ProvenanceSource {
  /** The document id: the React key and `data-source`. */
  id: string
  title: string
  /** Where the title links — the viewer, or a deep link to the passage. */
  to: string
  /** "PDF", "Markdown"… Null when the caller does not know (never guessed). */
  typeLabel?: string | null
  /** One short fact after the title: a passage count, a date. */
  meta?: string | null
  /** Shown only when it is not `indexed`. */
  status?: DocumentStatus
  /** The passage the claim was read from, verbatim. */
  quote?: string | null
  /** Where "Show in document" opens the quote; defaults to `to`. */
  quoteTo?: string | null
}

/** How the work was done — the run, its steps — on one line. */
export interface ProvenanceWork {
  summary: string
  /** A link to the run, when the reader is not already looking at it. */
  to?: string
  linkLabel?: string
}

export interface ProvenanceProps {
  sources: readonly ProvenanceSource[]
  work?: ProvenanceWork | null
  layout?: 'list' | 'inline'
  /** The list's heading; defaults to "Source" / "N sources". */
  heading?: string
  /** `inline` only: the word before the sources ("From", "Used"). */
  lead?: string
  className?: string
}

const STATUS_LABELS: Record<DocumentStatus, string> = {
  pending: 'Indexing',
  indexed: 'Indexed',
  failed: 'Failed',
}

const STATUS_TONE: Record<DocumentStatus, string> = {
  pending: 'pending',
  indexed: 'completed',
  failed: 'failed',
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>

/** The icon a document's type label earns; a plain page when the type is unknown. */
export function sourceTypeIcon(typeLabel: string | null | undefined): Icon {
  switch (typeLabel) {
    case 'Excel':
    case 'CSV':
      return TableCellsIcon
    case 'JSON':
    case 'XML':
      return CodeBracketIcon
    case 'HTML':
      return GlobeAltIcon
    case 'PDF':
      return DocumentIcon
    default:
      return DocumentTextIcon
  }
}

export function passagesLabel(n: number): string | null {
  return n > 0 ? `${n} ${n === 1 ? 'passage' : 'passages'}` : null
}

/** A document card (chat stream, tool result, search) as a source. */
export function sourceFromCard(card: DocumentCard): ProvenanceSource {
  return {
    id: card.id,
    title: card.title,
    to: card.href,
    typeLabel: card.typeLabel,
    meta: passagesLabel(card.passages),
    status: card.status,
  }
}

/** A citation an agent returned (`{ documentId, title }`) as a source. */
export function sourceFromCitation(citation: {
  documentId: string
  title: string
}): ProvenanceSource {
  return {
    id: citation.documentId,
    title: citation.title,
    to: documentPath(citation.documentId),
  }
}

/** The source of a knowledge fact: its document, linked at the passage, with the verbatim quote. */
export function sourceFromFact(
  source: {
    documentId: string
    documentTitle: string
    chunkId: string | null
    charStart: number | null
    charEnd: number | null
    quote: string
  },
  meta?: string | null
): ProvenanceSource {
  const located = source.charStart !== null
  return {
    id: source.documentId,
    title: source.documentTitle,
    to: documentPath(source.documentId, { offset: source.charStart, chunk: source.chunkId }),
    meta: meta ?? null,
    quote: source.quote || null,
    quoteTo:
      located || source.chunkId
        ? documentPath(source.documentId, {
            tab: 'document',
            offset: source.charStart,
            end: source.charEnd,
            chunk: located ? null : source.chunkId,
          })
        : null,
  }
}

/** One source on one line: type icon, title, meta, status. The building block of both layouts. */
export function ProvenanceLink({
  source,
  className = '',
}: {
  source: ProvenanceSource
  className?: string
}) {
  const TypeIcon = sourceTypeIcon(source.typeLabel)
  const meta = [source.typeLabel, source.meta].filter(Boolean).join(' · ')
  return (
    <span
      className={`inline-flex items-center gap-1.5 min-w-0 max-w-full align-middle ${className}`}
      data-source={source.id}
      data-document={source.id}
    >
      <TypeIcon className="w-4 h-4 shrink-0 text-muted" aria-hidden="true" />
      <Link to={source.to} className="link link-primary truncate">
        {source.title}
      </Link>
      {meta && <span className="text-xs text-muted tabular-nums shrink-0">{meta}</span>}
      {source.status && source.status !== 'indexed' && (
        <span className="status-badge shrink-0" data-status={STATUS_TONE[source.status]}>
          {STATUS_LABELS[source.status]}
        </span>
      )}
    </span>
  )
}

/**
 * A cited passage, verbatim, in an inset well, with "Show in document" when it can be located.
 * Exported for a surface whose source document is already the page (a document's own facts).
 */
export function ProvenanceQuote({
  quote,
  to,
  className = '',
}: {
  quote: string | null | undefined
  to?: string | null
  className?: string
}) {
  if (!quote) return null
  return (
    <figure className={`mt-1.5 surface-inset px-3 py-2 text-sm max-w-[75ch] ${className}`}>
      <blockquote className="text-secondary whitespace-pre-wrap break-words line-clamp-4">
        {quote}
      </blockquote>
      {to && (
        <figcaption className="mt-1">
          <Link to={to} className="link link-primary text-xs">
            Show in document
          </Link>
        </figcaption>
      )}
    </figure>
  )
}

function Quote({ source }: { source: ProvenanceSource }) {
  return <ProvenanceQuote quote={source.quote} to={source.quoteTo} />
}

function WorkLine({ work }: { work: ProvenanceWork }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-secondary max-w-[75ch]">
      <QueueListIcon className="w-4 h-4 shrink-0 text-muted" aria-hidden="true" />
      <span>
        {work.summary}
        {work.to && (
          <>
            {' '}
            <Link to={work.to} className="link link-primary">
              {work.linkLabel ?? 'Open the run'}
            </Link>
          </>
        )}
      </span>
    </p>
  )
}

export function Provenance({
  sources,
  work,
  layout = 'list',
  heading,
  lead,
  className = '',
}: ProvenanceProps) {
  if (sources.length === 0 && !work) return null

  if (layout === 'inline') {
    return (
      <div className={`min-w-0 text-sm ${className}`} data-provenance="inline">
        {sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 min-w-0">
            {lead && <span className="text-xs text-muted">{lead}</span>}
            {sources.map(source => (
              <ProvenanceLink key={source.id} source={source} />
            ))}
          </div>
        )}
        {sources.map(source => (
          <Quote key={source.id} source={source} />
        ))}
        {work && (
          <div className="mt-1">
            <WorkLine work={work} />
          </div>
        )}
      </div>
    )
  }

  const title = heading ?? (sources.length === 1 ? 'Source' : `${sources.length} sources`)
  return (
    <section
      className={`mt-3 pt-3 border-t border-[color:var(--border-subtle)] text-sm ${className}`}
      aria-label={sources.length > 0 ? 'Sources' : 'How this was made'}
      data-provenance="list"
    >
      {sources.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-secondary mb-1.5">{title}</h3>
          <ol className="space-y-1.5">
            {sources.map((source, index) => (
              <li key={source.id} className="flex items-start gap-2 min-w-0">
                <span
                  className="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--tone-primary-surface)] px-1 text-xs font-semibold text-primary tabular-nums"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <ProvenanceLink source={source} className="flex" />
                  <Quote source={source} />
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      {work && (
        <div className={sources.length > 0 ? 'mt-2' : ''}>
          <WorkLine work={work} />
        </div>
      )}
    </section>
  )
}

/**
 * `/documents/:documentId` (D18): read one knowledge document. Before this, a document was a row
 * you only ever saw the edges of — Search could find a passage and never open the thing it came
 * from, and an uploaded PDF was a download link.
 *
 * Two tabs (`?tab=document|details`). The Document tab dispatches on `fileId`, the upload kind and
 * the status: a PDF is embedded with `<object>` (its CHILDREN are the fallback — there is no
 * reliable success event for `<object>`, so nothing here tries to detect failure), anything else
 * renders its text, and a document still being converted shows that and polls. The panel header
 * always carries both **Download original** and a **Converted text** toggle, so a browser with a
 * poor in-page viewer (iOS Safari) has a one-click escape rather than a blank box.
 *
 * Deep links: `?offset=` is authoritative and is snapped to a window boundary by the hook, so a
 * link and the reader's own paging share one cache entry; `?chunk=` is the fallback when a
 * passage's `charOffset` is null (a re-chunked document); `?q=` highlights matches as `<mark>`
 * nodes. Markdown output cannot be highlighted through the AST, so `?q=` on a markdown document
 * defaults to the plain rendering and says why.
 *
 * `content` is capped at `INGEST_TEXT_MAX_CHARS`, so a document is at most 25 windows: Previous /
 * Next issue one query per snapped offset and nothing accumulates in local state.
 */
import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  DocumentTextIcon,
  ListBulletIcon,
} from '@heroicons/react/24/outline'
import { EMBEDDING_DIM } from '@rocketflare/shared/ai/config'
import {
  DOCUMENT_UPLOAD_TYPES,
  DOCUMENT_WINDOW_CHARS,
  type DocumentContent,
  documentPath,
  documentTypeLabel,
  isDocumentUploadMimeType,
  windowStart,
} from '@rocketflare/shared/ai/embeddings'
import { filePath, isEmbeddableMimeType } from '@rocketflare/shared/files'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Markdown } from '@/ui/components/ai/Markdown'
import {
  EmptyState,
  PageHeader,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
  type TabConfig,
  URLTabs,
} from '@/ui/components/shared'
import { useDocument, useDocumentContent, useDocumentPassages } from '@/ui/hooks/useDocuments'
import { ApiError } from '@/ui/lib/api-client'
import { formatBytes, formatDateTime } from '@/ui/lib/format'
import { highlightMatches } from '@/ui/lib/highlight'

/** Content types whose converted text is markdown, so it renders rather than sits in a `<pre>`. */
function rendersAsMarkdown(contentType: string): boolean {
  if (contentType === 'text/markdown') return true
  // Everything the converter produces is markdown, whatever the original was.
  return (
    isDocumentUploadMimeType(contentType) && DOCUMENT_UPLOAD_TYPES[contentType].kind === 'convert'
  )
}

export default function DocumentViewPage() {
  const { documentId } = useParams<{ documentId: string }>()
  const [params] = useSearchParams()
  const document = useDocument(documentId)
  const doc = document.data
  const q = params.get('q')
  const offset = Number(params.get('offset') ?? 0)
  const chunkId = params.get('chunk')

  if (document.isLoading) {
    return (
      <div className="max-w-5xl">
        <SectionPanel title="Loading">
          <SkeletonRows rows={4} />
        </SectionPanel>
      </div>
    )
  }
  if (document.isError || !doc) {
    return (
      <div className="max-w-5xl">
        <EmptyState
          icon={DocumentTextIcon}
          message="Document not found"
          description="It may have been deleted, or it belongs to another organisation."
          action={
            <Link to="/documents" className="btn btn-primary btn-sm">
              Back to Knowledge
            </Link>
          }
        />
      </div>
    )
  }

  const tabs: TabConfig[] = [
    {
      id: 'document',
      label: 'Document',
      icon: <DocumentTextIcon className="w-4 h-4" />,
      content: <DocumentPanel doc={doc} offset={offset} q={q} chunkId={chunkId} />,
    },
    {
      id: 'details',
      label: 'Details',
      icon: <ListBulletIcon className="w-4 h-4" />,
      content: <DetailsPanel doc={doc} />,
    },
  ]

  return (
    <div className="max-w-5xl">
      <PageHeader
        title={doc.title}
        description={`${documentTypeLabel(doc.contentType)} · ${doc.chunkCount} ${
          doc.chunkCount === 1 ? 'passage' : 'passages'
        } · ${formatBytes(doc.sizeBytes)}`}
        breadcrumbs={[{ label: 'Knowledge', to: '/documents' }, { label: doc.title }]}
      />
      <URLTabs tabs={tabs} defaultTab="document" />
    </div>
  )
}

type DocumentRow = NonNullable<ReturnType<typeof useDocument>['data']>

function DocumentPanel({
  doc,
  offset,
  q,
  chunkId,
}: {
  doc: DocumentRow
  offset: number
  q: string | null
  chunkId: string | null
}) {
  const embeddable = Boolean(doc.fileId) && isEmbeddableMimeType(doc.contentType)
  // A deep link is always about the TEXT: `charOffset` is an offset into the converted markdown,
  // which has no relationship to a PDF's pages, so a link that names one opens the text view.
  const [showText, setShowText] = useState(!embeddable || offset > 0 || Boolean(chunkId))

  return (
    <SectionPanel
      flush
      title={embeddable && !showText ? 'Original' : 'Text'}
      actions={
        <div className="flex items-center gap-2">
          {embeddable && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => setShowText(v => !v)}
            >
              {showText ? 'Original' : 'Converted text'}
            </button>
          )}
          {doc.fileId && (
            <a
              className="btn btn-ghost btn-xs gap-1.5"
              href={filePath(doc.fileId)}
              download
              title="Download the original file"
            >
              <ArrowDownTrayIcon className="w-4 h-4" />
              Download original
            </a>
          )}
        </div>
      }
    >
      {embeddable && !showText ? (
        <div className="p-4 space-y-2">
          {/*
            The children of `<object>` are its fallback — the browser renders them when it cannot
            display the data. There is no load/error event to trust here, so this is the ONLY
            failure handling, and the header's Download and Converted text controls are the escape.
          */}
          <object
            data={filePath(doc.fileId as string)}
            type="application/pdf"
            className="w-full h-[70vh] rounded border border-[color:var(--border-subtle)]"
            aria-label={`${doc.title} (PDF)`}
          >
            <p className="text-sm text-secondary p-4">
              This browser cannot show the PDF in the page.{' '}
              <a className="link link-primary" href={filePath(doc.fileId as string)} download>
                Download it
              </a>{' '}
              or switch to the converted text.
            </p>
          </object>
          {doc.status === 'pending' && (
            <p className="text-sm text-muted">
              The original is ready to read; its text is still being converted, so it is not
              searchable yet.
            </p>
          )}
        </div>
      ) : (
        <TextView doc={doc} offset={offset} q={q} chunkId={chunkId} />
      )}
    </SectionPanel>
  )
}

function TextView({
  doc,
  offset,
  q,
  chunkId,
}: {
  doc: DocumentRow
  offset: number
  q: string | null
  chunkId: string | null
}) {
  // `?chunk=` is the fallback for a passage whose `charOffset` could not be resolved: look the
  // passage up and use its own offset when it has one.
  const passages = useDocumentPassages(doc.id, { pageSize: 100 }, Boolean(chunkId) && offset === 0)
  const chunkOffset = chunkId
    ? (passages.data?.items.find(p => p.id === chunkId)?.charOffset ?? null)
    : null
  const target = offset > 0 ? offset : (chunkOffset ?? 0)
  const content = useDocumentContent(doc.id, target)

  if (content.isLoading) {
    return (
      <div className="p-4">
        <SkeletonRows rows={5} />
      </div>
    )
  }
  if (content.isError) {
    const err = content.error
    const code = err instanceof ApiError ? err.code : undefined
    if (code === 'document_not_converted') {
      return (
        <p className="p-4 text-sm text-secondary" aria-live="polite">
          This document is still being converted — its text will appear here when the job lands.
        </p>
      )
    }
    if (code === 'document_conversion_failed') {
      return (
        <p className="p-4 text-sm text-error" role="alert">
          This document could not be indexed{doc.error ? `: ${doc.error}` : ''}. The original is
          still downloadable.
        </p>
      )
    }
    return (
      <p className="p-4 text-sm text-error" role="alert">
        The text could not be loaded.
      </p>
    )
  }
  const window = content.data
  if (!window) return null
  return (
    <TextWindow
      window={window}
      documentId={doc.id}
      markdown={rendersAsMarkdown(doc.contentType)}
      q={q}
      highlightAt={target > 0 ? target : null}
    />
  )
}

function TextWindow({
  window,
  documentId,
  markdown,
  q,
  highlightAt,
}: {
  window: DocumentContent
  documentId: string
  markdown: boolean
  q: string | null
  highlightAt: number | null
}) {
  // Markdown always renders AS markdown — that is what it is for, and a deep link that dumped the
  // raw source would be a worse answer than the one it came from. Highlighting is what gives way:
  // `<mark>` cannot be threaded through react-markdown's AST without rewriting the renderer, so the
  // Plain toggle is where a query's matches and a linked passage's anchor show, and the note below
  // says so instead of leaving somebody to wonder why their search term is not marked.
  const [rendered, setRendered] = useState(markdown)
  const anchor = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    anchor.current?.scrollIntoView({ block: 'center' })
  }, [])

  const windows = Math.max(1, Math.ceil(window.totalChars / DOCUMENT_WINDOW_CHARS))
  const current = Math.floor(window.offset / DOCUMENT_WINDOW_CHARS) + 1
  // Where the deep link's passage starts WITHIN this window (the window is snapped down to a
  // boundary, so the target is at or after its start).
  const anchorAt = highlightAt !== null ? highlightAt - window.offset : null

  return (
    <div className="p-4 space-y-3">
      {markdown && (
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            className={`btn btn-ghost btn-xs ${rendered ? 'btn-active' : ''}`}
            onClick={() => setRendered(true)}
          >
            Rendered
          </button>
          <button
            type="button"
            className={`btn btn-ghost btn-xs ${rendered ? '' : 'btn-active'}`}
            onClick={() => setRendered(false)}
          >
            Plain
          </button>
          {rendered && (q || anchorAt !== null) && (
            <span className="text-muted">
              {q
                ? `Switch to Plain to see “${q}” highlighted`
                : 'Switch to Plain to jump to the linked passage'}
              {q && anchorAt !== null ? ' and jump to the linked passage' : ''}.
            </span>
          )}
        </div>
      )}

      {rendered ? (
        <Markdown content={window.text} />
      ) : (
        <pre className="whitespace-pre-wrap break-words text-sm font-sans text-secondary">
          {anchorAt !== null && anchorAt >= 0 && anchorAt < window.text.length ? (
            <>
              <PlainText text={window.text.slice(0, anchorAt)} q={q} />
              <span ref={anchor} className="bg-warning/30 rounded-sm">
                <PlainText text={window.text.slice(anchorAt)} q={q} />
              </span>
            </>
          ) : (
            <PlainText text={window.text} q={q} />
          )}
        </pre>
      )}

      <nav className="flex items-center justify-between pt-2 border-t border-[color:var(--border-subtle)]">
        <Link
          to={documentPath(documentId, {
            offset: Math.max(0, windowStart(window.offset) - DOCUMENT_WINDOW_CHARS),
            q,
          })}
          className={`btn btn-ghost btn-xs gap-1 ${window.offset === 0 ? 'btn-disabled' : ''}`}
          aria-disabled={window.offset === 0}
        >
          <ArrowLeftIcon className="w-4 h-4" />
          Previous
        </Link>
        <span className="text-xs text-muted tabular-nums">
          window {current} of {windows} · {window.totalChars.toLocaleString()} characters
        </span>
        <Link
          to={documentPath(documentId, { offset: window.nextOffset ?? window.offset, q })}
          className={`btn btn-ghost btn-xs gap-1 ${window.hasMore ? '' : 'btn-disabled'}`}
          aria-disabled={!window.hasMore}
        >
          Next
          <ArrowRightIcon className="w-4 h-4" />
        </Link>
      </nav>
    </div>
  )
}

/** Text with `?q=` matches wrapped in `<mark>` NODES — never `dangerouslySetInnerHTML`. */
function PlainText({ text, q }: { text: string; q: string | null }) {
  const segments = useMemo(() => highlightMatches(text, q), [text, q])
  if (segments.length === 1 && !segments[0]?.match) return <>{text}</>
  return (
    <>
      {segments.map((segment, i) =>
        segment.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional, not identified
          <mark key={i} className="bg-warning/40 text-inherit rounded-sm">
            {segment.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional, not identified
          <span key={i}>{segment.text}</span>
        )
      )}
    </>
  )
}

function DetailsPanel({ doc }: { doc: DocumentRow }) {
  const [page, setPage] = useState(1)
  const passages = useDocumentPassages(doc.id, { page })
  const content = useDocumentContent(doc.id, 0, doc.status === 'indexed')
  const totalChars = content.data?.totalChars ?? null

  return (
    <div className="space-y-4">
      <SectionPanel title="Metadata">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Field
            label="Type"
            value={`${documentTypeLabel(doc.contentType)} (${doc.contentType})`}
          />
          <Field label="Source" value={doc.source ?? '—'} />
          <Field
            label="Status"
            value={doc.status === 'failed' ? `Failed: ${doc.error ?? 'unknown error'}` : doc.status}
          />
          <Field label="Size" value={formatBytes(doc.sizeBytes)} />
          <Field label="Created" value={formatDateTime(doc.createdAt)} />
          <Field label="Updated" value={formatDateTime(doc.updatedAt)} />
          <Field label="Document id" value={doc.id} mono />
          <Field label="Added by" value={doc.ownerUserId ?? 'system'} mono />
          {doc.fileId && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted">Original file</dt>
              <dd>
                <a
                  className="link link-primary inline-flex items-center gap-1.5"
                  href={filePath(doc.fileId)}
                  download
                >
                  <ArrowDownTrayIcon className="w-4 h-4" />
                  Download
                </a>
              </dd>
            </div>
          )}
        </dl>
      </SectionPanel>

      <SectionPanel title="Chunking" description="How the document was split for retrieval.">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Field label="Passages" value={String(doc.chunkCount)} />
          <Field
            label="Characters"
            value={totalChars === null ? 'No text stored yet' : totalChars.toLocaleString()}
          />
          <Field
            label="Average passage"
            value={
              totalChars === null || doc.chunkCount === 0
                ? '—'
                : `${Math.round(totalChars / doc.chunkCount).toLocaleString()} characters`
            }
          />
          <Field label="Embedding dimension" value={String(EMBEDDING_DIM)} />
        </dl>
      </SectionPanel>

      <SectionPanel flush title="Passages">
        {passages.isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={3} />
          </div>
        ) : !passages.data || passages.data.items.length === 0 ? (
          <p className="p-4 text-sm text-muted">This document has no indexed passages.</p>
        ) : (
          <ul className="divide-y divide-[color:var(--border-subtle)]" aria-label="Passages">
            {passages.data.items.map(passage => (
              <li key={passage.id} className="p-4">
                <div className="flex items-center gap-2 flex-wrap text-xs mb-1">
                  <span className="font-semibold tabular-nums">
                    passage {passage.seq + 1} of {doc.chunkCount}
                  </span>
                  <span className="text-muted tabular-nums">~{passage.tokenCount} tokens</span>
                  {passage.charOffset !== null && (
                    <span className="text-muted tabular-nums">
                      at character {passage.charOffset}
                    </span>
                  )}
                  <Link
                    className="link link-primary"
                    to={documentPath(doc.id, {
                      tab: 'document',
                      offset: passage.charOffset,
                      chunk: passage.id,
                    })}
                  >
                    Open in document
                  </Link>
                </div>
                <details>
                  <summary className="text-xs text-muted cursor-pointer">Text</summary>
                  <p className="text-sm text-secondary whitespace-pre-wrap break-words mt-1">
                    {passage.text}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        )}
        {passages.data && (
          <div className="px-5 pb-5">
            <PaginationControls
              pagination={passages.data.pagination}
              onPageChange={setPage}
              isLoading={passages.isFetching}
            />
          </div>
        )}
      </SectionPanel>
    </div>
  )
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`break-words ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}

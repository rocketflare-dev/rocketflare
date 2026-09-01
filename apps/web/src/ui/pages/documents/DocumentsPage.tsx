/**
 * `/documents` (D18, D20): the tenant knowledge base. Ingest form (title, text counted against
 * `INGEST_TEXT_MAX_CHARS`, optional source) → `POST /api/ai/documents/ingest` (201, `indexed` at
 * once for small texts or `pending` until the queue lands — the list polls while any row is
 * pending); the documents table (title, source, status with the failure reason on hover, chunks,
 * created, delete after confirm — own rows for everyone, any row for `delete Document`); and hybrid
 * search (`POST /search`) with rank, fused score, dense/lexical rank badges, snippet and the
 * document title, optionally restricted to one document (`?documentId=` preselects it — the run
 * drawer links here). Hits are the search mutation's data, never cached as server state.
 */

import { BookOpenIcon, MagnifyingGlassIcon, TrashIcon } from '@heroicons/react/24/outline'
import {
  type Document,
  type DocumentStatus,
  INGEST_TEXT_MAX_CHARS,
  ingestTextRequestSchema,
  type SearchHit,
  searchRequestSchema,
} from '@rocketflare/shared/ai/embeddings'
import { type FormEvent, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ConfirmModal,
  EmptyState,
  FieldError,
  fieldErrorFor,
  PageHeader,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { useDeleteDocument, useDocuments, useIngestText, useSearch } from '@/ui/hooks/useDocuments'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { showToast } from '@/ui/lib/api-client'
import { formatDateTime } from '@/ui/lib/format'

type Issue = { path: PropertyKey[]; message: string }

const STATUS_LABELS: Record<DocumentStatus, string> = {
  pending: 'Indexing',
  indexed: 'Indexed',
  failed: 'Failed',
}

/** `.status-badge` tones from index.css: pending → info, indexed → success, failed → error. */
const STATUS_TONE: Record<DocumentStatus, string> = {
  pending: 'pending',
  indexed: 'completed',
  failed: 'failed',
}

export default function DocumentsPage() {
  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Knowledge"
        description="Text this workspace can search. Add a document, then ask it questions."
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start mb-4">
        <IngestPanel />
        <SearchPanel />
      </div>
      <DocumentsTable />
    </div>
  )
}

function IngestPanel() {
  const ingest = useIngestText()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [source, setSource] = useState('')
  const [issues, setIssues] = useState<Issue[] | undefined>()
  const over = text.length > INGEST_TEXT_MAX_CHARS

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = ingestTextRequestSchema.safeParse({
      title,
      text,
      source: source.trim() ? source : undefined,
    })
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    ingest.mutate(parsed.data, {
      onSuccess: doc => {
        showToast(
          doc.status === 'indexed'
            ? `"${doc.title}" indexed (${doc.chunkCount} chunks)`
            : `"${doc.title}" queued for indexing`,
          'success'
        )
        setTitle('')
        setText('')
        setSource('')
      },
    })
  }

  return (
    <SectionPanel title="Add text" description="Paste text to make it searchable.">
      <form id="ingest-form" onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label htmlFor="doc-title" className="label text-sm font-medium">
            Title
          </label>
          <input
            id="doc-title"
            className="input input-sm w-full"
            value={title}
            maxLength={200}
            onChange={e => setTitle(e.target.value)}
            disabled={ingest.isPending}
            aria-invalid={fieldErrorFor(issues, 'title') ? true : undefined}
          />
          <FieldError message={fieldErrorFor(issues, 'title')} />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="doc-text" className="label text-sm font-medium">
              Text
            </label>
            <span
              className={`text-xs tabular-nums ${over ? 'text-error' : 'text-muted'}`}
              aria-live="polite"
            >
              {text.length.toLocaleString()} / {INGEST_TEXT_MAX_CHARS.toLocaleString()}
            </span>
          </div>
          <textarea
            id="doc-text"
            className={`textarea w-full text-sm leading-relaxed ${over ? 'textarea-error' : ''}`}
            rows={8}
            value={text}
            onChange={e => setText(e.target.value)}
            disabled={ingest.isPending}
            aria-invalid={over || fieldErrorFor(issues, 'text') ? true : undefined}
          />
          <FieldError message={fieldErrorFor(issues, 'text')} />
        </div>
        <div>
          <label htmlFor="doc-source" className="label text-sm font-medium">
            Source <span className="text-muted font-normal">(optional)</span>
          </label>
          <input
            id="doc-source"
            className="input input-sm w-full"
            placeholder="upload, a URL, a system name…"
            value={source}
            maxLength={200}
            onChange={e => setSource(e.target.value)}
            disabled={ingest.isPending}
          />
          <FieldError message={fieldErrorFor(issues, 'source')} />
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={ingest.isPending || over}
          >
            {ingest.isPending ? 'Adding…' : 'Add document'}
          </button>
        </div>
      </form>
    </SectionPanel>
  )
}

function SearchPanel() {
  const [params, setParams] = useSearchParams()
  const documentId = params.get('documentId') ?? ''
  const search = useSearch()
  const documents = useDocuments({ pageSize: 100 })
  const [query, setQuery] = useState('')
  const [issue, setIssue] = useState<string | undefined>()

  const setDocumentId = (id: string) => {
    const next = new URLSearchParams(params)
    if (id) next.set('documentId', id)
    else next.delete('documentId')
    setParams(next, { replace: true })
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = searchRequestSchema.safeParse({
      query,
      documentId: documentId || undefined,
    })
    if (!parsed.success) return setIssue(parsed.error.issues[0]?.message)
    setIssue(undefined)
    search.mutate(parsed.data)
  }

  const options = documents.data?.items ?? []
  const hits = search.data?.hits

  return (
    <SectionPanel title="Search" description="Hybrid search: meaning and keywords, fused.">
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div className="flex gap-2">
          <label htmlFor="search-query" className="sr-only">
            Search query
          </label>
          <input
            id="search-query"
            className="input input-sm flex-1"
            placeholder="What are you looking for?"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-invalid={issue ? true : undefined}
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm gap-1.5"
            disabled={search.isPending}
          >
            <MagnifyingGlassIcon className="w-4 h-4" />
            Search
          </button>
        </div>
        <FieldError message={issue} />
        <div>
          <label htmlFor="search-document" className="sr-only">
            Restrict to document
          </label>
          <select
            id="search-document"
            className="select select-xs w-full"
            value={documentId}
            onChange={e => setDocumentId(e.target.value)}
          >
            <option value="">All documents</option>
            {options.map(doc => (
              <option key={doc.id} value={doc.id}>
                {doc.title}
              </option>
            ))}
            {documentId && !options.some(d => d.id === documentId) && (
              <option value={documentId}>Document {documentId.slice(0, 8)}</option>
            )}
          </select>
        </div>
      </form>

      {hits && (
        <div className="mt-4" aria-live="polite">
          {hits.length === 0 ? (
            <p className="text-sm text-muted">No matches for “{search.data?.query}”.</p>
          ) : (
            <ol className="space-y-2" aria-label="Search results">
              {hits.map(hit => (
                <SearchHitRow key={hit.chunkId} hit={hit} onPickDocument={setDocumentId} />
              ))}
            </ol>
          )}
        </div>
      )}
    </SectionPanel>
  )
}

function SearchHitRow({
  hit,
  onPickDocument,
}: {
  hit: SearchHit
  onPickDocument: (documentId: string) => void
}) {
  return (
    <li className="surface-inset rounded-lg p-3 text-sm space-y-1" data-rank={hit.rank}>
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="font-semibold tabular-nums">#{hit.rank}</span>
        <button
          type="button"
          className="link link-primary font-medium truncate max-w-xs"
          title="Restrict the search to this document"
          onClick={() => onPickDocument(hit.documentId)}
        >
          {hit.title}
        </button>
        <span className="text-muted tabular-nums" title="Reciprocal-rank-fusion score">
          score {hit.score.toFixed(3)}
        </span>
        {hit.denseRank !== null && (
          <span className="badge badge-ghost badge-sm" title="Rank by meaning (vector)">
            dense #{hit.denseRank}
          </span>
        )}
        {hit.lexicalRank !== null && (
          <span className="badge badge-ghost badge-sm" title="Rank by keywords (full text)">
            lexical #{hit.lexicalRank}
          </span>
        )}
      </div>
      <p className="text-secondary whitespace-pre-wrap break-words line-clamp-4">{hit.text}</p>
    </li>
  )
}

function DocumentsTable() {
  const { user } = useAuth()
  const { can } = usePermissions()
  const canDeleteAny = can('delete', 'Document')
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<DocumentStatus | ''>('')
  const documents = useDocuments({ page, status })
  const remove = useDeleteDocument()
  const [deleting, setDeleting] = useState<Document | null>(null)
  const rows = documents.data?.items ?? []

  const canDelete = (doc: Document) => canDeleteAny || doc.ownerUserId === user?.id

  return (
    <SectionPanel
      flush
      title="Documents"
      actions={
        <>
          <label htmlFor="docs-status" className="sr-only">
            Status
          </label>
          <select
            id="docs-status"
            className="select select-xs"
            value={status}
            onChange={e => {
              setStatus(e.target.value as DocumentStatus | '')
              setPage(1)
            }}
          >
            <option value="">Any status</option>
            <option value="pending">Indexing</option>
            <option value="indexed">Indexed</option>
            <option value="failed">Failed</option>
          </select>
        </>
      }
    >
      {documents.isLoading ? (
        <div className="p-4">
          <SkeletonRows rows={3} />
        </div>
      ) : documents.isError ? (
        <p className="p-4 text-sm text-error" role="alert">
          Documents could not be loaded.
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={BookOpenIcon}
          size="sm"
          message="No documents yet"
          description="Add text above, or run the Summarize agent with “index” on."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table" aria-label="Documents">
            <thead>
              <tr>
                <th>Title</th>
                <th>Source</th>
                <th>Status</th>
                <th className="text-right">Chunks</th>
                <th>Created</th>
                <th className="text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(doc => (
                <tr key={doc.id}>
                  <td className="font-medium">{doc.title}</td>
                  <td className="text-secondary">{doc.source ?? '—'}</td>
                  <td>
                    <span
                      className="status-badge"
                      data-status={STATUS_TONE[doc.status]}
                      title={doc.status === 'failed' ? (doc.error ?? undefined) : undefined}
                    >
                      {STATUS_LABELS[doc.status]}
                    </span>
                  </td>
                  <td className="text-right tabular-nums text-secondary">{doc.chunkCount}</td>
                  <td className="whitespace-nowrap text-secondary">
                    {formatDateTime(doc.createdAt)}
                  </td>
                  <td className="text-right">
                    {canDelete(doc) && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs btn-square text-error"
                        aria-label={`Delete ${doc.title}`}
                        onClick={() => setDeleting(doc)}
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {documents.data && (
        <div className="px-5 pb-5">
          <PaginationControls
            pagination={documents.data.pagination}
            onPageChange={setPage}
            isLoading={documents.isFetching}
          />
        </div>
      )}

      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete document"
        message={`Delete "${deleting?.title ?? ''}"? Its chunks leave the search index for good.`}
        confirmText="Delete"
        confirmButtonClass="btn-error"
        isLoading={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })
        }}
      />
    </SectionPanel>
  )
}

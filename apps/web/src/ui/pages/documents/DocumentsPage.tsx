/**
 * `/documents` (D18, D20): the tenant knowledge base. Two URL tabs (`?tab=text|file`, `URLTabs` like
 * Settings) below the list — paste text (title, text counted against `INGEST_TEXT_MAX_CHARS`, optional source) →
 * `POST /api/ai/documents/ingest`, or upload a file (type/size checked client-side with the shared
 * allowlist, optional title and source) → `POST /upload` as multipart — either answers 201,
 * `indexed` at once for small texts or `pending` until the queue lands (conversion + indexing for
 * PDF/Office/HTML) — the list polls while any row is pending. The paginated documents table comes
 * FIRST (title with its type, source, status with the failure reason on hover, chunks, created, a
 * download link for uploaded originals, delete after confirm — own rows for everyone, any row for
 * `delete Document`), the add tabs below it. Hybrid search is its own page, `/search`.
 */

import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  BookOpenIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import {
  DOCUMENT_UPLOAD_ACCEPT,
  type Document,
  type DocumentStatus,
  documentTypeLabel,
  INGEST_TEXT_MAX_CHARS,
  ingestTextRequestSchema,
  uploadDocumentFieldsSchema,
} from '@rocketflare/shared/ai/embeddings'
import { filePath, MAX_UPLOAD_BYTES } from '@rocketflare/shared/files'
import { type FormEvent, useRef, useState } from 'react'
import {
  ConfirmModal,
  EmptyState,
  FieldError,
  fieldErrorFor,
  PageHeader,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
  type TabConfig,
  URLTabs,
} from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import {
  useDeleteDocument,
  useDocuments,
  useIngestText,
  useUploadDocument,
  validateDocumentUpload,
} from '@/ui/hooks/useDocuments'
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
  const tabs: TabConfig[] = [
    {
      id: 'text',
      label: 'Paste text',
      icon: <PencilSquareIcon className="w-4 h-4" />,
      content: (
        <SectionPanel title="Paste text" description="Paste text to make it searchable.">
          <IngestForm />
        </SectionPanel>
      ),
    },
    {
      id: 'file',
      label: 'Upload file',
      icon: <ArrowUpTrayIcon className="w-4 h-4" />,
      content: (
        <SectionPanel
          title="Upload a document"
          description="PDF, Office, HTML, Markdown and text files are converted and indexed."
        >
          <UploadForm />
        </SectionPanel>
      ),
    },
  ]
  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Knowledge"
        description="Documents this workspace can search. Anything indexed here is searchable on the Search page and available to every agent through the search_knowledge and get_document tools."
      />
      <div className="mb-6">
        <DocumentsTable />
      </div>
      <URLTabs tabs={tabs} defaultTab="text" />
    </div>
  )
}

function IngestForm() {
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
  )
}

const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))

/**
 * Upload a document (D18). The file is checked against the shared allowlist/limit before any
 * request; the server's 415/413 remain the backstop. Text types come back `indexed`; PDF/Office/
 * HTML come back `pending` and the table polls until the `document.convert` job lands.
 */
function UploadForm() {
  const upload = useUploadDocument()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [issues, setIssues] = useState<Issue[] | undefined>()

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!picked) return
    const message = validateDocumentUpload(picked)
    setProblem(message)
    setFile(message ? null : picked)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!file) return setProblem('Choose a file first')
    const parsed = uploadDocumentFieldsSchema.safeParse({
      title: title.trim() ? title : undefined,
      source: source.trim() ? source : undefined,
    })
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    upload.mutate(
      { file, ...parsed.data },
      {
        onSuccess: doc => {
          showToast(
            doc.status === 'indexed'
              ? `"${doc.title}" indexed (${doc.chunkCount} chunks)`
              : doc.status === 'failed'
                ? `"${doc.title}" could not be indexed`
                : `"${doc.title}" queued for conversion and indexing`,
            doc.status === 'failed' ? 'error' : 'success'
          )
          setFile(null)
          setTitle('')
          setSource('')
        },
      }
    )
  }

  return (
    <form id="upload-form" onSubmit={submit} className="space-y-3" noValidate>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            id="doc-file"
            type="file"
            accept={DOCUMENT_UPLOAD_ACCEPT}
            className="hidden"
            aria-label="Upload document"
            onChange={onPick}
            disabled={upload.isPending}
          />
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={upload.isPending}
            onClick={() => inputRef.current?.click()}
          >
            Choose file
          </button>
          <span className="text-sm truncate max-w-xs" aria-live="polite">
            {file ? file.name : <span className="text-muted">No file chosen</span>}
          </span>
        </div>
        <p className="text-xs text-muted mt-1">
          PDF, Word, Excel, OpenDocument, HTML, XML, CSV, JSON, Markdown or text, up to{' '}
          {MAX_UPLOAD_MB} MB.
        </p>
        <FieldError message={problem ?? undefined} />
      </div>
      <div>
        <label htmlFor="upload-title" className="label text-sm font-medium">
          Title{' '}
          <span className="text-muted font-normal">(optional — defaults to the filename)</span>
        </label>
        <input
          id="upload-title"
          className="input input-sm w-full"
          value={title}
          maxLength={200}
          onChange={e => setTitle(e.target.value)}
          disabled={upload.isPending}
          aria-invalid={fieldErrorFor(issues, 'title') ? true : undefined}
        />
        <FieldError message={fieldErrorFor(issues, 'title')} />
      </div>
      <div>
        <label htmlFor="upload-source" className="label text-sm font-medium">
          Source <span className="text-muted font-normal">(optional)</span>
        </label>
        <input
          id="upload-source"
          className="input input-sm w-full"
          placeholder="a URL, a system name…"
          value={source}
          maxLength={200}
          onChange={e => setSource(e.target.value)}
          disabled={upload.isPending}
        />
        <FieldError message={fieldErrorFor(issues, 'source')} />
      </div>
      <div className="flex justify-end">
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={upload.isPending || !file}
        >
          {upload.isPending ? 'Uploading…' : 'Upload document'}
        </button>
      </div>
    </form>
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
          description="Paste text or upload a file above, or run the Summarize agent with “index” on."
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
                  <td>
                    <div className="font-medium">{doc.title}</div>
                    <div className="text-xs text-muted">{documentTypeLabel(doc.contentType)}</div>
                  </td>
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
                  <td className="text-right whitespace-nowrap">
                    {doc.fileId && (
                      <a
                        className="btn btn-ghost btn-xs btn-square"
                        href={filePath(doc.fileId)}
                        download
                        aria-label={`Download ${doc.title}`}
                        title="Download the original file"
                      >
                        <ArrowDownTrayIcon className="w-4 h-4" />
                      </a>
                    )}
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

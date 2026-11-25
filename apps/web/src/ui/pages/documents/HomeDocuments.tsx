/**
 * Home's knowledge area (feature-knowledge's section in `pages/home-sections.ts`): the newest
 * documents with where each one is — still indexing, failed, or indexed with its passages and the
 * facts read from it. With no documents yet the area is a drop zone over the same upload the
 * Knowledge page uses, so the first document goes in from Home.
 */
import { ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import { DOCUMENT_UPLOAD_ACCEPT, documentPath } from '@rocketflare/shared/ai/embeddings'
import type { HomeDocument } from '@rocketflare/shared/home'
import { useQueryClient } from '@tanstack/react-query'
import { type DragEvent, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { FieldError, SectionPanel, SectionPanelSkeleton } from '@/ui/components/shared'
import { useUploadDocument, validateDocumentUpload } from '@/ui/hooks/useDocuments'
import { useHomeSummary } from '@/ui/hooks/useHome'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { timeAgoShort } from '@/ui/lib/format'
import { queryKeys } from '@/ui/lib/query-keys'

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Where a document is, in words: "12 passages · 4 facts", "Indexing…", "Could not be indexed". */
export function documentState(doc: HomeDocument): string {
  if (doc.status === 'pending') return 'Indexing…'
  if (doc.status === 'failed') return 'Could not be indexed'
  const parts = [count(doc.chunkCount, 'passage')]
  if (doc.factCount !== null) parts.push(count(doc.factCount, 'fact'))
  return parts.join(' · ')
}

export default function HomeDocuments() {
  const { data, isLoading } = useHomeSummary()
  const { can } = usePermissions()
  if (isLoading) return <SectionPanelSkeleton rows={4} />
  const knowledge = data?.knowledge
  if (!knowledge) return null
  const canUpload = can('create', 'Document')

  if (knowledge.total === 0) {
    return (
      <SectionPanel title="Knowledge">
        {canUpload ? (
          <DropZone />
        ) : (
          <p className="text-sm text-secondary">
            No documents yet. Once someone adds one, chat and agents can answer from it.
          </p>
        )}
      </SectionPanel>
    )
  }

  const description = [
    count(knowledge.total, 'document'),
    knowledge.pending > 0 ? `${knowledge.pending} indexing` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <SectionPanel
      title="Knowledge"
      description={description}
      actions={
        <Link to="/documents" className="btn btn-ghost btn-xs">
          All documents
        </Link>
      }
    >
      <ul className="divide-y divide-[color:var(--border-subtle)] -my-2">
        {knowledge.recent.map(doc => (
          <li key={doc.id}>
            <Link
              to={documentPath(doc.id)}
              className="flex items-start gap-3 py-2.5 -mx-2 px-2 rounded-[var(--radius-control)] hover:bg-[color:var(--surface-hover)]"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium truncate">{doc.title}</span>
                <span
                  className={`block text-xs ${doc.status === 'failed' ? 'text-error' : 'text-muted'}`}
                >
                  {documentState(doc)}
                </span>
              </span>
              <span className="text-xs text-muted whitespace-nowrap pt-0.5">
                {timeAgoShort(doc.createdAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </SectionPanel>
  )
}

/** Drop a file (or choose one): checked here first, then the Knowledge page's own upload. */
export function DropZone() {
  const upload = useUploadDocument()
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const hintId = useId()

  const send = (file: File | null | undefined) => {
    if (!file) return
    const message = validateDocumentUpload(file)
    setProblem(message)
    if (message) return
    upload.mutate(
      { file },
      { onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.home.all }) }
    )
  }
  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    setOver(false)
    send(e.dataTransfer.files?.[0])
  }

  return (
    <div>
      <button
        type="button"
        className={`w-full rounded-[var(--radius-panel)] border border-dashed px-6 py-8 text-center transition-colors ${
          over
            ? 'border-[color:var(--color-primary)] bg-[color:var(--surface-active)]'
            : 'border-[color:var(--border-control)] hover:bg-[color:var(--surface-hover)]'
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        disabled={upload.isPending}
        aria-describedby={hintId}
      >
        <ArrowUpTrayIcon className="w-6 h-6 mx-auto text-muted" />
        <span className="block mt-2 text-sm font-medium">
          {upload.isPending ? (
            'Uploading…'
          ) : (
            <>
              {/* Nobody drags a file on a phone or a touch screen: there it is only a picker. */}
              <span className="max-sm:hidden pointer-coarse:hidden">
                Drop a document here, or choose one
              </span>
              <span className="hidden max-sm:inline pointer-coarse:inline">Choose a document</span>
            </>
          )}
        </span>
        <span id={hintId} className="block mt-1 text-xs text-muted">
          PDF, Word, text or Markdown. Chat and agents answer from what you add.
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={DOCUMENT_UPLOAD_ACCEPT}
        className="hidden"
        aria-label="Upload document"
        onChange={e => {
          send(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <FieldError message={problem} />
    </div>
  )
}

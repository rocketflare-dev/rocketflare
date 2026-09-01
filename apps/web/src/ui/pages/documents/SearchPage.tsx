/**
 * `/search` (D18, D20): hybrid search over the tenant knowledge base — `POST /api/ai/documents/search`
 * with `{ query, limit, documentId? }`, rendering hits with rank, where the passage sits in its
 * document (`seq`/`documentPassages`), fused score, dense/lexical rank
 * badges, snippet and the document title, optionally restricted to one document (`?documentId=`
 * preselects it — the run drawer and the Knowledge table link here). Hits are the search
 * mutation's data, never cached as server state. Adding documents lives on `/documents`.
 */
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { type SearchHit, searchRequestSchema } from '@rocketflare/shared/ai/embeddings'
import { type FormEvent, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState, FieldError, PageHeader, SectionPanel } from '@/ui/components/shared'
import { useDocuments, useSearch } from '@/ui/hooks/useDocuments'

export default function SearchPage() {
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
    <div className="max-w-4xl">
      <PageHeader
        title="Search"
        description="Ask the knowledge base a question — meaning and keywords, fused."
      />
      <SectionPanel title="Query">
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="flex gap-2">
            <label htmlFor="search-query" className="sr-only">
              Search query
            </label>
            <input
              id="search-query"
              className="input flex-1"
              placeholder="What are you looking for?"
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-invalid={issue ? true : undefined}
            />
            <button type="submit" className="btn btn-primary gap-1.5" disabled={search.isPending}>
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
              className="select select-sm w-full"
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
      </SectionPanel>

      <div className="mt-4" aria-live="polite">
        {!hits ? (
          documents.data && options.length === 0 ? (
            <EmptyState
              icon={MagnifyingGlassIcon}
              size="sm"
              message="Nothing to search yet"
              description="Add a document first, then ask it questions here."
              action={
                <Link to="/documents" className="btn btn-primary btn-sm">
                  Knowledge
                </Link>
              }
            />
          ) : null
        ) : hits.length === 0 ? (
          <p className="text-sm text-muted">No matches for “{search.data?.query}”.</p>
        ) : (
          <ol className="space-y-2" aria-label="Search results">
            {hits.map(hit => (
              <SearchHitRow key={hit.chunkId} hit={hit} onPickDocument={setDocumentId} />
            ))}
          </ol>
        )}
      </div>
    </div>
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
        <span className="text-muted tabular-nums" title="Where this passage sits in the document">
          passage {hit.seq + 1} of {hit.documentPassages}
        </span>
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

/**
 * `/search` (D18, D20): hybrid search over the tenant knowledge base — `POST /api/ai/documents/search`
 * with `{ query, limit, documentId? }`, rendering hits with rank, where the passage sits in its
 * document (`seq`/`documentPassages`), fused score, dense/lexical rank
 * badges and snippet, GROUPED under a `DocumentCard` header built client-side from the documents
 * list this page already fetches for its filter select (no request per hit). A hit's "passage n of
 * m" is a deep link into the viewer at that passage; restricting the search to one document is now
 * a separate funnel button on the card, so "read it" and "search only it" are no longer the same
 * click. Optionally restricted to one document (`?documentId=`
 * preselects it — the run drawer and the Knowledge table link here). `?q=` prefills the box and
 * runs the search on mount, and every submitted search is written back to the URL (replace, not
 * push) so a result page can be shared or reloaded. Hits are the search mutation's data, never
 * cached as server state. Adding documents lives on `/documents`.
 */
import { FunnelIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import {
  type Document,
  type DocumentCard as DocumentCardData,
  documentCardFromDocument,
  documentPath,
  type SearchHit,
  searchRequestSchema,
} from '@rocketflare/shared/ai/embeddings'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  DocumentCard,
  EmptyState,
  FieldError,
  PageHeader,
  SectionPanel,
} from '@/ui/components/shared'
import { useDocuments, useSearch } from '@/ui/hooks/useDocuments'

export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const documentId = params.get('documentId') ?? ''
  const urlQuery = params.get('q') ?? ''
  const search = useSearch()
  const { mutate: runSearch } = search
  const documents = useDocuments({ pageSize: 100 })
  const [query, setQuery] = useState(urlQuery)
  const [issue, setIssue] = useState<string | undefined>()
  // The last `?q=` this page ran, so a submit that writes the URL (or StrictMode's double effect)
  // never fires the same search twice.
  const lastRun = useRef<string | null>(null)

  const setDocumentId = (id: string) => {
    const next = new URLSearchParams(params)
    if (id) next.set('documentId', id)
    else next.delete('documentId')
    setParams(next, { replace: true })
  }

  // `?q=` on arrival (a shared link, a reload): fill the box and search straight away.
  useEffect(() => {
    if (!urlQuery.trim() || lastRun.current === urlQuery) return
    const parsed = searchRequestSchema.safeParse({
      query: urlQuery,
      documentId: documentId || undefined,
    })
    if (!parsed.success) return
    lastRun.current = urlQuery
    setQuery(urlQuery)
    runSearch(parsed.data)
  }, [urlQuery, documentId, runSearch])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = searchRequestSchema.safeParse({
      query,
      documentId: documentId || undefined,
    })
    if (!parsed.success) return setIssue(parsed.error.issues[0]?.message)
    setIssue(undefined)
    lastRun.current = parsed.data.query
    runSearch(parsed.data)
    const next = new URLSearchParams(params)
    next.set('q', parsed.data.query)
    setParams(next, { replace: true })
  }

  const options = documents.data?.items ?? []
  const hits = search.data?.hits
  const onPickDocument = setDocumentId

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
          <section className="space-y-4" aria-label="Search results">
            {groupHits(hits).map(group => (
              <section key={group.documentId} className="space-y-2">
                <DocumentCard
                  dense
                  card={cardFor(group, options)}
                  to={documentPath(group.documentId, { q: search.data?.query })}
                  footer={
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs gap-1.5"
                      title="Restrict the search to this document"
                      onClick={() => onPickDocument(group.documentId)}
                    >
                      <FunnelIcon className="w-4 h-4" />
                      Only this document
                    </button>
                  }
                />
                <ol className="space-y-2 pl-3">
                  {group.hits.map(hit => (
                    <SearchHitRow key={hit.chunkId} hit={hit} query={search.data?.query} />
                  ))}
                </ol>
              </section>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}

interface HitGroup {
  documentId: string
  title: string
  documentPassages: number
  hits: SearchHit[]
}

/** Hits in fused order, grouped under the document they came from (first appearance wins). */
export function groupHits(hits: SearchHit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>()
  for (const hit of hits) {
    const group = groups.get(hit.documentId) ?? {
      documentId: hit.documentId,
      title: hit.title,
      documentPassages: hit.documentPassages,
      hits: [],
    }
    group.hits.push(hit)
    groups.set(hit.documentId, group)
  }
  return [...groups.values()]
}

/**
 * The card for a group, built CLIENT-SIDE from the documents list this page already fetches for
 * its filter select — no request per hit. A document outside that page (the list is capped at 100)
 * degrades to what the hit itself carries, which is enough to render and to link.
 */
function cardFor(group: HitGroup, documents: Document[]): DocumentCardData {
  const doc = documents.find(d => d.id === group.documentId)
  if (doc) return documentCardFromDocument(doc)
  return {
    id: group.documentId,
    title: group.title,
    typeLabel: 'Text',
    contentType: 'text/plain',
    status: 'indexed',
    excerpt: null,
    passages: group.documentPassages,
    sizeBytes: 0,
    fileId: null,
    href: documentPath(group.documentId),
  }
}

function SearchHitRow({ hit, query }: { hit: SearchHit; query?: string }) {
  return (
    <li className="surface-inset rounded-lg p-3 text-sm space-y-1" data-rank={hit.rank}>
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="font-semibold tabular-nums">#{hit.rank}</span>
        {/*
          The passage deep link: `offset` is where it starts in the text, `chunk` the fallback when
          that could not be resolved (a re-chunked document), `q` so the viewer highlights it.
        */}
        <Link
          to={documentPath(hit.documentId, {
            offset: hit.charOffset,
            chunk: hit.chunkId,
            q: query,
          })}
          className="link link-primary font-medium tabular-nums"
          title="Open this passage in the document"
        >
          passage {hit.seq + 1} of {hit.documentPassages}
        </Link>
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

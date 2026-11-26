/**
 * `/search`: hybrid search over the tenant knowledge base — `POST /api/ai/documents/search` with
 * `{ query, limit, documentId?, filters? }`. The page is the kit's list layout (`max-w-6xl`): the
 * query box across the top, a filter column on the left (below `lg`, folded behind a "Filters"
 * button above the results) and the results beside it.
 *
 * **The URL is the state.** `?q=` is the query, `?documentId=` one document, `?source=` / `?type=`
 * (repeatable) the documents' source and content type, `?from=` / `?to=` the date added (UTC days,
 * inclusive). Whatever the URL says is run — on arrival, on a submit, on any filter change — once
 * per distinct request (`lastRun` stops StrictMode and the URL write repeating it). Every write is
 * `replace`, so a result page can be shared or reloaded without filling the history.
 *
 * The filters offer what `GET /facets` says the reader can see; a value in the URL that is not
 * (any more) among them is still listed, checked, so it can be cleared. Hits are GROUPED under a
 * `DocumentCard` built client-side from the documents list the page already fetches for its
 * document select (no request per hit), with the document's source and date under it. With
 * `KNOWLEDGE_FACTS_GUARD` the facts about the entities the query names sit above the results
 * (`GET /api/knowledge/mentioned`). Hits are the search mutation's data, never cached as server
 * state; a failed search toasts (the mutation's default) and leaves a neutral "try again". A
 * search the server reports as `lexical: 'no_terms'` (only stopwords) that found nothing says the
 * word is too common. When `/facets` counts visible documents embedded by another model, a notice
 * says meaning-based search cannot find them yet, with "Re-index now" for `manage Document`; when
 * it counts documents with no contextual prefix yet (`knowledge-context` flag), a reader who may
 * `manage Document` gets "Add context" (the backfill) — nobody else is shown it, since search works.
 */
import {
  ArrowPathIcon,
  CubeIcon,
  FunnelIcon,
  InformationCircleIcon,
  MagnifyingGlassIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline'
import {
  type Document,
  type DocumentCard as DocumentCardData,
  type DocumentFacetValue,
  documentCardFromDocument,
  documentPath,
  documentSourceLabel,
  documentTypeLabel,
  type SearchHit,
  type SearchRequest,
  searchRequestSchema,
} from '@rocketflare/shared/ai/embeddings'
import { entityCardsFromFactGroups } from '@rocketflare/shared/ai/knowledge-facts'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { EntityFactsCard } from '@/ui/components/knowledge/EntityFactsCard'
import {
  DocumentCard,
  EmptyState,
  FieldError,
  PageHeader,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import {
  useContextualizeDocuments,
  useDocumentFacets,
  useDocuments,
  useReembedDocuments,
  useSearch,
} from '@/ui/hooks/useDocuments'
import { useMentionedFacts } from '@/ui/hooks/useKnowledge'
import { useNavGuard } from '@/ui/hooks/useNavGuard'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { KNOWLEDGE_FACTS_GUARD } from '@/ui/lib/feature-guards'
import { formatDate } from '@/ui/lib/format'
import { highlightMatches, stripMarkdown } from '@/ui/lib/highlight'

/** The URL parameters this page owns besides `q`. */
const FILTER_PARAMS = ['documentId', 'source', 'type', 'from', 'to'] as const

/** What the URL asks for, before validation. */
export interface SearchUrlState {
  query: string
  documentId: string
  sources: string[]
  contentTypes: string[]
  from: string
  to: string
}

export function searchStateFromParams(params: URLSearchParams): SearchUrlState {
  return {
    query: params.get('q') ?? '',
    documentId: params.get('documentId') ?? '',
    sources: params.getAll('source').filter(Boolean),
    contentTypes: params.getAll('type').filter(Boolean),
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  }
}

/** The request body the URL state means — absent parts omitted, so a plain search stays plain. */
export function searchRequestInput(state: SearchUrlState, query = state.query) {
  const filters = {
    ...(state.sources.length ? { sources: state.sources } : {}),
    ...(state.contentTypes.length ? { contentTypes: state.contentTypes } : {}),
    ...(state.from ? { createdFrom: state.from } : {}),
    ...(state.to ? { createdTo: state.to } : {}),
  }
  return {
    query,
    ...(state.documentId ? { documentId: state.documentId } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
  }
}

/** How many filters are set (the document counts as one). */
export function activeFilterCount(state: SearchUrlState): number {
  return (
    (state.documentId ? 1 : 0) +
    state.sources.length +
    state.contentTypes.length +
    (state.from ? 1 : 0) +
    (state.to ? 1 : 0)
  )
}

export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const state = searchStateFromParams(params)
  const search = useSearch()
  const { mutate: runSearch } = search
  const documents = useDocuments({ pageSize: 100 })
  // Set once this reader starts a re-index; the facets poll until nothing is stale.
  const [reindexing, setReindexing] = useState(false)
  // Set once this reader starts the context backfill; the facets poll until every document has one.
  const [contextualizing, setContextualizing] = useState(false)
  const facets = useDocumentFacets({ reindexing, contextualizing })
  const canAccess = useNavGuard()
  const [query, setQuery] = useState(state.query)
  const [issue, setIssue] = useState<string | undefined>()
  // The last request this page ran (serialised), so the URL write a submit makes — or StrictMode's
  // double effect — never fires the same search twice.
  const lastRun = useRef<string | null>(null)

  const parsedUrl = state.query.trim()
    ? searchRequestSchema.safeParse(searchRequestInput(state))
    : null
  const request: SearchRequest | null = parsedUrl?.success ? parsedUrl.data : null
  const requestKey = request ? JSON.stringify(request) : null
  const filterIssue =
    parsedUrl && !parsedUrl.success
      ? parsedUrl.error.issues.find(i => i.path[0] !== 'query')?.message
      : undefined

  // Whatever the URL asks for (a shared link, a reload, a submit, a filter change), run it once.
  // `request` is rebuilt every render; `requestKey` is what identifies it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on requestKey, not identity
  useEffect(() => {
    if (!request || !requestKey || lastRun.current === requestKey) return
    lastRun.current = requestKey
    setQuery(request.query)
    runSearch(request)
  }, [requestKey, runSearch])

  const update = (edit: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params)
    edit(next)
    setParams(next, { replace: true })
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = searchRequestSchema.safeParse(searchRequestInput(state, query))
    const queryIssue = parsed.success
      ? undefined
      : parsed.error.issues.find(i => i.path[0] === 'query')?.message
    if (queryIssue) return setIssue(queryIssue)
    setIssue(undefined)
    if (!parsed.success) return
    // The same request again (a deliberate re-run) changes no URL, so run it here.
    if (JSON.stringify(parsed.data) === lastRun.current) runSearch(parsed.data)
    update(next => next.set('q', parsed.data.query))
  }

  const clearFilters = () =>
    update(next => {
      for (const name of FILTER_PARAMS) next.delete(name)
    })

  const options = documents.data?.items ?? []
  const filtersSet = activeFilterCount(state)
  const factsOn = canAccess(KNOWLEDGE_FACTS_GUARD)
  const emptyBase = documents.data !== undefined && options.length === 0 && !filtersSet

  return (
    <div className="max-w-6xl">
      <PageHeader title="Search" description="Ask the knowledge base a question." />
      <form onSubmit={submit} className="surface-panel mb-4" role="search" noValidate>
        <div className="flex gap-2">
          <label className="input flex-1 min-w-0">
            <MagnifyingGlassIcon className="w-4 h-4 text-muted" aria-hidden="true" />
            <span className="sr-only">Search query</span>
            <input
              type="search"
              className="grow min-w-0"
              placeholder="What are you looking for?"
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-invalid={issue ? true : undefined}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={search.isPending}>
            Search
          </button>
        </div>
        <FieldError message={issue} />
      </form>

      <StaleEmbeddingsNotice
        stale={facets.data?.staleEmbeddings ?? 0}
        reindexing={reindexing}
        onStarted={enqueued => setReindexing(enqueued)}
      />
      <ContextBackfillNotice
        missing={facets.data?.withoutContext ?? 0}
        contextualizing={contextualizing}
        onStarted={() => setContextualizing(true)}
      />

      {emptyBase ? (
        <EmptyState
          icon={MagnifyingGlassIcon}
          message="Nothing to search yet"
          description="Add a document first, then ask it questions here."
          action={
            <Link to="/documents" className="btn btn-primary btn-sm">
              Knowledge
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-4 items-start">
          <SearchFilters
            state={state}
            documents={options}
            sources={facets.data?.sources ?? []}
            contentTypes={facets.data?.contentTypes ?? []}
            activeCount={filtersSet}
            issue={filterIssue}
            update={update}
            onClear={clearFilters}
          />
          <div className="min-w-0 space-y-4" aria-live="polite">
            {factsOn && search.data && <MentionedFacts query={search.data.query} />}
            <SearchResults
              search={search}
              documents={options}
              filtersSet={filtersSet}
              onClearFilters={clearFilters}
              onRetry={() => request && runSearch(request)}
              onPickDocument={id => update(next => next.set('documentId', id))}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Filters ---------------------------------------------------------------------------------

interface FilterOption {
  key: string
  label: string
  /** The URL values this option stands for (one label may cover several media types). */
  values: string[]
  /** Documents carrying it; null for a value only the URL names. */
  count: number | null
}

/** One option per source the reader can see, plus any the URL holds that the facets do not list. */
export function sourceOptions(facets: DocumentFacetValue[], selected: string[]): FilterOption[] {
  const out: FilterOption[] = facets.map(f => ({
    key: f.value,
    label: documentSourceLabel(f.value),
    values: [f.value],
    count: f.count,
  }))
  for (const value of selected)
    if (!facets.some(f => f.value === value))
      out.push({ key: value, label: documentSourceLabel(value), values: [value], count: null })
  return out
}

/** Media types grouped under the label a person reads ("Excel" is two of them). */
export function typeOptions(facets: DocumentFacetValue[], selected: string[]): FilterOption[] {
  const byLabel = new Map<string, FilterOption>()
  const add = (value: string, count: number | null) => {
    const label = documentTypeLabel(value)
    const option = byLabel.get(label) ?? { key: label, label, values: [], count: null }
    if (!option.values.includes(value)) option.values.push(value)
    if (count !== null) option.count = (option.count ?? 0) + count
    byLabel.set(label, option)
  }
  for (const f of facets) add(f.value, f.count)
  for (const value of selected) if (!facets.some(f => f.value === value)) add(value, null)
  return [...byLabel.values()]
}

interface SearchFiltersProps {
  state: SearchUrlState
  documents: Document[]
  sources: DocumentFacetValue[]
  contentTypes: DocumentFacetValue[]
  activeCount: number
  issue?: string
  update: (edit: (next: URLSearchParams) => void) => void
  onClear: () => void
}

const LEGEND = 'text-sm font-semibold text-secondary mb-1.5'

function SearchFilters({
  state,
  documents,
  sources,
  contentTypes,
  activeCount,
  issue,
  update,
  onClear,
}: SearchFiltersProps) {
  // Below `lg` the column stacks above the results, so it starts folded behind one button.
  const [open, setOpen] = useState(false)
  const toggle = (name: 'source' | 'type', option: FilterOption, on: boolean) =>
    update(next => {
      const kept = next.getAll(name).filter(v => !option.values.includes(v))
      next.delete(name)
      for (const v of on ? [...kept, ...option.values] : kept) next.append(name, v)
    })
  const setOne = (name: 'documentId' | 'from' | 'to', value: string) =>
    update(next => {
      if (value) next.set(name, value)
      else next.delete(name)
    })

  return (
    <aside aria-label="Search filters">
      <button
        type="button"
        className="btn btn-sm w-full gap-1.5 lg:hidden"
        aria-expanded={open}
        aria-controls="search-filters-panel"
        onClick={() => setOpen(o => !o)}
      >
        <FunnelIcon className="w-4 h-4" aria-hidden="true" />
        {open ? 'Hide filters' : 'Filters'}
        {activeCount > 0 && <span className="badge badge-primary badge-sm">{activeCount}</span>}
      </button>
      <div id="search-filters-panel" className={open ? 'mt-3 lg:mt-0' : 'hidden lg:block'}>
        <SectionPanel
          title={
            <span className="inline-flex items-center gap-1.5">
              <FunnelIcon className="w-4 h-4 text-muted" aria-hidden="true" />
              Filters
            </span>
          }
          actions={
            activeCount > 0 ? (
              <button type="button" className="btn btn-ghost btn-xs" onClick={onClear}>
                Clear all
              </button>
            ) : undefined
          }
        >
          <div className="space-y-5">
            <fieldset>
              <legend className={LEGEND}>Document</legend>
              <label htmlFor="search-document" className="sr-only">
                Restrict to document
              </label>
              <select
                id="search-document"
                className="select select-sm w-full"
                value={state.documentId}
                onChange={e => setOne('documentId', e.target.value)}
              >
                <option value="">All documents</option>
                {documents.map(doc => (
                  <option key={doc.id} value={doc.id}>
                    {doc.title}
                  </option>
                ))}
                {state.documentId && !documents.some(d => d.id === state.documentId) && (
                  <option value={state.documentId}>Document {state.documentId.slice(0, 8)}</option>
                )}
              </select>
            </fieldset>

            <CheckboxGroup
              legend="Source"
              options={sourceOptions(sources, state.sources)}
              selected={state.sources}
              onToggle={(option, on) => toggle('source', option, on)}
            />
            <CheckboxGroup
              legend="Type"
              options={typeOptions(contentTypes, state.contentTypes)}
              selected={state.contentTypes}
              onToggle={(option, on) => toggle('type', option, on)}
            />

            <fieldset className="space-y-2">
              <legend className={LEGEND}>Date added</legend>
              <label className="flex items-center gap-2 text-sm">
                <span className="w-10 text-secondary">From</span>
                <input
                  type="date"
                  className="input input-sm flex-1 min-w-0"
                  value={state.from}
                  max={state.to || undefined}
                  onChange={e => setOne('from', e.target.value)}
                  aria-label="Added from"
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <span className="w-10 text-secondary">To</span>
                <input
                  type="date"
                  className="input input-sm flex-1 min-w-0"
                  value={state.to}
                  min={state.from || undefined}
                  onChange={e => setOne('to', e.target.value)}
                  aria-label="Added to"
                />
              </label>
              <FieldError message={issue} />
            </fieldset>
          </div>
        </SectionPanel>
      </div>
    </aside>
  )
}

function CheckboxGroup({
  legend,
  options,
  selected,
  onToggle,
}: {
  legend: string
  options: FilterOption[]
  selected: string[]
  onToggle: (option: FilterOption, on: boolean) => void
}) {
  if (options.length === 0) return null
  return (
    <fieldset className="space-y-1">
      <legend className={LEGEND}>{legend}</legend>
      {options.map(option => (
        <label
          key={option.key}
          className="flex items-center gap-2 text-sm cursor-pointer min-w-0"
          title={option.values.join(', ')}
        >
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={option.values.every(v => selected.includes(v))}
            onChange={e => onToggle(option, e.target.checked)}
          />
          <span className="truncate flex-1">{option.label}</span>
          {option.count !== null && (
            <span className="text-xs text-muted tabular-nums">{option.count}</span>
          )}
        </label>
      ))}
    </fieldset>
  )
}

// ---- Results ---------------------------------------------------------------------------------

function SearchResults({
  search,
  documents,
  filtersSet,
  onClearFilters,
  onRetry,
  onPickDocument,
}: {
  search: ReturnType<typeof useSearch>
  documents: Document[]
  filtersSet: number
  onClearFilters: () => void
  onRetry: () => void
  onPickDocument: (id: string) => void
}) {
  if (search.isPending)
    return (
      <SectionPanel>
        <SkeletonRows rows={5} />
      </SectionPanel>
    )
  // The error itself is the mutation's toast; here, only the way back.
  if (search.isError)
    return (
      <SectionPanel>
        <EmptyState
          icon={MagnifyingGlassIcon}
          size="sm"
          message="The search did not finish"
          action={
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Try again
            </button>
          }
        />
      </SectionPanel>
    )
  const data = search.data
  if (!data)
    return (
      <SectionPanel>
        <EmptyState
          icon={MagnifyingGlassIcon}
          size="sm"
          message="Search the knowledge base"
          description="Ask a question or type a few keywords. Narrow by document, source, type or date added."
        />
      </SectionPanel>
    )
  if (data.hits.length === 0)
    return (
      <SectionPanel>
        <EmptyState
          icon={MagnifyingGlassIcon}
          size="sm"
          message={`No matches for “${data.query}”`}
          description={
            data.lexical === 'no_terms'
              ? tooCommonMessage(data.query)
              : filtersSet > 0
                ? 'The filters may be hiding them.'
                : 'Try other words — search matches meaning as well as keywords.'
          }
          action={
            filtersSet > 0 ? (
              <button type="button" className="btn btn-sm" onClick={onClearFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      </SectionPanel>
    )

  const groups = groupHits(data.hits)
  return (
    <section className="space-y-3" aria-label="Search results">
      <p className="text-sm text-secondary">
        {data.hits.length} {data.hits.length === 1 ? 'passage' : 'passages'} from {groups.length}{' '}
        {groups.length === 1 ? 'document' : 'documents'} for “{data.query}”
      </p>
      {groups.map(group => {
        const doc = documents.find(d => d.id === group.documentId)
        const card = cardFor(group, doc)
        return (
          // One panel per document: the document, then its passages set into it as insets —
          // never a card above a stack of loose boxes.
          <DocumentCard
            key={group.documentId}
            dense
            card={card}
            to={documentPath(group.documentId, { q: data.query })}
            footer={
              <>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {doc?.source && <span>{documentSourceLabel(doc.source)}</span>}
                  {doc && <span>Added {formatDate(doc.createdAt)}</span>}
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs gap-1 ml-auto"
                    title="Restrict the search to this document"
                    onClick={() => onPickDocument(group.documentId)}
                  >
                    <FunnelIcon className="w-3.5 h-3.5" />
                    Only this document
                  </button>
                </div>
                <ol
                  className="mt-2 divide-y divide-[color:var(--border-subtle)] border-t border-[color:var(--border-subtle)]"
                  aria-label={`Passages from ${card.title}`}
                >
                  {group.hits.map(hit => (
                    <SearchHitRow key={hit.chunkId} hit={hit} query={data.query} />
                  ))}
                </ol>
              </>
            }
          />
        )
      })}
    </section>
  )
}

/**
 * Why a search with only stopwords found nothing — the server said so (`lexical: 'no_terms'`), so
 * there is no word list here. One word, or several, phrased to match.
 */
export function tooCommonMessage(query: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean)
  return words.length === 1
    ? `“${query.trim()}” is too common a word to search for on its own — try a more specific word.`
    : `Every word in “${query.trim()}” is too common to search for on its own — try a more specific word.`
}

/**
 * Documents embedded by another model than today's are invisible to meaning-based search until
 * re-embedded. Anyone sees the count (`/facets`, their visible documents); a reader who may
 * `manage Document` gets "Re-index now" (`POST /reembed`), and then the count falls as the facets
 * poll. No success toast — the notice counting down, then going away, is the answer.
 */
function StaleEmbeddingsNotice({
  stale,
  reindexing,
  onStarted,
}: {
  stale: number
  reindexing: boolean
  onStarted: (enqueued: boolean) => void
}) {
  const { can } = usePermissions()
  const reembed = useReembedDocuments()
  if (stale === 0) return null
  const documents = stale === 1 ? '1 document was' : `${stale} documents were`
  return (
    <div role="status" className="alert alert-info alert-soft mb-4 text-sm">
      <InformationCircleIcon className="w-5 h-5 shrink-0" aria-hidden="true" />
      <span>
        {documents} indexed with a different model, so meaning-based search can't find{' '}
        {stale === 1 ? 'it' : 'them'} yet.
        {reindexing
          ? ' Re-indexing…'
          : !can('manage', 'Document') && ' An admin can re-index them.'}
      </span>
      {can('manage', 'Document') && (
        <button
          type="button"
          className="btn btn-sm gap-1.5"
          disabled={reindexing || reembed.isPending}
          onClick={() => reembed.mutate(undefined, { onSuccess: r => onStarted(r.enqueued) })}
        >
          <ArrowPathIcon
            className={`w-4 h-4 ${reindexing || reembed.isPending ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          {reindexing ? 'Re-indexing' : 'Re-index now'}
        </button>
      )}
    </div>
  )
}

/**
 * Documents indexed before the `knowledge-context` flag was on (or before a backfill) have no
 * contextual prefix, so search finds their passages less well. Only a reader who may
 * `manage Document` is told — search still works for everyone — with "Add context"
 * (`POST /contextualize`, repeated while documents remain). The count falls as the facets poll;
 * no success toast.
 */
function ContextBackfillNotice({
  missing,
  contextualizing,
  onStarted,
}: {
  missing: number
  contextualizing: boolean
  onStarted: () => void
}) {
  const { can } = usePermissions()
  const backfill = useContextualizeDocuments()
  if (missing === 0 || !can('manage', 'Document')) return null
  const busy = contextualizing || backfill.isPending
  return (
    <div role="status" className="alert alert-info alert-soft mb-4 text-sm">
      <SparklesIcon className="w-5 h-5 shrink-0" aria-hidden="true" />
      <span>
        {missing === 1 ? '1 document has' : `${missing} documents have`} no search context yet, so
        search finds {missing === 1 ? 'its' : 'their'} passages less well.
        {busy && ' Adding context…'}
      </span>
      <button
        type="button"
        className="btn btn-sm gap-1.5"
        disabled={busy}
        onClick={() => backfill.mutate(undefined, { onSuccess: () => onStarted() })}
      >
        <SparklesIcon className={`w-4 h-4 ${busy ? 'animate-pulse' : ''}`} aria-hidden="true" />
        {busy ? 'Adding context' : 'Add context'}
      </button>
    </div>
  )
}

/** The facts about the entities the query names — supplementary, so a failure shows nothing. */
function MentionedFacts({ query }: { query: string }) {
  const facts = useMentionedFacts(query)
  const cards = useMemo(() => entityCardsFromFactGroups(facts.data?.entities ?? []), [facts.data])
  if (cards.length === 0) return null
  return (
    <section aria-label="Known facts" className="space-y-2">
      <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
        <CubeIcon className="w-4 h-4 text-muted" aria-hidden="true" />
        Known facts
      </h2>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        {cards.map(card => (
          <EntityFactsCard key={`${card.entity.type}:${card.entity.id}`} card={card} />
        ))}
      </div>
    </section>
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
 * its select — no request per hit. A document outside that page (the list is capped at 100)
 * degrades to what the hit itself carries, which is enough to render and to link.
 */
function cardFor(group: HitGroup, doc: Document | undefined): DocumentCardData {
  if (doc) return documentCardFromDocument(doc)
  return {
    id: group.documentId,
    title: group.title,
    typeLabel: null,
    contentType: 'text/plain',
    status: 'indexed',
    excerpt: null,
    passages: group.documentPassages,
    sizeBytes: null,
    fileId: null,
    href: documentPath(group.documentId),
  }
}

/** A passage longer than this many characters starts clamped to four lines, with "Show more". */
const CLAMP_CHARS = 360

function SearchHitRow({ hit, query }: { hit: SearchHit; query: string }) {
  const [open, setOpen] = useState(false)
  // A snippet is read as text: the passage's markdown syntax (`##`, `| --- |`) is noise here.
  const text = useMemo(() => stripMarkdown(hit.text), [hit.text])
  const long = text.length > CLAMP_CHARS
  return (
    // Passages are separated by a hairline, not boxed: a box per hit inside the document's panel
    // is a card in a card. No rank number either — hits are grouped by document, so the fused
    // order would read 1, 4, 2; the order on the page is the ranking.
    <li className="py-3 text-sm space-y-1.5" data-rank={hit.rank}>
      <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs">
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
          Passage {hit.seq + 1} of {hit.documentPassages}
        </Link>
        {hit.headingPath && (
          <span
            className="text-secondary truncate max-w-full"
            title="The headings this passage sits under"
          >
            {hit.headingPath}
          </span>
        )}
      </div>
      <p
        className={`whitespace-pre-line break-words leading-relaxed max-w-[75ch] ${long && !open ? 'line-clamp-4' : ''}`}
      >
        <Highlighted text={text} query={query} />
      </p>
      {long && (
        <button
          type="button"
          className="btn btn-link btn-xs px-0 h-auto min-h-0"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </li>
  )
}

/** The query's terms as `<mark>` NODES — never `dangerouslySetInnerHTML` over uploaded text. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => highlightMatches(text, query), [text, query])
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

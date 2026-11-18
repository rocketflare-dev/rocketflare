# Knowledge UI (`/documents`, `/documents/:documentId`, `/search`)

All three are `guard read Document` and lazy. Hooks are `hooks/useDocuments.ts`, all under the
`['documents']` root so one invalidation covers the family. Only `DocumentViewPage` may import
`components/ai/Markdown` — `DocumentsPage` and `SearchPage` must NOT (`.claude/rules/ui.md`).

## Knowledge list (`DocumentsPage.tsx`, nav "Knowledge")

- The paginated documents table first, then `URLTabs` (`?tab=text|file`) to add. Paste text posts
  `ingestTextRequestSchema` output (blank source omitted — the server defaults it to `upload`).
  Upload file checks the pick with `validateDocumentUpload` (`DOCUMENT_UPLOAD_ACCEPT` +
  `MAX_UPLOAD_BYTES`) before any request, then `useUploadDocument()` posts multipart `file`
  (+ optional `title`/`source`) to `/api/ai/documents/upload`.
- Both toast `indexed (n chunks)` / `queued for …` and invalidate `documents`; the list polls
  `DOCUMENT_POLL_MS` while a row is `pending` (there is no document nudge yet).
- Rows show `documentTypeLabel(contentType)` under the title and a download link
  (`filePath(fileId)`) when there is an uploaded original; every title is a
  `<Link to={documentPath(doc.id)}>`, pending and failed rows included.
- The header states that everything indexed is also available to agents (`search_knowledge` /
  `get_document`). Delete shows only for own rows unless `delete Document` (admin+) — the route
  enforces.
- Retry: a `failed` row carries a Retry button (owner or `manage Document`, the visibility rule)
  → `useRetryDocument()` → `POST /:id/retry`, then the list is invalidated and polls the `pending`
  row. Errors toast; **success toasts nothing** — the badge changing is the answer.
- Visibility: both add forms carry an `AccessPicker`, each row a Visibility action (owner or
  `manage Document`) and an `AccessBadge`. `useShareableGroups()` here is the rule the picker is fed
  (every group for `manage Group`, `useMyGroups()` otherwise).

## To review (`ReviewList.tsx`, `?view=review`, D43)

- With `KNOWLEDGE_FACTS_GUARD` (the `knowledge-facts` flag AND `read KnowledgeFact`) the page
  carries a Documents | To review switch (`role="tablist"`, `?view=` with `replace`); without it
  there is no switch, `?view=review` shows the documents, and nothing under `/api/knowledge` is
  requested. The tab's count is `useMyReviewCount()` — the SAME query as the nav badge.
- The list is `GET /api/knowledge/review` (kind filter; "Only mine" for `manage KnowledgeFact`),
  each item a `ReviewItem` (`components/knowledge/`): a fact with every visible other side of its
  conflict, each with its source and inline doubt; a possible match with Merge / Keep separate;
  every item links to its entity page (`entityPath`). The API lists each side of a conflict as
  its own item; `withoutRepeatedConflicts` drops a later side already shown under an earlier one,
  so a disagreement appears once (the tab's count still counts facts). Settled items update in place on the
  `['knowledge']` refetch — no success toast.

## Facts (`FactsBrowser.tsx`, `?view=facts`, D43)

- A third tab of the same switch (behind `KNOWLEDGE_FACTS_GUARD`), a BROWSE view, not a queue: no
  bulk action, and the To review badge is untouched. `useKnowledgeEntities` → `GET
  /api/knowledge/entities`: name (→ `entityPath`), type, facts, needs a look, last seen; the
  left column (type, "Needs a look", source kind — values from the response's `facets`) folds
  behind a button below `lg`; a debounced `SearchInput` for names; `PaginationControls`.
- Its URL params are prefixed (`ftype`, `fsource`, `needs`, `fq`, `fpage` — `FACTS_VIEW_PARAMS`)
  and dropped when the view changes.

## Viewer (`DocumentViewPage.tsx`, no SideNav entry)

- Tabs `?tab=document|details`, plus `facts` behind `KNOWLEDGE_FACTS_GUARD` (`DocumentFactsPanel`,
  `useDocumentFacts` → `GET /api/knowledge/documents/:id/facts`): facts grouped by entity (name →
  entity page), key, value, state, quote, the inline `FactDoubt`, and "Show in document" →
  `documentPath(id, { tab: 'document', offset: charStart, end: charEnd })`. `?end=` makes the Plain
  view mark exactly `offset`…`end` (and opens in Plain); the empty state says when no entity types
  are registered. Dispatches on `fileId`, upload kind and status: a PDF embeds its
  original with `<object>` — **never try to detect failure, the CHILDREN are the fallback** — and
  the header always carries Download original and a Converted text toggle; everything else renders
  its text (markdown through `components/ai/Markdown`, plain types in a `<pre>`).
- Deep links: `?offset=` is snapped by `windowStart()` so a link and the reader's paging share one
  cache entry; `?chunk=` is the fallback when `charOffset` is null; `?q=` highlights through
  `lib/highlight.ts` as `<mark>` NODES (never `dangerouslySetInnerHTML` over uploaded text).
  Markdown still renders AS markdown; the Plain toggle is where highlighting and the passage anchor
  live (`<mark>` cannot be threaded through react-markdown's AST).
- Hooks: `useDocumentContent(id, offset)`, `useDocumentPassages(id, filters)`,
  `useDocumentCard(id)`; `documentPollInterval(status)` is the pure decision.

## `DocumentCard` / `DocumentLink` (`components/shared/`)

- `DocumentCard` is the compact citation form and is **markdown-free by construction** — so it sits
  in the eager barrel and is used from Search and from inside `Markdown` itself (an anchor whose
  href matches `/documents/<uuid>` renders as a card). Its `excerpt` is the head of the text, not a
  summary; there is no thumbnail.
- **`DocumentLink` is the same document on ONE LINE** (icon, title, passage count) for dense lists
  (the run timeline's tool results, `research-topic`'s Sources), built through
  `documentLinkProps(card)` where a card is held, so the two cannot drift. Same markdown-free rule.
  A card where the document IS the content; a link where it is a reference inside something else.

## Search (`SearchPage.tsx`, nav "Search")

- The kit list layout (`max-w-6xl`): query box across the top, a filter column on the left
  (`lg:grid-cols-[16rem_…]`; below `lg` folded behind a "Filters" button above the results), the
  results beside it.
- **The URL is the state**: `?q=`, `?documentId=`, `?source=` / `?type=` (repeatable, exact
  `documents.source` / `content_type` values), `?from=` / `?to=` (UTC days, inclusive). Whatever
  the URL means is parsed with `searchRequestSchema` and run once per distinct request (the
  `lastRun` ref holds the serialised request); a submit writes `?q=` and a filter change its own
  param, all with `replace`. An inverted date range is a `FieldError` in the column, never sent.
- Filter values come from `useDocumentFacets()` (`GET /facets`, the reader's visible indexed
  documents): sources labelled by `documentSourceLabel`, types grouped by `documentTypeLabel`
  (one "Excel" option = both media types). A URL value the facets do not list still renders,
  checked, so it can be cleared.
- `useSearch()` is mutation-style (hits are its `data`), grouped by document under a dense
  `DocumentCard` built client-side from the `useDocuments({ pageSize: 100 })` list (no request per
  hit), with source, date added and an "Only this document" button in its footer. Each hit:
  `passage n of m` (a `<Link>` to `documentPath(documentId, { offset, chunk, q })`), heading path,
  dense/lexical/score diagnostics, the passage with query terms as `<mark>` nodes
  (`lib/highlight.ts`), clamped to four lines past 360 characters with Show more.
- With `KNOWLEDGE_FACTS_GUARD`, `useMentionedFacts(query)` (`GET /api/knowledge/mentioned`) puts
  `EntityFactsCard`s above the results; without it nothing under `/api/knowledge` is requested.
- Stale embeddings: `facets.staleEmbeddings > 0` shows an `alert-info` notice ("N documents were
  indexed with a different model…"); `can('manage', 'Document')` gets "Re-index now"
  (`useReembedDocuments` → `POST /reembed`), others a sentence. After it, the facets poll
  (`facetsPollInterval`, pure) until the count is 0 and the notice goes — no success toast.
- `lexical: 'no_terms'` with no hits → the empty state says the word is too common
  (`tooCommonMessage`); the server decides, the UI holds no stopword list.
- States: skeleton while searching, an EmptyState prompt before the first search, "No matches"
  (with Clear filters when any are set), and after a failure — which toasts — a neutral Try again.
  An empty knowledge base shows an EmptyState linking to `/documents`.

## Tests

`tests/ui/`: `documents-page`, `search-page`, `document-view`, `document-card`,
`knowledge-review` (the view switch, the list, the badge, the flag off), `knowledge-entity-page`,
`knowledge-browse` (the viewer's Facts tab, the span link, the Facts view and its URL); the pure helpers in
`tests/config/document-helpers.test.ts`.

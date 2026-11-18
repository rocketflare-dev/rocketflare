---
version: unreleased
previous: 0.37.0
date: null
breaking: false
migrations: []
areas: [api, shared, ui, docs]
touches_surfaces: [feature-knowledge]
requires_surfaces: []
manual: false
---

## What changed

The Search page becomes a full-width list with a URL-kept filter column, cleaner results, a facts block and a stale-embeddings notice, backed by search `filters`, a `lexical` report and a facets endpoint.

- `POST /api/ai/documents/search` takes optional `filters` (`searchFiltersSchema`: `sources`, `contentTypes`, `createdFrom`, `createdTo`); they narrow the reader's visible documents and never widen them.
- New `GET /api/ai/documents/facets` (`documentFacetsSchema`): the sources, content types and date span of the indexed documents the reader may see.
- New `GET /api/knowledge/mentioned?q=` (behind the `knowledge-facts` flag): the facts about the entities a query names; shared `entityCardsFromFactGroups` maps them to chat-style entity cards.
- **Behaviour:** the search response gains `lexical: 'used' | 'no_terms'` (`no_terms` = every query word is a Postgres stopword); the facets gain `staleEmbeddings` (the reader's visible documents embedded by another model).
- The Search page shows a stale-embeddings notice with "Re-index now" for `manage Document` (`useReembedDocuments`), and says a stopword-only query is too common instead of "no matches".
- `documentSourceLabel` in `@rocketflare/shared/ai/embeddings`; `useDocumentFacets`, `useMentionedFacts`, `queryKeys.documents.facets` and `queryKeys.knowledge.mentioned` in the UI.
- `SearchPage.tsx` rewritten: `max-w-6xl` grid, filter column (folded below `lg`), source and date under each document, highlighted passages with Show more, skeleton / empty / no-match / try-again states.

## How to apply

1. Port `searchLexicalSchema` and the `lexical` field of `searchResponseSchema`, `searchFiltersSchema`, the `filters` field of `searchRequestSchema`, `documentFacetsSchema`, `documentFacetValueSchema` and `documentSourceLabel` from the release's `packages/shared/src/ai/embeddings.ts`.
2. Port `mentionedFactsQuerySchema`, `mentionedFactsResponseSchema` and `entityCardsFromFactGroups` from the release's `packages/shared/src/ai/knowledge-facts.ts`.
3. Port `documentFilterPredicate`, `lexicalHasTerms` and the `lexical` field of `KnowledgeChunkSearch` from the release's `apps/web/src/api/services/ai/retrieval.ts`, and `countVisibleStaleDocuments` from its `reindex.ts`. Any code of your own that builds a `KnowledgeChunkSearch` must set `lexical`.
4. Port the `POST /search` route (it now calls `searchKnowledgeChunks` and returns `lexical`) and the `GET /facets` route from the release's `apps/web/src/api/routes/ai-documents.ts`, registered BEFORE `GET /:id`.
5. Port the `GET /mentioned` route from the release's `apps/web/src/api/routes/knowledge.ts`.
6. Port `useDocumentFacets`, `facetsPollInterval` and `useReembedDocuments` (`apps/web/src/ui/hooks/useDocuments.ts`), `useMentionedFacts` (`apps/web/src/ui/hooks/useKnowledge.ts`) and the `documents.facets` / `knowledge.mentioned` keys (`apps/web/src/ui/lib/query-keys.ts`).
7. Replace `apps/web/src/ui/pages/documents/SearchPage.tsx` with the release's, re-applying any changes of your own to it.
8. Port `apps/web/tests/api/knowledge-search-filters.test.ts` and the release's `apps/web/tests/ui/search-page.test.tsx`.

## Conflicts to expect

- `apps/web/src/ui/pages/documents/SearchPage.tsx` → rewritten → take the release's and re-apply your own edits.
- `apps/web/tests/ui/search-page.test.tsx` → route table gains `/api/ai/documents/facets`, search fixtures gain `lexical` → keep both sides' cases and add `lexical: 'used'` to yours.
- Any test fixture that builds a `SearchResponse` → `lexical` is required → add `lexical: 'used'`.

## Verify

1. `pnpm web test:api -- tests/api/knowledge-search-filters.test.ts` passes.
2. `pnpm web test:ui -- tests/ui/search-page.test.tsx` passes.
3. In `pnpm dev`, `/search?q=and` with no matches says “and” is too common a word to search for.
4. In `pnpm dev`, `/search?q=<word>&source=upload` shows the Uploaded or pasted box checked and only uploaded documents in the results.

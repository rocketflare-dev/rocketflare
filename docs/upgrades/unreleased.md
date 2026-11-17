---
version: unreleased
previous: 0.36.1
date: null
breaking: false
migrations:
  - "chunks: embedding_model (backfilled from documents), heading_path, table_header, page, char_start, char_end, generated search_vector + GIN index"
  - "documents: content_hash + (tenant_id, source, content_hash) index"
areas: [evals, docs, db, api, shared, ui]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The knowledge base becomes measurable and structure-aware: eval corpora and retrieval scorers, chunks that are exact heading- and table-aware slices under a generated lexical index, model-consistent dense search, and content-hash dedupe.

- Eval corpora: a directory under `apps/evals/datasets/` with `docs/*.md` and answer keys (`retrieval.jsonl`, `chat.jsonl`, `entities.jsonl`, `facts.jsonl`, `conflicts.jsonl`), ingested once with a real embedder (`docs/EVALS.md` § Corpora).
- New suite `knowledge · retrieval` and judges `RecallAtK(k)`, `MRR()`, `ContextPrecision(k)`; `chatHarness({ corpus })` runs a corpus's `chat.jsonl` inside `chat · knowledge`.
- New scorers `factExtractionScore` and `conflictDetectionScore` in `apps/evals/kit/scoring.ts`; the run summary prints a mean row per suite.
- `GEMINI_API_KEY` alone is now enough for corpus suites: it is used as a tenant embeddings row on `gemini-embedding-001`.
- Chunks are exact slices of the stored text (`chunks.char_start`/`char_end`; overlap by starting the next window earlier); `charOffset` reads the stored offset.
- Every chunk begins and ends at a markdown heading: whole sections that fit a window are packed together, a longer one is cut inside; each chunk stores the headings its sections share as `heading_path` (`Pricing › Annual plans`), prefixed to the EMBEDDED text only.
- GFM tables (spreadsheet sheets from `toMarkdown`) split only between rows; a chunk holding rows without the header stores it as `table_header`, also embedded and indexed.
- Lexical search reads a generated `chunks.search_vector` (heading path + table header + text, GIN) instead of computing `to_tsvector` per query.
- Every dense leg filters on `chunks.embedding_model` = the query vector's model; another model's chunks are found by keyword only.
- `documents.content_hash` (sha-256 of the normalised text): an unchanged `externalId` upsert is `mode: 'unchanged'` (no chunking or embedding; metadata and grants still update).
- A plain ingest or text upload matching a tenant-wide document of the same source answers it: `200` with `deduplicated: true` (`ingestDocumentResponseSchema`); `PluginIngestResult` gains `deduplicated`.
- Stored document text has CRLF normalised to LF; search hits (and `searchKnowledge` hits) gain `headingPath` and `page` (always null: `toMarkdown` emits no page markers).

## How to apply

1. Port `apps/evals/kit/` (`corpus.ts`, `retrieval.ts`, and the changes to `fixtures.ts`, `providers.ts`, `spend.ts`, `chat-target.ts`, `scoring.ts`, `index.ts`), `apps/evals/scripts/lib.mjs`, `apps/evals/suites/knowledge/retrieval.eval.ts`, `apps/evals/suites/chat/knowledge.eval.ts` and `apps/evals/tests/corpus.test.ts` from the release. The kit's own fixture under `apps/evals/datasets/kit-only/` is not part of a copy.
2. Optional: write a corpus of your own documents under `apps/evals/datasets/<name>/` (`docs/EVALS.md` § Corpora) and run `pnpm eval knowledge`.
3. Port the chunk-structure change from the release: `apps/web/src/api/services/ai/chunking.ts`, `ingest.ts`, `retrieval.ts` and `platform-documents.ts`, `apps/web/src/db/schema/chunks.ts` and `documents.ts`, `apps/web/src/api/routes/ai-documents.ts`, `apps/web/src/plugins/api/knowledge.ts`, `apps/web/src/api/services/agents/tools/search-knowledge.ts`, `packages/shared/src/ai/embeddings.ts` (`ingestDocumentResponseSchema`, `searchHitSchema.headingPath`/`page`), the UI's `useDocuments.ts`, `DocumentsPage.tsx` and `SearchPage.tsx`, and the seed's chunk insert in `apps/web/scripts/seed.ts`. Any code of your own that inserts `chunks` rows directly must now set `embeddingModel`, or the dense leg never returns those rows.
4. Run `pnpm db:generate --name knowledge-chunk-structure`, then edit the generated SQL BEFORE applying it: directly after the `ALTER TABLE "chunks" ADD COLUMN "embedding_model" text;` statement add `UPDATE "chunks" SET "embedding_model" = "documents"."embedding_model" FROM "documents" WHERE "documents"."id" = "chunks"."document_id" AND "chunks"."embedding_model" IS NULL;--> statement-breakpoint`. Without that backfill every existing chunk is invisible to dense search after the upgrade. Then `pnpm db:migrate`. Adding the generated `search_vector` column rewrites the whole `chunks` table under an exclusive lock: above roughly 1M chunks, apply it in a maintenance window.
5. Existing chunks keep their old shape (no heading path, no offsets) until their document is re-indexed; nothing re-indexes them automatically, and an unchanged external-id re-sync no longer does either. Re-ingest a document to give it the new structure.

## Conflicts to expect

- `apps/evals/suites/chat/knowledge.eval.ts` → also runs every corpus's `chat.jsonl` → keep your own judges and add the corpus loop.
- `apps/web/src/api/services/ai/chunking.ts` → rewritten (exact slices, sections, tables; `TextChunk` gains `charStart`, `charEnd`, `headingPath`, `tableHeader`, `page`) → take the kit's file and re-apply a custom window size through `ChunkOptions`.
- `apps/web/src/api/routes/ai-documents.ts` → `/ingest` and `/upload` answer `ingestDocumentResponseSchema` (`200` on a duplicate) → a client that asserts `201` on every ingest must accept `200`.

## Verify

1. `pnpm --filter @<scope>/evals test` passes.
2. `pnpm eval knowledge` with no corpus prints the retrieval suite as skipped.
3. `psql "$DATABASE_URL" -c "select count(*) from chunks where embedding_model is null"` answers `0` after `pnpm db:migrate`.
4. Ingesting the same text twice through `POST /api/ai/documents/ingest` answers `201` then `200` with `deduplicated: true` and the same `id`.
5. `pnpm --filter @<scope>/web test:config` passes, including `chunking.test.ts` and `search-text-config.test.ts`.

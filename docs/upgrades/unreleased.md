---
version: unreleased
previous: 0.36.1
date: null
breaking: false
migrations:
  - "chunks: embedding_model (backfilled from documents), heading_path, table_header, page, char_start, char_end, generated search_vector + GIN index"
  - "documents: content_hash + (tenant_id, source, content_hash) index"
areas: [evals, docs, db, api, shared, ui, config, scripts]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

The knowledge base becomes measurable and structure-aware: eval corpora and retrieval scorers, heading- and table-aware chunks under a generated lexical index, model-consistent dense search with re-embedding, content-hash dedupe, and failed-document retry behind a dead-letter queue.

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
- `GET /api/ai/documents/health` (admin+, `documentsHealthSchema`): documents by status, today's `embeddingModel`, `staleEmbeddings` (indexed documents with a chunk from another model) and `staleChunks`.
- New job `document.reembed` (`{ tenantId, model }`): ≤ 20 documents / 400 chunks per message, re-enqueued while more remain; old chunks stay searchable on a failure. `POST /api/ai/documents/reembed` (admin+) answers `202`.
- Saving or deleting an `embeddings` config that changes the resolved model enqueues `document.reembed` after the commit; without `JOBS_QUEUE` the save still succeeds and logs a warning.
- `POST /api/ai/documents/:id/retry` (owner or admin+): `202` with the row `pending` and `job` (`document.convert` when there is no text, else `document.index`); `409 document_not_failed`. The Documents page shows Retry on a failed row (errors toast, success does not).
- The jobs consumer dead-letters into `<app>-jobs-dlq` / `<app>-jobs-dlq-staging` (`dead_letter_queue`), created by `pnpm provision cloudflare`; no consumer is bound to it.
- Inline indexing is an `ingest document` span (under the active span, else a root on the request tracer) with its embeddings batches as children; `IngestDeps.tracer` is new.
- `indexDocument` takes `markFailedOnError: false`; `markDocumentFailed` and `resolveEmbeddingsModel` (the resolved model, no client) are exported.
- Stored document text has CRLF normalised to LF; search hits (and `searchKnowledge` hits) gain `headingPath` and `page` (always null: `toMarkdown` emits no page markers).

## How to apply

1. Port `apps/evals/kit/` (`corpus.ts`, `retrieval.ts`, and the changes to `fixtures.ts`, `providers.ts`, `spend.ts`, `chat-target.ts`, `scoring.ts`, `index.ts`), `apps/evals/scripts/lib.mjs`, `apps/evals/suites/knowledge/retrieval.eval.ts`, `apps/evals/suites/chat/knowledge.eval.ts` and `apps/evals/tests/corpus.test.ts` from the release. The kit's own fixture under `apps/evals/datasets/kit-only/` is not part of a copy.
2. Optional: write a corpus of your own documents under `apps/evals/datasets/<name>/` (`docs/EVALS.md` § Corpora) and run `pnpm eval knowledge`.
3. Port the chunk-structure change from the release: `apps/web/src/api/services/ai/chunking.ts`, `ingest.ts`, `retrieval.ts` and `platform-documents.ts`, `apps/web/src/db/schema/chunks.ts` and `documents.ts`, `apps/web/src/api/routes/ai-documents.ts`, `apps/web/src/plugins/api/knowledge.ts`, `apps/web/src/api/services/agents/tools/search-knowledge.ts`, `packages/shared/src/ai/embeddings.ts` (`ingestDocumentResponseSchema`, `searchHitSchema.headingPath`/`page`), the UI's `useDocuments.ts`, `DocumentsPage.tsx` and `SearchPage.tsx`, and the seed's chunk insert in `apps/web/scripts/seed.ts`. Any code of your own that inserts `chunks` rows directly must now set `embeddingModel`, or the dense leg never returns those rows.
4. Run `pnpm db:generate --name knowledge-chunk-structure`, then edit the generated SQL BEFORE applying it: directly after the `ALTER TABLE "chunks" ADD COLUMN "embedding_model" text;` statement add `UPDATE "chunks" SET "embedding_model" = "documents"."embedding_model" FROM "documents" WHERE "documents"."id" = "chunks"."document_id" AND "chunks"."embedding_model" IS NULL;--> statement-breakpoint`. Without that backfill every existing chunk is invisible to dense search after the upgrade. Then `pnpm db:migrate`. Adding the generated `search_vector` column rewrites the whole `chunks` table under an exclusive lock: above roughly 1M chunks, apply it in a maintenance window.
5. Existing chunks keep their old shape (no heading path, no offsets) until their document is re-indexed. The re-embed below rebuilds only documents whose chunks came from another embeddings model, and an unchanged external-id re-sync no longer re-indexes at all. Re-ingest a document to give it the new structure.
6. Port the re-embed and retry from the release: `apps/web/src/api/services/ai/reindex.ts` (new), `apps/web/src/api/queues/handlers/document-reembed.ts` (new, plus its `coreHandlers` entry in `apps/web/src/api/queues/jobs.ts`), the `document.reembed` variant in `packages/shared/src/jobs.ts` `CORE_JOB_VARIANTS`, the three schemas in `packages/shared/src/ai/embeddings.ts` (`documentsHealthSchema`, `reembedResponseSchema`, `retryDocumentResponseSchema`), `resolveEmbeddingsModel` in `apps/web/src/api/services/ai/resolve.ts`, the `/health`, `/reembed` and `/:id/retry` routes in `apps/web/src/api/routes/ai-documents.ts` (`/health` and `/reembed` must be registered BEFORE `GET /:id`), the `reembedAfterEmbeddingsChange` calls in `apps/web/src/api/routes/ai-config.ts`, the `tracer` and `markFailedOnError` changes in `apps/web/src/api/services/ai/ingest.ts`, and `useRetryDocument` + the Retry button in `apps/web/src/ui/hooks/useDocuments.ts` and `apps/web/src/ui/pages/documents/DocumentsPage.tsx`. A type test pinning the core job list (`CoreJobType`) gains `'document.reembed'`.
7. Add the jobs dead-letter queue to BOTH tomls, named from your app's own queue names: in `apps/web/wrangler.toml`'s `[[queues.consumers]]` set `dead_letter_queue = "<app>-jobs-dlq"`, and in `apps/web/wrangler.staging.toml`'s set `dead_letter_queue = "<app>-jobs-dlq-staging"` (queue names are account-scoped, so staging's must differ). Bind NO consumer to it: the name shares the `<app>-jobs` prefix `queue.ts` dispatches on, so a consumer would reprocess every dead message.
8. Create each environment's dead-letter queue before its next deploy: port the `DLQ_NAME` lines of `apps/web/scripts/cf-provision.sh` and run `pnpm provision cloudflare production` and `pnpm provision cloudflare staging`, or by hand `pnpm --filter @<scope>/web exec wrangler queues create <app>-jobs-dlq` and `… queues create <app>-jobs-dlq-staging`. A deploy whose `dead_letter_queue` does not exist fails.

## Conflicts to expect

- `apps/evals/suites/chat/knowledge.eval.ts` → also runs every corpus's `chat.jsonl` → keep your own judges and add the corpus loop.
- `apps/web/src/api/services/ai/chunking.ts` → rewritten (exact slices, sections, tables; `TextChunk` gains `charStart`, `charEnd`, `headingPath`, `tableHeader`, `page`) → take the kit's file and re-apply a custom window size through `ChunkOptions`.
- `apps/web/wrangler.toml` / `wrangler.staging.toml` → the commented `# dead_letter_queue` line becomes a real one → keep your own queue name with `-dlq` (and `-dlq-staging`) appended.
- `apps/web/src/api/routes/ai-documents.ts` → `/ingest` and `/upload` answer `ingestDocumentResponseSchema` (`200` on a duplicate) → a client that asserts `201` on every ingest must accept `200`.

## Verify

1. `pnpm --filter @<scope>/evals test` passes.
2. `pnpm eval knowledge` with no corpus prints the retrieval suite as skipped.
3. `psql "$DATABASE_URL" -c "select count(*) from chunks where embedding_model is null"` answers `0` after `pnpm db:migrate`.
4. Ingesting the same text twice through `POST /api/ai/documents/ingest` answers `201` then `200` with `deduplicated: true` and the same `id`.
5. `pnpm --filter @<scope>/web test:config` passes, including `chunking.test.ts`, `search-text-config.test.ts` and the dead-letter case in `wrangler-parity.test.ts`.
6. As an admin, `GET /api/ai/documents/health` answers `200` with `staleEmbeddings`; `POST /api/ai/documents/reembed` answers `202`.
7. `pnpm --filter @<scope>/web exec wrangler queues list` shows `<app>-jobs-dlq` (and `<app>-jobs-dlq-staging` on the staging account).

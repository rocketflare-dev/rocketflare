---
version: unreleased
previous: 0.36.1
date: null
breaking: false
migrations: []
areas: [evals, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The knowledge base becomes measurable: eval corpora with answer keys, a retrieval suite scored by recall@k, MRR and context precision, and fact and conflict scorers.

- Eval corpora: a directory under `apps/evals/datasets/` with `docs/*.md` and answer keys (`retrieval.jsonl`, `chat.jsonl`, `entities.jsonl`, `facts.jsonl`, `conflicts.jsonl`), ingested once with a real embedder (`docs/EVALS.md` § Corpora).
- New suite `knowledge · retrieval` and judges `RecallAtK(k)`, `MRR()`, `ContextPrecision(k)`; `chatHarness({ corpus })` runs a corpus's `chat.jsonl` inside `chat · knowledge`.
- New scorers `factExtractionScore` and `conflictDetectionScore` in `apps/evals/kit/scoring.ts`; the run summary prints a mean row per suite.
- `GEMINI_API_KEY` alone is now enough for corpus suites: it is used as a tenant embeddings row on `gemini-embedding-001`.

## How to apply

1. Port `apps/evals/kit/` (`corpus.ts`, `retrieval.ts`, and the changes to `fixtures.ts`, `providers.ts`, `spend.ts`, `chat-target.ts`, `scoring.ts`, `index.ts`), `apps/evals/scripts/lib.mjs`, `apps/evals/suites/knowledge/retrieval.eval.ts`, `apps/evals/suites/chat/knowledge.eval.ts` and `apps/evals/tests/corpus.test.ts` from the release. The kit's own fixture under `apps/evals/datasets/kit-only/` is not part of a copy.
2. Optional: write a corpus of your own documents under `apps/evals/datasets/<name>/` (`docs/EVALS.md` § Corpora) and run `pnpm eval knowledge`.

## Conflicts to expect

- `apps/evals/suites/chat/knowledge.eval.ts` → also runs every corpus's `chat.jsonl` → keep your own judges and add the corpus loop.

## Verify

1. `pnpm --filter @<scope>/evals test` passes.
2. `pnpm eval knowledge` with no corpus prints the retrieval suite as skipped.

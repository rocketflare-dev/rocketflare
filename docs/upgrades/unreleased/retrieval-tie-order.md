---
breaking: false
migrations: []
areas: [api, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Knowledge search now returns equal-scored passages in one order. Before, each retrieval leg ordered only by its score, so the database could return tied passages in a different order on each query, and their fused ranks changed with it.

- `apps/web/src/api/services/ai/retrieval.ts`: every dense leg (tenant, platform, shared) and the lexical leg orders by its score, then `chunks.id`. The HNSW index is still used; Postgres adds an incremental sort over the tied rows.
- `apps/web/tests/api/knowledge-rerank.test.ts` adds a test with eight passages tied on both signals. It asserts the hits come back in chunk-id order and the same order twice.

## How to apply

- Take `retrieval.ts` as it is if you have not changed it. Otherwise add `chunks.id` as the second `orderBy` key in the four leg queries.

## Conflicts to expect

None.

## Verify

- `pnpm test api tests/api/knowledge-rerank.test.ts` passes.

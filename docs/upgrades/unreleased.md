---
version: unreleased
previous: 0.39.0
date: null
breaking: false
migrations: []
areas: [api, shared, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A knowledge `prefer` now settles only conflicts the reader may settle, and the chunker classifies every line in linear time and bounds the table header and context each chunk carries.

- `POST /api/knowledge/facts/:id/review { action: 'prefer' }` by a member who cannot manage knowledge is a 403 `fact_conflict_needs_admin`, with nothing written, when a visible conflict is reviewed by someone else, has no reviewer, or was confirmed by another person. An admin still settles any conflict, and the member can still `reject` their own side.
- New error code `fact_conflict_needs_admin` in `@rocketflare/shared/errors`.
- `chunking.ts` recognises ATX headings and GFM delimiter rows with a linear scan instead of a regex. Every heading and delimiter row is recognised exactly as before.
- A table header wider than a quarter of the chunk window is carried as its first columns plus ` …`, so header and rows fit one window. A header wider than a window is split into windows of its own. Narrower headers are carried whole, as before.
- `embeddingInput` cuts the heading path and table header it prefixes to `EMBEDDING_CONTEXT_MAX_CHARS` (1600) and never cuts the chunk text. A heading title is cut to `HEADING_TITLE_MAX_CHARS` (200) in `headingPath`.
- `docs/DEPLOY.md` § Observability now matches the tomls (`invocation_logs = true`) and says invocation logs record each request's URL.
- Why: `docs/CONCEPTS.md` §9, the chunking paragraph and the knowledge review endpoints.

## How to apply

1. Port `apps/web/src/api/services/knowledge/review.ts`: add `assertMaySettleConflicts` and call it at the start of the `prefer` branch inside the transaction of `reviewFact`.
2. Add `factConflictNeedsAdmin: 'fact_conflict_needs_admin'` to `ERROR_CODES` in `packages/shared/src/errors.ts`.
3. If a test of your own has a member `prefer` a fact whose conflicts have no `reviewerUserId`, or another person's, seed those conflicts with the member as reviewer, or make the call as an admin.
4. Port `apps/web/src/api/services/ai/chunking.ts` whole if you have not changed it; otherwise port `parseAtxHeading`, `isTableDelimiter`, `carriedTableHeader`, the `splitTable` changes, `embeddingInput` and the two new constants.
5. Re-indexing is optional: a document chunked before this release keeps its stored `table_header` until it is next indexed.

## Conflicts to expect

- `apps/web/tests/api/knowledge-review.test.ts` → the prefer case seeds its conflicts with the member as reviewer → keep your own cases and apply the same seeding.
- `apps/web/tests/config/chunking.test.ts` → new `describe` blocks appended before `fuseByRank` → keep both.

## Verify

1. In `apps/web`, `NODE_ENV=test pnpm exec dotenv -e .env.test -- vitest run --project config tests/config/chunking.test.ts` passes.
2. In `apps/web`, `NODE_ENV=test pnpm exec dotenv -e .env.test -- vitest run --project api tests/api/security/knowledge-prefer-authority.test.ts tests/api/knowledge-review.test.ts` passes.
3. `grep -n "invocation_logs" docs/DEPLOY.md apps/web/wrangler.toml apps/web/wrangler.staging.toml` shows `true` everywhere.

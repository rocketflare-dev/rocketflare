---
version: unreleased
previous: 0.32.0
date: null
breaking: false
migrations: []
areas: [ui, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A platform document found by `search_knowledge`, such as a page of a plugin's user guide, no longer shows as a document card in chat or an agent run, where it linked to a page that could not open it.

- `documentCardsFromToolResult` in `packages/shared/src/ai/embeddings.ts` skips a search result marked `platform: true`. The live chat stream, a reloaded thread, an agent run's projection and its timeline all read cards through it. The passages still reach the model in the tool result.
- With a plugin that indexes platform documents installed (the `guide` plugin), `tests/api/chat-tools.test.ts` no longer fails on the extra cards when the plugin's tests ran first.

## How to apply

1. In `packages/shared/src/ai/embeddings.ts`, add `platform: z.literal(true).optional()` to the document object in `searchToolResultShape`, and skip a document with `platform` set at the top of the `KNOWLEDGE_TOOLS.search` loop in `documentCardsFromToolResult`.
2. Port the case "makes no card for a platform document" into `apps/web/tests/config/document-helpers.test.ts`.

## Conflicts to expect

None.

## Verify

1. `pnpm gate` passes.
2. `pnpm web test:config` passes `tests/config/document-helpers.test.ts`.

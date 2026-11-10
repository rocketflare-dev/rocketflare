---
version: unreleased
previous: 0.32.0
date: null
breaking: false
migrations: []
areas: [shared, ui, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Two plugin fixes: `EventPayloadOf` distributes over a union of event names, and a platform document, such as a guide page, no longer shows as a document card that linked to a page that could not open it.

- `packages/shared/src/plugins/types.ts`: `EventPayloadOf<S, E>` maps each name in `E` to its payload; a union of names was `never` before, so an app with two plugins that declare events failed typecheck at every `eventHandlers` list. `apps/web/tests/config/plugins.test.ts` covers two plugins' declarations and a union of names.
- `documentCardsFromToolResult` in `packages/shared/src/ai/embeddings.ts` skips a search result marked `platform: true`. The live chat stream, a reloaded thread, an agent run's projection and its timeline all read cards through it. The passages still reach the model in the tool result.
- With a plugin that indexes platform documents installed (the `guide` plugin), `tests/api/chat-tools.test.ts` no longer fails on the extra cards when the plugin's tests ran first.

## How to apply

1. In `packages/shared/src/plugins/types.ts`, wrap the body of `EventPayloadOf` in `E extends unknown ? … : never`, as the kit's copy at this release does.
2. In `packages/shared/src/ai/embeddings.ts`, add `platform: z.literal(true).optional()` to the document object in `searchToolResultShape`, and skip a document with `platform` set at the top of the `KNOWLEDGE_TOOLS.search` loop in `documentCardsFromToolResult`.
3. Port the case "makes no card for a platform document" into `apps/web/tests/config/document-helpers.test.ts`.
4. Run `node scripts/plugin-api-doc.mjs` to regenerate `docs/plugin-api.md`.

## Conflicts to expect

None.

## Verify

1. `pnpm gate` passes.
2. `pnpm typecheck` passes with two installed plugins that each declare an event.
3. `pnpm web test:config` passes, including `tests/config/document-helpers.test.ts` and `tests/config/plugins.test.ts`.

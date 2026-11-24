---
version: unreleased
previous: 0.44.1
date: null
breaking: false
migrations: []
areas: [api, shared, ui, cli]
touches_surfaces: [example-agent-summarize-text]
requires_surfaces: []
manual: false
---

## What changed

Agent run timelines show each model call inside its stage without agent code; knowledge facts gain a Promote picker, domain rows in search's facts block and a reviewer-only badge nudge; the CLI gains `docs` and `facts` commands.

- `services/agents/recording.ts` (new): `recordingChatClient` wraps `ctx.chat.client` so every call writes a `tool.start`/`tool.end` pair marked `kind: 'model'`; `loopEventSink` is the new `ctx.journal.onEvent`.
- `ToolLoopJournal.onEvent` (new, optional): a `runToolLoop` with a journal and no `onEvent` records its text, tool calls and results through it; a loop with its own `onEvent` is unchanged.
- `agentToolStartEventDataSchema` / `agentToolEndEventDataSchema` gain `kind: 'model'`; the AG-UI projection, the evals export and the eval transcript skip such rows.
- Run page: a model-call row (model, duration, tokens), stage headers count model calls apart from tools, the Usage tab gains "Model calls", and a call an earlier invocation left open shows stopped once a `willRetry` error lands.
- `TimelineGroup`: a stage with no rows renders without a button or chevron (#116).
- `summarize-text` no longer emits its own `submit_summary` pair around the model call.
- See `docs/CONCEPTS.md` §9 "Reading runs".
- Knowledge (#159): `GET /api/knowledge/entities/:id/promote-candidates?q=` (`promoteCandidatesResponseSchema`) feeds a Promote picker on the entity page in place of the raw row-id box.
- Knowledge (#159): `search_knowledge`'s facts block and `GET /api/knowledge/mentioned` also find a registered type's DOMAIN rows named in the query (`mentionFinderFor`; new optional `EntityTypeRegistration.mentions`).
- Knowledge (#159): the nav badge's count moved to its own query-key root `['knowledge-review-count']`, nudged only to the reviewers a write touched (`services/knowledge/notify.ts`); `access.changed` invalidates it too.
- CLI (#150): `docs list|search|ingest|retry` and `facts review|confirm|reject|prefer`.
- See `docs/CONCEPTS.md` §9 "Knowledge facts" and §11.

## How to apply

1. Take `apps/web/src/api/services/agents/recording.ts` and the `runtime.ts`, `replay.ts`, `agui-projection.ts`, `evals.ts` and `services/ai/agent-loop.ts` hunks as they are.
2. Take the `packages/shared/src/ai/agents.ts` hunk that adds `kind` to the two tool event schemas.
3. Take the run-page hunks under `apps/web/src/ui/pages/agents/run/` (`timelineModel.ts`, `TimelineGroup.tsx`, `ToolCallRow.tsx`, `output/RunUsageTab.tsx`).
4. In each of your own agents and plugins, delete any `ctx.emit({ type: 'tool.start' | 'tool.end' })` pair that only brackets a `ctx.chat.client` call (`callStructuredTool`, `complete`, `stream`, a plugin's `ctx.structured`): the runtime now writes that row, and keeping yours shows the call twice. Keep pairs around a tool handler the agent calls directly.
5. In each of your own agents whose `runToolLoop` (or a plugin's `ctx.toolLoop`) passes `onEvent` only to emit `tool.start`/`tool.end`/`text` rows, consider deleting that `onEvent`: with `journal: ctx.journal` the runtime writes the same rows.
6. If code of your own reads `tool.start` events as "tools the agent called", skip those whose `data.kind === 'model'`.
7. Take `apps/web/src/api/services/knowledge/notify.ts` and the `review.ts`, `extract.ts`, `resolve.ts`, `entities.ts`, `lookup.ts`, `types.ts` and `routes/knowledge.ts` hunks as they are.
8. Take the `packages/shared/src/ai/knowledge-facts.ts` and `packages/shared/src/realtime.ts` hunks, then the UI hunks in `ui/lib/query-keys.ts`, `ui/hooks/useKnowledge.ts` and `ui/pages/knowledge/EntityPage.tsx`.
9. If code of your own reads `queryKeys.knowledge.reviewCount`, read `queryKeys.knowledgeReviewCount.all` instead; if code of your own sends `entity.changed { entity: 'knowledge' }` after changing review items, call `nudgeKnowledgeChange` from `services/knowledge/notify.ts` with the affected reviewers, or their badges stop refreshing.
10. For each of your own entity types with a custom `resolve` and no `labelColumn`, add a `mentions` finder if its rows should appear in the search facts block; a type with a `labelColumn` needs nothing.
11. Take `apps/cli/src/commands/docs.ts`, `apps/cli/src/commands/facts.ts`, the `apps/cli/src/cli.ts` hunk and `apps/cli/tests/knowledge.test.ts` as they are.

## Conflicts to expect

- `apps/web/src/api/services/agents/examples/summarize-text.ts` → its own `submit_summary` pair removed → take the kit side unless you changed that block; then apply step 4 by hand.
- `apps/web/tests/ui/run-page.test.tsx` → the precheck stage is no longer a button → take the kit side.
- `apps/web/src/ui/pages/knowledge/EntityPage.tsx` → `PromotePanel` rewritten as a picker → take the kit side, then reapply your own copy edits.

## Verify

1. `pnpm gate` passes.
2. `pnpm test api apps/web/tests/api/agent-run-workflow.test.ts` passes, including "a model call that fails closes its row as an error; the retry records its own".
3. `pnpm test api apps/web/tests/api/knowledge-promote.test.ts apps/web/tests/api/knowledge-review.test.ts` passes, including "finds a row named in the query that never had a staging entity".
4. `pnpm --filter @rocketflare/cli test` passes, including `knowledge.test.ts`.
5. Run `summarize-text` locally: the "Summarising" stage expands to a "Model call · <model> answered" row with token counts, and "Checking the input" shows no chevron.

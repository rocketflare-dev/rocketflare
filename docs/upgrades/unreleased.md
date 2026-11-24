---
version: unreleased
previous: 0.44.1
date: null
breaking: false
migrations: []
areas: [api, shared, ui]
touches_surfaces: [example-agent-summarize-text]
requires_surfaces: []
manual: false
---

## What changed

Every agent run's timeline now shows each model call (and a journaled tool loop's tool calls) inside its stage without agent code, and a stage that recorded nothing is a plain line instead of an empty disclosure.

- `services/agents/recording.ts` (new): `recordingChatClient` wraps `ctx.chat.client` so every call writes a `tool.start`/`tool.end` pair marked `kind: 'model'`; `loopEventSink` is the new `ctx.journal.onEvent`.
- `ToolLoopJournal.onEvent` (new, optional): a `runToolLoop` with a journal and no `onEvent` records its text, tool calls and results through it; a loop with its own `onEvent` is unchanged.
- `agentToolStartEventDataSchema` / `agentToolEndEventDataSchema` gain `kind: 'model'`; the AG-UI projection, the evals export and the eval transcript skip such rows.
- Run page: a model-call row (model, duration, tokens), stage headers count model calls apart from tools, the Usage tab gains "Model calls", and a call an earlier invocation left open shows stopped once a `willRetry` error lands.
- `TimelineGroup`: a stage with no rows renders without a button or chevron (#116).
- `summarize-text` no longer emits its own `submit_summary` pair around the model call.
- See `docs/CONCEPTS.md` §9 "Reading runs".

## How to apply

1. Take `apps/web/src/api/services/agents/recording.ts` and the `runtime.ts`, `replay.ts`, `agui-projection.ts`, `evals.ts` and `services/ai/agent-loop.ts` hunks as they are.
2. Take the `packages/shared/src/ai/agents.ts` hunk that adds `kind` to the two tool event schemas.
3. Take the run-page hunks under `apps/web/src/ui/pages/agents/run/` (`timelineModel.ts`, `TimelineGroup.tsx`, `ToolCallRow.tsx`, `output/RunUsageTab.tsx`).
4. In each of your own agents and plugins, delete any `ctx.emit({ type: 'tool.start' | 'tool.end' })` pair that only brackets a `ctx.chat.client` call (`callStructuredTool`, `complete`, `stream`, a plugin's `ctx.structured`): the runtime now writes that row, and keeping yours shows the call twice. Keep pairs around a tool handler the agent calls directly.
5. In each of your own agents whose `runToolLoop` (or a plugin's `ctx.toolLoop`) passes `onEvent` only to emit `tool.start`/`tool.end`/`text` rows, consider deleting that `onEvent`: with `journal: ctx.journal` the runtime writes the same rows.
6. If code of your own reads `tool.start` events as "tools the agent called", skip those whose `data.kind === 'model'`.

## Conflicts to expect

- `apps/web/src/api/services/agents/examples/summarize-text.ts` → its own `submit_summary` pair removed → take the kit side unless you changed that block; then apply step 4 by hand.
- `apps/web/tests/ui/run-page.test.tsx` → the precheck stage is no longer a button → take the kit side.

## Verify

1. `pnpm gate` passes.
2. `pnpm test api apps/web/tests/api/agent-run-workflow.test.ts` passes, including "a model call that fails closes its row as an error; the retry records its own".
3. Run `summarize-text` locally: the "Summarising" stage expands to a "Model call · <model> answered" row with token counts, and "Checking the input" shows no chevron.

# Agents UI (`/agents`, `/agents/runs/:runId`)

`AgentsPage` (roster + runs table) and `RunPage` (its OWN lazy chunk), both `read AgentRun`. Also
covers `hooks/useAgents.ts`, `hooks/useRunStream.ts`, `hooks/useNavBadges.ts`,
`lib/runAguiStream.ts`, `lib/notificationLink.ts`. Polling and the `['agent-run-agui']` cache rule
are in `.claude/rules/ui.md`.

## Runs are durable rows, never client state

- `POST /api/agents/runs` answers 202 with the row and the page navigates to `/agents/runs/:id`;
  `RunPage` renders `GET /runs/:id` (row + `events` + `interrupts` + `artifacts`, reconciled
  server-side). A `deduplicated: true` 202 is a SUCCESS (an exclusive agent already had an active
  run — toast, open that run); 503 `agent_runs_not_configured` is the modal's business
  (`isAgentRunsNotConfigured` → `EmptyState` naming `AGENT_RUN_WORKFLOW`, no toast); everything
  else re-toasts. The UI never sends `?strict=1`.
- **Freshness = nudge + poll.** The family root `['agent-run']` (`queryKeys.agentRuns`) is the
  `entity` of the server's `entity.changed` nudge, so `WebSocketProvider` already covers it — no
  hook watches the socket or the store. `useAgentRun`/`useAgentRunRow` poll `RUN_POLL_MS` while
  **`runOwesAnswer`**, `useAgentRuns` while any listed row does; `runPollInterval(status)` is the
  pure decision (unit-tested) — don't fight `refetchInterval` with fake timers.
- **`runOwesAnswer` (`queued || running`) is NOT `isRunActive`** (which includes
  `awaiting_input`). Point a poll or a pulse at `isRunActive` and a parked run is re-fetched every
  3 s, and announced by `RunStatusBadge`'s `aria-live`, for the length of
  `AGENT_INTERRUPT_TIMEOUT`. `isRunActive` drives exclusivity copy and "can this still be
  cancelled/steered"; `runOwesAnswer` drives freshness.

## Timeline (`RunPage.tsx` + `run/**`)

- **Everything it decides is decided in `run/timeline/timelineModel.ts`, which is pure**
  (`tests/config/run-timeline.test.ts`): `buildTimeline(events)` → rows, `groupTimeline(rows)` →
  stage groups, then `selectArtifacts`, `selectPendingInterrupts`, `selectWorkStats`,
  `defaultExpanded`, `windowGroups`. **Everything the right pane shows that is not `run.output` is
  a selector over those same rows — never a second fetch.**
- Load-bearing: `at` is the tool call's START (`endedAt`/`durationMs` are separate — never
  overwrite `at` with the answer); the reducer is **idempotent under duplicated events** (dedup by
  `event.id` — a stream and a fetch can deliver the same row); a step row carries `endedSeq`
  (a `done` merges into its `running` row; without it a settled run's trailing rows are swallowed
  by the last stage).
- Grouping: a `running` step opens, non-step rows attach, its `done` closes, a different key
  implicitly closes (an unclosed step is real, shown spinning); `__preamble__` / `__tail__` hold
  the loose stretches. Expansion is `defaultExpanded` XOR the reader's toggles, keyed by
  `headerId`, so a live run never reopens a group somebody closed.
- Long runs **window (`TIMELINE_WINDOW_GROUPS` = 40 from the end), never virtualise**.
  `useStickToBottom` fires only when the reader is at the bottom AND the last row id changed, and
  needs a REAL scroll container: from `lg` up the list is `overflow-y-auto` under a
  viewport-relative `max-h` (without it `scrollIntoView` moves the page). Below `lg` the bound is
  dropped on purpose; the "Jump to latest" pill is absolutely positioned over the scroller.
- **The column split is `runLayout(status, override)`, pure, beside the model** — timeline-major
  while active, output-major once settled, **and the reader's override wins permanently** (a run
  settling mid-read must never swap the columns). The flip chevron is a CHILD of the timeline panel
  on its own right edge — never absolutely positioned over the grid at a percentage (that ignores
  the gutter). The minor column stays narrow but readable, never collapsed to a rail.

## Tool results

- **Do not write tool-result parsers.** `documentCardsFromToolResult(name, result)` in
  `@rocketflare/shared/ai/embeddings` is the one mapper (chat stream, AG-UI projection, persisted
  message, `run/timeline/toolResults.tsx`); in the timeline it renders as `DocumentLink`
  one-liners, not cards. Every other tool keeps `<details><pre>` truncated at
  `TOOL_RESULT_MAX_CHARS` — a 200 KB result in the DOM is a real hang.
- An agent should not emit tool frames for its TERMINAL tool: that call is the answer, which the
  Output tab already renders.
- `text` renders via `components/ai/Markdown`, which is why `pages/agents/**` is lazy (one shared
  `Markdown-*.js`; `RunPage-*.js` its own chunk). `components/ai/StatRows.tsx` (`Row`, `Section`,
  `formatCost`, shared with the chat inspector) lives in `components/ai/` for the same reason.

## Action panel (`run/ActionRequiredPanel.tsx`, `run/interrupts/*`)

- Pinned ABOVE the timeline, unmounted the moment the run leaves `awaiting_input`. Kind dispatch
  is an exhaustive `switch` over the shared union, so a new kind is a type error until it has a
  branch.
- **409 is information** (`isInterruptNotPending` → `alert-info`, "Someone else answered this",
  refetch — no toast, no red); **expiry ticks at the rate `expiryState` chooses**
  (`run/interrupts/expiry.ts`); **a non-approver sees one sentence, not disabled buttons**; **focus
  lands on the heading, never Approve**.
- No optimistic write. Validation is `interruptPayloadSchema(spec)`, the same function the route
  applies; the answer is `status: 'resolved' | 'cancelled'` — **there is no `approved` boolean
  anywhere**.

## Input, output, forms

- **The input is ONE block above both columns, not a tab** (`run/RunInputSummary.tsx` over the pure
  `run/inputSummary.ts`): labelled values via the SAME `fieldsFromJsonSchema`, per-value "Show
  more". It falls back to the JSON **whole** — never per field — when the schema is outside the
  closed set or the input carries an undeclared key (labelling the rest would hide it).
- **The right pane is `URLTabs` (`?tab=output|artifacts|usage`); `run.error` sits above it,
  always — a failure is not a tab.** `outputs/` mirrors `forms/`: `outputFor(agentKey) → { schema,
  Component, artifacts? }`, so **an agent is one shared input schema + one `forms/` entry + one
  `outputs/` entry** and no component branches on an agent key. Artifacts come from the table,
  ordered by their event rows, `outputFor().artifacts?.()` the fallback for an agent that declares
  none. Usage shows the run's timestamps (requested, by whom, started, finished) — only DURATION
  in the header — and **says in words** that model cost is not attributed per run, never `$0.00`.
- **One field renderer, two callers.** `fields/schemaFields.ts` is pure: `fieldsFromJsonSchema`
  supports a flat object of string / number / boolean / enum and **returns `null` for `$ref`,
  `allOf`/`anyOf`/`oneOf`, nested objects and arrays — the caller then falls back to the JSON
  textarea WHOLE, never per field** (a silently dropped required field is invisible until the run
  400s). `fields/FieldInput.tsx` + `FieldSet.tsx` serve the `form` interrupt kind and `formFor`'s
  middle rung. `submittableValues` drops empty optionals: `formValuesSchemaFor` is `.strict()`.
- **`formFor(agentKey)` → `{ initial, schema, Component }` is three rungs**: a registered form
  (`forms/index.ts`: `CORE_AGENT_FORMS` + every plugin's) → `schemaForm(agent.inputJsonSchema)` →
  `jsonForm`; the server's 400 `details` map back onto fields through the one `issues.ts`.
  Registered forms parse with the SAME schema the route applies (`summarizeTextInputSchema`,
  counted against `SUMMARIZE_TEXT_MAX_CHARS`; `research-topic` against `RESEARCH_TOPIC_MAX_CHARS`).

## Live progress is ADDITIVE

- `lib/runAguiStream.ts` (`streamRunAgui`, GET `/api/agents/runs/:id/agui/stream` →
  `{ lastSeq, received, terminal, aborted }`; **reconnect lives in the hook, not the transport**)
  and `useRunStream(runId, { enabled })` → `{ events, isLoading, connected, fallback, lastSeq,
  terminal }`; `streamEnabled(status)` is false for `awaiting_input`. Deleting the hook must leave
  a working page — it is built against the poll path.
- **The stream is the ONLY writer of `['agent-run-agui', id]`, appends with `setQueryData`, never
  touches the run row, and invalidates `queryKeys.agentRuns.all` exactly once on a terminal
  frame** — a terminal status is never synthesised client-side. The cursor moves only on a frame
  with an `id:` (the last of a row's group), so a mid-group drop replays the group whole. After
  `RUN_STREAM_FALLBACK_ATTEMPTS` empty connections it gives the key a `RUN_POLL_MS`
  `refetchInterval`.

## Cancel, steer, finding what is waiting

- **Leaving the page never touches the run**; Cancel is the explicit button (`POST …/cancel`, while
  `isRunActive`). Once `cancelRequestedAt` is set it stays ENABLED as "Force cancel" (the server
  terminates the Workflow instance and settles the row). `SteerComposer` posts `POST …/steering`
  while active; the note is an event row. Requested-by is "You" / short id / "system".
- The runs table's filters live in `useSearchParams` (`/agents?awaiting=1` has a chip), and every
  row is a real `<Link>`. The SideNav badge is `NavItem.badgeKey`/`badgeTone` resolved by
  `useNavBadges()` inside `SideNav`, fed by `GET /interrupts?status=pending&pageSize=1` under
  `['agent-run','awaiting']` (`useAwaitingInterruptCount`) — never polled.
- `lib/notificationLink.ts` maps a notification's `type` + `data` to a path (unknown → `null`), for
  BOTH `NotificationsBell` and `/notifications`, so a parked run's bell entry opens the run.

## Tests

- `tests/ui/`: `agents-page`, `run-page`, `run-stream`, `run-agent-modal`, `sidenav` (badge +
  collapsed dot), `agent-form-summarize-text`, `agent-output-summarize-text`. `run-page` mounts
  `RunPage` on the real `/agents/runs/:runId` route inside `WebSocketProvider` with the `FakeSocket`
  from `websocket-provider.test.tsx`, proving the nudge refetches AND leaves `['agent-run-agui']`
  alone. Mount `AgentsPage` inside the same `<Routes>` pair `App.tsx` uses so
  `navigate('/agents/runs/:id')` really lands on `RunPage`.
- Pure halves in the `config` project: `tests/config/run-timeline.test.ts` (reducer, grouping,
  `runLayout`, `summariseInput`, `expiryState`, `fieldsFromJsonSchema`).

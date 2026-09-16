---
version: unreleased
previous: 0.3.0
date: null
breaking: false
migrations:
  - "agent_runs.status gains awaiting_input (a text column, so no DDL in this entry)"
areas: [shared, api, ui, docs]
touches_surfaces: [feature-agents]
requires_surfaces: [feature-agents]
manual: false
---

## What changed

**Agent runs are getting human-in-the-loop interrupts, live streaming and a run workspace**
(issues #17 and #7). This entry accumulates across the work; later phases extend it rather than
adding a second note.

### Phase 1 — contracts (appends only, nothing renamed)

An agent run may now suspend mid-run and wait for a person ("send this email?", "which of these
three customers?") and resume on their answer. Phase 1 lands the vocabulary; nothing reads it yet.

`packages/shared/src/ai/`:

- **`interrupts.ts` (new)** — `AGENT_INTERRUPT_KINDS` (`approval · choice · input · form`, a closed
  set), the typed `spec` union, the four payload schemas, `interruptPayloadSchema(spec)` (the ONE
  validator the route and the UI both call, so a green client-side pass can never become a 400),
  `formValuesSchemaFor`, `INTERRUPT_REJECTION` (a declined **approval** stops the run; every other
  decline is an *answer* that goes back to the model), `AGUI_REASON_FOR_KIND` / `aguiReasonFor`,
  `agentRunInterruptSchema` (the row, with a **mandatory `key`**), `resolveInterruptRequestSchema`,
  the inbox query/item, and steering (`createSteeringNoteRequestSchema`, `steeringNoteDataSchema`,
  `STEERING_MAX_CHARS`).
- **`artifacts.ts` (new)** — `AGENT_ARTIFACT_KINDS` (`document · file · markdown · table · json`),
  `agentArtifactDataSchema` (`document`/`file` carry **ids, never content**), `agentArtifactSchema`
  whose `key` is the upsert key, and the thin `artifact` event-row payload. Size caps live in the
  contract: anything bigger belongs in R2 as a `file` artifact.
- **`agents.ts`** — `'awaiting_input'` appended LAST to `agentRunStatusSchema`;
  `ACTIVE_RUN_STATUSES` (`queued · running · awaiting_input`, what `isRunActive` now reads) and
  `CLAIMABLE_RUN_STATUSES` (`queued · running`, deliberately narrower); four new
  `AGENT_RUN_EVENT_TYPES` (`interrupt`, `interrupt.resolved`, `steering`, `artifact`);
  **`AGENT_RESUME_EVENT = 'agent-resume'`** plus `WORKFLOW_EVENT_TYPE_PATTERN` and
  `MAX_INTERRUPT_ROUNDS`; `AgentMeta.approvers` and `agentInfoSchema.inputJsonSchema`;
  `agentRunWithEventsSchema` gains `interrupts[]` / `artifacts[]`; the `RUN_STREAM_*` constants; and
  the previously *conventional* event payloads (`tool.*`, `text`, `status`, `error`) promoted into
  real schemas collected in `AGENT_RUN_EVENT_DATA`.
- **`agui.ts`** — four kit CUSTOM events (`kit.agent.interrupt`, `kit.agent.interrupt.resolved`,
  `kit.agent.steering`, `kit.agent.artifact`) and `toAguiInterrupt(row)`. `kitAguiEventSchema`
  needed **no change**: `RunFinishedEventSchema` already validates an interrupt `outcome`, and
  `RunAgentInputSchema` already carries `resume[]` — the pause and the answer are AG-UI's own.
- **`errors.ts`** — `interrupt_not_pending` (409) and `run_not_awaiting_input` (409).

Two things worth knowing before building on this:

- **The `@ag-ui/proto@0.0.59` round trip was measured, not assumed.** `RUN_FINISHED` with an
  interrupt outcome survives protobuf intact, so `PROTO_UNSUPPORTED_EVENTS` stays a type list and
  no `kit.` CUSTOM fallback is needed. The outcome discriminator is **`'interrupt'`, not
  `'interrupted'`**, and getting it wrong does not throw — the encoder logs a warning and writes a
  frame with the outcome silently dropped. Assert on the DECODED value, always.
- **`'agent-resume'` has a hyphen on purpose.** Cloudflare Workflows event types allow only
  letters, digits, `-` and `_`; a `.` fails with `workflow.invalid_event_type`. Nothing in a Node
  suite catches that — `createFakeWorkflowStep` never validates the name — so it would first
  surface as a parked run that can never be resumed, in production, on the first approval anyone
  ever gives. `WORKFLOW_EVENT_TYPE_PATTERN` and a test in
  `apps/web/tests/config/agent-interrupts.test.ts` are the guard.

## How to apply

Take the four `packages/shared/src/ai/` files and `errors.ts` as written — they are appends, so a
copy that renamed its scope only needs the import specifier translated. Then three small knock-ons
that keep the workspace compiling; each is one edit:

1. `apps/web/src/db/schema/agent-runs.ts` — append `'awaiting_input'` to
   `AGENT_RUN_STATUS_VALUES`. **No migration**: the column is `text`, which is exactly why it is
   `text`. (The partial unique index `agent_runs_active_exclusive_idx` still names only
   `('queued','running')` — widening it is a later entry, and until then a parked run does *not*
   hold the exclusive slot.)
2. `apps/web/src/api/routes/agents.ts` — `GET /runs/:id` builds an `AgentRunWithEvents`, which now
   has `interrupts` and `artifacts`. Pass `[]` for both until the tables exist.
3. Any `Record<AgentRunStatus, …>` in your own UI gains an `awaiting_input` arm; the kit's two
   (`AgentsPage`, `RunStatusBadge`) use the label "Waiting for you" and the stylesheet's existing
   `awaiting-review` warning tone.

An app with its own agents may set `approvers: 'admin'` on an `AgentMeta` now; it is inert until the
routes land.

## Conflicts to expect

`packages/shared/src/ai/agents.ts` is the one file with several separate hunks (imports, the status
enum, the event-type list, the event-payload block, `agentRunWithEventsSchema`, and two new
constant sections). An app that added its own statuses, event types or agent metadata will have to
place them by hand. `apps/web/src/ui/pages/agents/*` is likely to be rejected in a copy that has
restyled the run list; the compiler names every missing arm, so take the type error as the checklist.

## Verify

`pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Specifically:
`apps/web/tests/config/agui-contract.test.ts` proves the interrupt outcome round-trips over **both**
SSE and protobuf and that `resume[]` parses, and
`apps/web/tests/config/agent-interrupts.test.ts` proves `AGENT_RESUME_EVENT` is a legal Workflows
event type, the rejection semantics, and the four payload validators.

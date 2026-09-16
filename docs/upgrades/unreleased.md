---
version: unreleased
previous: 0.3.0
date: null
breaking: false
migrations:
  - "agent_runs.status gains awaiting_input (a text column, so no DDL for the column itself)"
  - "two new tenant tables for the asks an agent makes and the artifacts it produces, each with an RLS policy"
  - "the partial unique index that guarantees one active run per (tenant, agent) is dropped and recreated with a wider predicate"
  - "ai_usage gains a nullable run reference, set null on delete"
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

### Phase 2 — schema and migration `0011`

Two tables, one widened index, one column that could never be added later, one `[vars]` key.

- **`agent_run_interrupts`** — one row per question a run asked a person. `id` **is** the AG-UI
  `Interrupt.id`; `spec` is a typed jsonb column (`AgentInterruptSpec`) rather than an untyped
  `metadata` blob, because the panel that draws the question has to know it is drawing a `choice`
  with these options. **`UNIQUE (run_id, key)` is the whole point**: a retried `execute` step
  re-enters the agent from the top and asks again, and the index is what makes the second ask find
  the first ask's ANSWER instead of opening a question nobody will ever see. `status`
  (`pending → resolved | cancelled | expired`) is the decision and every settle is a compare-and-set
  on `pending`, which is what makes "two people answer at once → one 200, one 409" true.
  `runId` is the only host-specific column: giving chat the same machinery later is a nullable
  `conversationId` sibling plus `CHECK (num_nonnulls(run_id, conversation_id) = 1)`.
- **`agent_run_artifacts`** — what a run produced, keyed `(run_id, key)` as an UPSERT so a redraft
  replaces itself. A table and not an event type because an artifact is mutable, queried across runs
  and outlives the run; a steering note is the opposite of all three and stays an `agent_run_events`
  row. `document` and `file` artifacts carry **ids, never content** — those bytes already sit behind
  routes that enforce tenancy and group visibility.
- **`agent_runs_active_exclusive_idx` is dropped and recreated** with the predicate
  `status IN ('queued','running','awaiting_input')`, rendered from `ACTIVE_RUN_STATUSES` rather than
  typed out, so the index and the shared list cannot drift. **A run parked on a human is still *the*
  active run for that agent** — leave the predicate alone and a second enqueue slips past the
  exclusive guarantee while the first one waits for an answer. Note this is wider than
  `CLAIMABLE_RUN_STATUSES`, which the claim step still reads: the three lists diverge on purpose.
  The `CREATE UNIQUE INDEX` is non-concurrent and takes an `ACCESS EXCLUSIVE` lock; `agent_runs` is
  small, so this is fine — but on a large table, say so before running it.
- **`ai_usage.agent_run_id`** — nullable uuid, `ON DELETE SET NULL`. Per-run cost is not
  attributable today and **cannot be backfilled later**, which is the same argument
  `costMicrocents` already makes. One column now or never; nothing writes it yet.
- **`AGENT_INTERRUPT_TIMEOUT = "168 hours"`** in `config.ts`, `.dev.vars.example` and `[vars]` of
  **both** tomls. It is consumed verbatim as `step.waitForEvent`'s `timeout`, so it must be a
  Workflows duration string, not a number of seconds. Workflows allows 1 second to 365 days and a
  `waiting` instance does not count toward concurrency, so parking is free — but **instance
  retention is 30 days on Workers Paid and only 3 days on Free**, and past retention the instance is
  gone and the resume event can never arrive. Keep it under 3 days if you are not on Paid.

### Phase 3 — the runtime

The machinery: an agent can now ask, suspend and resume. Nothing is reachable from a route yet
(phase 5) and no shipped agent uses it (phase 8), so this phase changes no existing behaviour —
every addition is inert until something calls it.

**`services/ai/kit.ts` — the gate lives in the tool loop, never in a handler.** `Tool` gains
`requiresApproval` / `requiresApprovalWhen` / `approvalMessage` / `allowEdits` / `onReject`, and
`runToolLoop` gains `approvals`, `onInterrupt`, `runApproved` and `beforeTurn`, plus
`stopReason: 'interrupt'`. Four things about it are worth reading before changing it:

- **The gate scans the WHOLE turn**, after the assistant message is pushed and before any handler
  runs. A turn with three calls and one gate parks with *nothing* executed, so resuming has only
  the approved call to make idempotent — and it produces the plural `interrupts[]` that AG-UI's
  `RunFinishedInterruptOutcome` already models.
- **`resumePendingToolCalls` runs before the `while`**, because a parked checkpoint's last message
  is an assistant turn with unanswered `tool_use` blocks, and sending one of those is a 400 on
  Anthropic and garbage everywhere else. Without it there is no resume path at all. It answers them
  through **the same `executeToolUses`** the in-loop path uses: two copies of the approval rules is
  how a gate ends up bypassed on the resume path only, which is the path nobody exercises by hand.
- **`runHandler` rethrows `InterruptRequested` and only that.** Raising an interrupt inside a tool
  handler is the natural place to ask ("which of these three customers?"), and `runHandler` turns
  every other throw into an `isError` result — so without the rethrow the model is simply told the
  tool failed and asks again, forever. `runStreamingChat` deliberately does **not** get the same
  rethrow: chat has no host that can park a turn, so an interrupt there is a bug we want visible.
- **`appendUserText`** folds a note into a trailing user turn instead of opening a second one. Two
  consecutive user turns is a 400 from Anthropic, and it is exactly what naive steering produces,
  because a resumed transcript usually ends in a user turn of `tool_result` blocks.

A note on the shape: `requiresApproval` is a boolean **and** `requiresApprovalWhen` is a method,
rather than one `boolean | ((input) => boolean)` member, because a function in property position is
contravariant in `Input` under `strictFunctionTypes` and a `Tool<{ to: string }>` has to be able to
sit in a `Tool[]`. `handler` already uses method syntax for the same reason.

**`services/agents/interrupts.ts` (new)** — `requestInterrupt` (**create-or-read on
`(run_id, key)`**: a resumed `execute` re-enters `run()` from the top, so this is what makes the
second ask find the first ask's ANSWER), `listInterrupts`, `resolveInterrupt` (**one** compare-and-set
on `pending`, which is what makes "two people answer at once → one 200, one 409" true),
`expireInterrupts`, `approvalsForRun` (settled asks keyed by `toolCallId`; an `expired` ask reads as
a decline, because parking on a question that can never be answered is worse than a refusal), and
`parseDurationMs` / `interruptExpiryFrom`. `reason` is only ever written by `aguiReasonFor` and
`responseSchema` is DERIVED from `interruptPayloadSchema(spec)` — a hand-written copy of a validator
is a second validator.

**`services/agents/artifacts.ts` (new)** — `upsertArtifact` on `(run_id, key)`, which is why a
redraft replaces itself and why calling it again on a retry is safe.

**`services/agents/runs.ts`** — five surgical changes plus the restart:

- `ACTIVE` is now the imported `ACTIVE_RUN_STATUSES` (so `settle()`, `findActiveRun` and
  `saveCheckpoint` all widen to `awaiting_input` — a parked run must stay cancellable and must keep
  holding its exclusive slot) while `claimRun` alone reads `CLAIMABLE_RUN_STATUSES`.
- **`parkRun` is not a `settle()`.** `finished_at` stays NULL and **the checkpoint survives**, which
  is the whole reason a resume is cheap; `settle()` nulls it, correctly, for a terminal run.
- **`resumeRun` is the transition the answer performs.** The resolve route flips
  `awaiting_input → running` *before* it nudges, which is what lets `claimRun` keep its narrow
  predicate: a restarted instance's `claim` succeeds only because somebody answered.
- `requestCancel` treats `awaiting_input` like `queued` — settle outright, expire the asks, and
  best-effort wake the sleeping instance so it reads a settled row instead of holding a seven-day
  `waitForEvent`.
- **`nudgeOrRestartInstance`** — `sendEvent`, and on `instance.not_found` a NEW instance
  `<runId>-r1`, `-r2`… (hyphen, not colon: a colon is not a documented-legal instance-id character).
  An instance disappears for ordinary reasons — a `wrangler dev` restart, or retention expiring —
  and without this branch an answered run could never be resumed, which is the worst outcome this
  feature has. **`agent_runs.instanceId` is therefore *the latest* instance, not "the run id"**;
  `docs/CONCEPTS.md` §9 is corrected in the same commit.
- **`appendEventAtomic`** computes `seq` in SQL with one retry on `23505`, for a writer (a steering
  route) racing a step's in-memory emitter; **`claimEffect`** replays a *decision* where `runOnce`
  replays a *result* — which is what once-only delivery needs.
- `reconcileRun` gains an explicit `case 'waiting': return run`. The default arm already did this;
  saying it is the difference between correct-by-accident and correct-on-purpose, and `waiting` is
  the one runtime status that looks idle and is not.
- **`expireParkedRun`** is the read-path net for a park whose instance is gone: all asks past their
  deadline → `cancelled` with `error` NULL. A park with **no pending asks is left alone**, because
  that is the window between the answer and the resume, not an impossible state.

**`services/agents/registry.ts`** — `AgentContext` gains `interrupt(ask)`, `steering()`,
`artifact(input)` and `approvals`. `ctx.interrupt`'s doc comment carries the three obligations:
`key` must be stable across attempts; everything after the call is **on the far side of a Worker
deploy**, so side effects go behind `ctx.once`; and rejection differs by kind.

**`services/agents/runtime.ts`** — `ExecuteOutcome.status` widens to `awaiting_input` (a real
`AgentRunStatus`, not a second vocabulary word), and two catch arms sit above the generic
classification. **The order inside the park arm is the safety property**: rows first, then
`parkRun` — *a row with no parked run re-asks on the next attempt; a parked run with no row is a
hang.* Then one `interrupt` event per row, `notifyApprovers` behind `claimEffect('notify:<id>')`
(the requester, or the tenant's admins for `approvers: 'admin'` and for a run with no requester —
a parked run nobody is told about is a hung agent), and a `status: awaiting_input` event.
`InterruptDeclinedError` settles `cancelled` with **`error` NULL** and the reason on the event row:
a refusal is a status, not a message. **`isRetryableRunError` answers `false` for both new types**,
or a step retry re-asks somebody who has already said no.

Test harness: `RecordingWorkflow.sendEvent` now records instead of no-opping, and
`notFoundOnSendEvent` drives the restart path.

### Phase 4 — the Workflow loop

`AgentRunWorkflow` stops being three steps and becomes a loop. It is a small diff and two of its
lines are the whole feature.

```
claim → execute#0 → [ resume#0 → execute#1 → resume#1 → … ] → finish
                      └ or expire#N when nobody answers
```

- **Every step name carries its round.** A Workflow step name is its identity to the platform: call
  `step.do('execute')` twice and the second call hands back the FIRST one's cached result. Inside a
  loop that is not a small bug — the run replays the turn that asked the question, parks again, and
  the whole thing reads as *"the agent ignored my approval"*. Hence `execute#N`, `resume#N`,
  `expire#N`.
- **`resume#N` is `step.waitForEvent(AGENT_RESUME_EVENT, { timeout: AGENT_INTERRUPT_TIMEOUT })`**,
  and **its payload is deliberately ignored**. The answer is already a row, written by the resolve
  route before it woke the instance; the event is a nudge, and the next `execute#N+1` re-enters
  `run()` from the top and reads it. That is what makes the restart fallback work at all: an
  instance created from scratch has no event to replay and does not need one.
- **The `try/catch` around `execute` moved inside the loop and clears `outcome`.** Letting a
  previous round's `awaiting_input` fall through to `finish` would tell it the run is parked when it
  is not.
- **`MAX_INTERRUPT_ROUNDS` (32)** bounds the loop. A correctness guard, not a capacity one — the
  step budget is 10,000 and a round is two steps — for the agent that asks the same question
  forever. It settles `failed` with a sentence, because a runaway agent is a bug.
- **`finishStep` gains a second arm, and the first one did NOT change.** The failure backstop stays
  `queued | running`: widen it to `ACTIVE_RUN_STATUSES` and every legitimately parked run becomes a
  `failed` row. The new arm is for a row that is still `awaiting_input` *when the workflow is
  ending* — nothing can wake it now — and settles **`cancelled` with `error` NULL**, the reason on a
  `status` event row. A cancel is a status, not a message. The single exception is the abandoned
  park above, which arrives carrying `outcome.status === 'failed'`; it is the OUTCOME that decides,
  never the row.

Test harness: `createFakeWorkflowStep()` used to throw on `waitForEvent` and is now a recorder —
`{ step, calls, waits, names, queueEvent }` plus `{ events?, onWait? }`. `onWait` is the test's
stand-in for the resolve route (write the answer, flip the row, return a payload); an empty queue
with no `onWait` rejects the way the platform's timeout does. `names` is every step name in call
order, `do` and `waitForEvent` alike, which is how "distinct per round" is asserted.

### Phase 5 — routes, permissions and the projection

The loop from phase 4 is now reachable from outside. Until this landed,
`nudgeOrRestartInstance` had no caller, which means a parked run could never be resumed — so this
phase is the one that makes the feature *exist* rather than merely compile.

**`/api/agents` gains three routes and two answers:**

| Route | Guard | Notes |
|---|---|---|
| `POST /runs/:id/interrupts/:interruptId` | `update AgentRun` + the agent's `approvers` | the eight steps below |
| `POST /runs/:id/steering` | same as cancel | `appendEventAtomic` + nudge; **409 on a settled run** |
| `GET /interrupts?status=pending` | `read AgentRun` | the inbox, paginated, joined to its run |
| `GET /runs/:id` · `/agui` | unchanged | now carry real `interrupts[]` / `artifacts[]` |
| `GET /runs/:id?events=0` | unchanged | the bare row, for a client tailing the events elsewhere |

**The resolve handler is eight steps and the ORDER is the design** — each is a precondition for the
next. (1) the run must exist and be visible → 404; (2) the caller must be an approver → 403; (3) the
ask must belong to that run → 404; (4) the answer validates against `interruptPayloadSchema(spec)` →
400; (5) `resolveInterrupt` is one compare-and-set → null is **409 `interrupt_not_pending`**, which
is what makes two people answering at once *one 200, one 409, one side effect*; (6) an
`interrupt.resolved` row through `appendEventAtomic` (a steering write can race a step's emitter for
`seq`); (7) **only when nothing is still pending**, `resumeRun` and then `nudgeOrRestartInstance`; (8)
activity, nudge, 200.

Two of those repay a second reading:

- **Step 7 is where T4 is fixed.** `resumeRun` flips `awaiting_input → running` **before** the
  instance is woken — *the answer IS the transition* — and that is the only reason a restarted
  instance's `claim` step, whose predicate is the narrow `queued | running`, finds anything at all.
  It also must not fire early: a turn with three gated calls parks **once** and needs all three
  answers, so resuming on the first would re-enter the loop with questions still open.
- **Step 4 refuses `editedInput` unless the ask offered it** (`tool.allowEdits`) and then re-checks
  the edit against the tool's stored JSON Schema (`checkEditedToolInput`) — *a client that can edit
  tool arguments is a client that can call anything*. That check is defence in depth, not a JSON
  Schema implementation: `runHandler` still re-parses the input with the tool's real zod schema
  immediately before the handler runs.

**Permissions add no CASL action and no subject.** `canAnswer` is the `update AgentRun` the route
already guards **plus** `AgentMeta.approvers`: `'requester'` (the default) is exactly the predicate
`visible()` already implements, so there is one mental model rather than two, and `'admin'` is the
opt-in for agents that touch money, customers or deletion. A member under `approvers: 'admin'`
**sees** their own run's ask in the inbox (`canAnswer: false` travels per item) and gets a 403 on
answering; the UI renders it read-only. An app wanting approvals on its own axis adds its **own**
subject.

**`expireParkedRun` is now wired onto the read path, beside `reconcileRun`** (T6). They answer the
same question for the two halves of "active": `reconcileRun` settles a `queued`/`running` row whose
instance is gone, and `expireParkedRun` settles an `awaiting_input` row whose asks have all passed
their deadline. Without it a park whose instance died — a `wrangler dev` restart, retention expiring
— holds the exclusive slot for ever.

**The projection takes the rows it was missing.** `projectRunToAgui(run, events, { interrupts,
artifacts })` — still pure, still "the event row ids ARE the AG-UI ids", it just needs the two
tables, because the log records *where* an ask appeared while the table records *what became of it*.

- Every run now emits a **`STATE_SNAPSHOT` right after `RUN_STARTED`** carrying
  `capabilities.humanInTheLoop`. A client reads that before it renders anything, so `POST
  /api/agui/run`'s snapshot declares `humanInTheLoop: { supported: false }` until chat HITL lands —
  lying there is how a client draws an approve button that does nothing.
- A run `awaiting_input` **with** pending asks ends in `RUN_FINISHED { outcome: { type:
  'interrupt', interrupts } }` — AG-UI's own delivery, which is what lets a third-party client answer
  a kit run with zero kit-specific code. With **no** pending asks it emits no terminal event: that
  state is the window between the resolve write and `resumeRun`, and it is reachable, not impossible.
- `interrupt` / `interrupt.resolved` / `steering` / `artifact` rows project as the four
  `kit.agent.*` CUSTOM events. A row whose table entry was not passed is **skipped, not invented**.

Nudges: answering emits the usual `entity.changed { entity: 'agent-run' }` plus a new
`entity: 'agent-interrupt'`, so an inbox badge can refresh without subscribing to every progress row
the runtime writes.

**Notification on park needs nothing new here** — phase 3's `notifyApprovers` already runs inside the
`execute` step, awaited (a Workflow step has no `waitUntil`), through `notifyMany` even for one
recipient, behind `claimEffect('notify:<interruptId>')`, and falls back to the tenant's admins for an
`approvers: 'admin'` agent **or a system-triggered run with no requester** — a parked run nobody is
told about is a hung agent.

## How to apply

Take the four `packages/shared/src/ai/` files and `errors.ts` as written — they are appends, so a
copy that renamed its scope only needs the import specifier translated. Then three small knock-ons
that keep the workspace compiling; each is one edit:

1. `apps/web/src/db/schema/agent-runs.ts` — append `'awaiting_input'` to
   `AGENT_RUN_STATUS_VALUES`. **No DDL for the column**: it is `text`, which is exactly why it is
   `text`. The index predicate beside it *does* change (phase 2 above).
2. `apps/web/src/api/routes/agents.ts` — `GET /runs/:id` builds an `AgentRunWithEvents`, which now
   has `interrupts` and `artifacts`; phase 5 fills them from the tables.
3. Any `Record<AgentRunStatus, …>` in your own UI gains an `awaiting_input` arm; the kit's two
   (`AgentsPage`, `RunStatusBadge`) use the label "Waiting for you" and the stylesheet's existing
   `awaiting-review` warning tone.

An app with its own agents may set `approvers: 'admin'` on an `AgentMeta`; phase 5 is what reads it.

Phase 4 touches two files an app is unlikely to have edited (`api/workflows/agent-run.ts` and
`finishStep`) plus the test mock. Take `agent-run.ts` whole. If your copy forked the Workflow class
— an extra step, a different `timeout` — port the loop by hand and **keep the `#${round}` suffix on
every step name inside it**; that is the one detail nothing in a Node suite can check for you.

Phase 3 is additive everywhere except three lines an app may have touched: the `ACTIVE` constant in
`services/agents/runs.ts` (now imported, and `claimRun` alone keeps the narrow list), `Tool` in
`services/ai/kit.ts`, and `AgentContext`. An app with its **own** `AgentContext` implementation — a
test double, most likely — gains four members it must provide. An app that copied `runToolLoop`
rather than importing it gets none of this and should re-take the file.

For phase 2, take the two new `apps/web/src/db/schema/` files, the `agent-runs.ts` index change, the
`ai_usage` column and the `[vars]` key, then run **your own** `pnpm db:generate` — never copy the
kit's `migrations/0011_*.sql`, because every `meta/*_snapshot.json` describes the whole cumulative
schema and yours has tables the kit has never heard of. Read what drizzle-kit emits before applying
it: a *changed* partial-index predicate is the case it is weakest on, and a `CREATE` with no `DROP`
silently leaves the old narrow index in place.

Phase 5 is mostly additive inside `apps/web/src/api/routes/agents.ts` (three new routes, two helpers
and a shared `loadRun`), so a copy that restyled its agent routes should take the new blocks and keep
its own. Two edits are NOT additive and are easy to miss when resolving by hand: `GET /runs/:id` and
`/agui` must both go through `loadRun` so `expireParkedRun` runs on read, and
`projectRunToAgui` now takes a third argument — a call site that omits it still compiles, and
silently drops every ask and artifact from the timeline. If your UI asserts on the AG-UI sequence of
a run, note that **`STATE_SNAPSHOT` is now the second event of every projection**.

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
event type, the rejection semantics, and the four payload validators;
`apps/web/tests/api/rls-coverage.test.ts` proves both new tables are policied;
`apps/web/tests/config/wrangler-parity.test.ts` proves `AGENT_INTERRUPT_TIMEOUT` is in both tomls.
For phase 3, `apps/web/tests/api/agent-tool-loop-interrupt.test.ts` proves the gate raises **before**
any handler runs, that the resume path answers pending calls through the same code, and that a
handler-raised interrupt propagates; `apps/web/tests/api/agent-interrupts.test.ts` proves a park
keeps its checkpoint with `finished_at` NULL, that a re-entered `execute` finds its own earlier ask,
that a declined approval cancels with a NULL error, that a steering note is delivered once across a
park and resume, and that `sendEvent → not_found` creates `<runId>-r1`.
For phase 4, `apps/web/tests/api/agent-run-workflow.test.ts` proves the step names are distinct per
round, that a resume re-enters `execute` and the run completes, that an unanswered park times out to
`cancelled` with a **NULL `error`**, that `MAX_INTERRUPT_ROUNDS` stops a runaway agent cleanly, and
that `finishStep` does not fail a parked row. `waitForEvent` itself only runs on the platform — the
`wrangler dev` walkthrough is the acceptance test for the durable park.
For phase 5, `apps/web/tests/api/agent-interrupt-routes.test.ts` proves the 409 on a double answer,
the 403 for a member under `approvers: 'admin'` (who still sees the ask, `canAnswer: false`), the 404
for another member's and another tenant's run, the 400 for `editedInput` without `allowEdits` and for
an edit that does not fit the tool's schema, that a second enqueue while parked deduplicates, that
cancelling a park expires its asks, that steering a settled run is a 409, and — end to end —
**`sendEvent → not_found` → `<runId>-r1` → and the run then completes**, which is the whole T4/T5
path including a restarted instance's `claim`. `apps/web/tests/api/agui-projection.test.ts` proves
the capability snapshot, the interrupt outcome, the empty-pending park and the four `kit.agent.*`
events.
After migrating, the index predicate should read
`WHERE status = ANY (ARRAY['queued','running','awaiting_input'])` in `pg_indexes`.

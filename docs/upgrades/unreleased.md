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
areas: [shared, db, api, ui, config, docs]
touches_surfaces: [feature-agents, example-agent-summarize-text, example-agent-research-topic]
requires_surfaces: [feature-agents]
manual: false
---

## What changed

**An agent run can now stop and ask a person, resume on their answer, and be watched live on a
page of its own** (issues #17 and #7).

Before this the agent layer was durable and correct but fire-and-forget: a run succeeded, failed or
was cancelled, and there was no third answer. That ceiling is what stopped the kit shipping an agent
that does anything consequential — *send this email? delete these rows? which of these three
customers did you mean?* A run now suspends durably on `step.waitForEvent`, costs nothing while it
waits, and carries on when somebody decides. The surface moved with it: a run was a modal over the
runs table, filling in 3-second poll lumps, which is the wrong home for something a person is asked
to **act** on, arrives at from a notification, and may leave and come back to.

The sections below are in dependency order — contracts, schema, runtime, workflow, routes, stream,
UI, examples — which is also the order to port them in.

### The contracts (appends only, nothing renamed)

An agent run may now suspend mid-run and wait for a person ("send this email?", "which of these
three customers?") and resume on their answer. This is the vocabulary all of it is written in.

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

### The schema

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

### The runtime

The machinery: an agent can now ask, suspend and resume. Nothing is reachable from a route yet
(the routes, below) and no shipped agent sets it, so it changes no existing behaviour —
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

### The Workflow loop

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

### Routes, permissions and the projection

The loop above is now reachable from outside. Until this landed,
`nudgeOrRestartInstance` had no caller, which means a parked run could never be resumed — so this
is the step that makes the feature *exist* rather than merely compile.

**`GET /api/agents` now carries each agent's `inputJsonSchema`** — `listAgentInfo()` converts
`meta.inputSchema` with the same `toolInputSchema()` the tool loop uses, memoised per isolate. It is
an added field on an existing response, so nothing breaks by taking it; but two UI behaviours read
it and **silently degrade to a JSON box without it**, which is exactly how it shipped unpopulated
here: the run page's labelled input summary, and `formFor`'s middle rung (`schemaForm`), which had
therefore never fired in a running app. An app whose own agents have no hand-written form gets real
fields the moment it ports this. Field labels fall back to a humanised property name (`topic` →
`Topic`) because `zodToJsonSchema` emits no `title`; a schema that declares one still wins.

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

**Notification on park needs nothing new here** — the runtime's `notifyApprovers` already runs inside the
`execute` step, awaited (a Workflow step has no `waitUntil`), through `notifyMany` even for one
recipient, behind `claimEffect('notify:<interruptId>')`, and falls back to the tenant's admins for an
`approvers: 'admin'` agent **or a system-triggered run with no requester** — a parked run nobody is
told about is a hung agent.

### Live run progress (issue #7)

A run's timeline now fills in about 500 ms instead of three-second lumps, resumably, **without
holding a connection for a seven-day park**.

**`GET /api/agents/runs/:id/agui/stream`** (`api/services/agents/run-stream.ts`) tails
`agent_run_events` on one open connection and frames each new row as spec AG-UI. Measured against
what it replaces — every 3 s, `getRun` + `reconcileRun` (*a Workflow `instance.status()`
subrequest*) + `listEvents` returning every row unbounded — it is cheaper per unit of wall clock at
six times the resolution: one bounded, indexed `WHERE (tenant_id, run_id) AND seq > $cursor LIMIT
200` that usually returns nothing, plus the run row.

GET rather than POST because `csrf.ts` passes GET, `/api` is already in `run_worker_first` (**no
toml change**), and a third-party AG-UI client can then use a bare `EventSource` — which is the
only reason `Last-Event-ID` is honoured at all. **`?afterSeq=` wins when both are present**: the
kit's own client is explicit and a stale browser value must never override it.

Four rules, each of which is a bug if broken:

- **`id:` goes on the LAST frame of a row's group and on no other frame in it.** One row is not one
  AG-UI event — a `text` row is `START → CONTENT → END`. Put the cursor on the first frame and a
  drop mid-group leaves the browser's `Last-Event-ID` already past the row, the resume starts after
  it, and the client holds a text message that **never closes, for ever, with no error**. Replaying
  a whole group is free, because every id in it is derived from the row id.
- **A read-stream failure emits no `RUN_ERROR`** — a deliberate *inversion* of the chat rule, now
  written down in `.claude/rules/api.md`. `chat-turn.ts` is right to emit one: there the stream IS
  the run. Here the run is a durable Workflow in another isolate and is almost certainly fine, so
  the stream logs and closes silently. **Closing with no terminal event means "reconnect",
  uniformly** — redeploy, idle cap, duration cap, transport error, client abort.
- **`reconcileRun` runs exactly once, at open, never in the loop.** It is a Workflow subrequest per
  call; a ten-minute stream would spend ~1 200 of them on a question the tail already answers.
- **Protobuf has no cursor and no comments.** A binary client resumes by `?afterSeq=` only, and a
  `: ping` comment frame written into a binary stream is not a valid protobuf frame — it poisons
  everything after it.

**A parked run needed no code in the route.** The projector already returns
`RUN_FINISHED { outcome: { type: 'interrupt' } }` for `awaiting_input`, so the generic terminal
branch fires and the connection closes. A run parked for seven days therefore holds no connection,
no query and no invocation, and the page re-opens on the existing nudge when the answer lands —
which degrades exactly to the architecture that was already there.

**The projection became resumable** (`createRunProjector(run) → { head, push, finish }`, with
`projectRunToAgui` a fold over it and an equivalence test pinning the two together). `finish` takes
the run as an **argument**, not from the closure: in a stream the row changes underneath you.

**The tool-call pairing bug is fixed here.** `agui-projection.ts` keyed open tool calls by tool
**name** — harmless while the loop was sequential, catastrophic the day one turn makes two
`search_knowledge` calls, because the second start overwrites the first and *both* results are
attributed to the second call. The runtime now writes the model's `toolCallId` into the `data` of
both `tool.start` and `tool.end`, the projector keys on `data.toolCallId ?? name`, and **the
emitted AG-UI `toolCallId` is still `event.id`** — "the event row ids ARE the AG-UI ids" is a
documented invariant. Rows written before this project exactly as they did.

**Text stays one row per assistant turn, and that is not a trade-off.** A 2 000-token answer as
2 000 rows is ≈ 800 KB per turn, permanently, replayed in full by three endpoints — and because a
Workflow step must await every write, ~4 seconds of added latency per turn, *spent making the run
slower in order to look faster*. The real complaint is silence while a tool runs, and the fix for
that is **more `step` and `tool.*` rows**, which are genuine durable facts landing at 500 ms.
Tokens are the one payload legitimately not durable; a per-run Durable Object fan-out is the seam
for them, built on top of this, later.

Contracts and client:

- `AgentRunAguiResponse` gains **`lastSeq`**. AG-UI events carry no sequence of their own, so
  without it a client that fetched the snapshot has no resume cursor and every reconnect replays
  the whole run.
- `RUN_STREAM_FALLBACK_ATTEMPTS = 3` joins the `RUN_STREAM_*` constants.
- `readSse`'s `onEvent` gains the raw frame as a second argument (purely additive — `aguiStream.ts`
  ignores it); the frame's `id` is the cursor, and parsing it only to discard it put it out of reach.
- `ui/lib/runAguiStream.ts` is the transport (`streamRunAgui` → `{ lastSeq, received, terminal,
  aborted }`). **Reconnect lives in the hook, not the transport.**
- `ui/hooks/useRunStream.ts` is the hook: `useRunStream(runId, { enabled })` → `{ events,
  isLoading, connected, fallback, lastSeq, terminal }`, plus `streamEnabled(status)`. It is
  **additive** — the run page is built against the poll path, and deleting this hook must leave a
  working page.
- **The cache rule, flatly:** the stream is the only writer of `['agent-run-agui', id]`, appends to
  it with `setQueryData`, and never touches the run row. A terminal frame invalidates
  `queryKeys.agentRuns.all` **once**. Nothing else — and a terminal status is never synthesised
  client-side, which is how a UI comes to claim success for a run the server later marks failed.
- **`['agent-run-agui']` is deliberately absent from `REALTIME_INVALIDATIONS`.** The kit's
  convention is that an `entity.changed` entity string IS a query-key root, and the runtime nudges
  `entity: 'agent-run'` on **every** row it writes. Park the accumulated list under `['agent-run']`
  and each of those nudges throws away what the stream just built — **turning the stream into a
  more expensive poll.** There is a UI test on it.

### The run workspace (the UI)

**A run stops being a modal and becomes a page.** `/agents/runs/:runId` keeps its URL and gains its
own route, its own lazy chunk (`RunPage`) and a breadcrumb; `RunDetailDrawer.tsx` and
`AgentSteps.tsx` are **deleted**. A modal is the wrong home for something a person is asked to *act*
on, arrives at from a notification, may need to read a document before deciding, and may leave and
come back to.

**Three things were stale the moment `awaiting_input` existed, and all three are fixed here.**

- **`runOwesAnswer(status)` is new** (`hooks/useAgents.ts`) and is `queued || running`. `isRunActive`
  widened to include `awaiting_input` — the exclusive index needs it — and three call sites read it
  for the wrong question. `runPollInterval`, the runs list's `refetchInterval` and `RunStatusBadge`
  now read `runOwesAnswer`, so a run parked on a human is **not re-fetched every three seconds for a
  week** by every open tab, and its badge neither pulses nor `aria-live`-announces itself for the
  length of `AGENT_INTERRUPT_TIMEOUT`. `isRunActive` keeps its meaning and drives exclusivity copy.
- **Notification deep links exist.** `lib/notificationLink.ts` maps `type` + `data` to a path
  (`agent_run_awaiting_input` → `/agents/runs/<id>`, unknown → `null`), used by BOTH
  `NotificationsBell` and `/notifications`. Neither read `data` at all before: every row landed on
  the list of notifications *about* the thing rather than on the thing.
- **`STATUS_LABELS` is one export** (`RunStatusBadge.tsx`) instead of two copies, because the
  `Record<AgentRunStatus, string>` exhaustiveness is what tells you both places need a new key.
  `awaiting_input` reads "Awaiting input" and carries a `PauseCircleIcon`.

**The layout is the argument.** The action panel is full-width and **above** the timeline, because
somebody arriving from a notification is here to decide, not to read; under it the run's INPUT as
labelled values (from the agent's own `inputJsonSchema` through the one field renderer, falling back
to the JSON whole), and below that the timeline and the tabs side by side. Under `lg` they stack
**tabs first, timeline second** — on a phone the answer is what people came for. `run.error` renders
**above the tab bar, always**: a failure is not a tab.

Two things in that row are decisions rather than numbers, and an app that restyles this page should
keep them. **The split is `runLayout(status, override)`** (pure, in `timelineModel.ts`): the
timeline is the major column while the run is working — the progress IS the story and the output
pane is an empty state — and the output takes it once the run settles, but **a reader's override
wins permanently**, because a run that settles mid-read must not swap the columns underneath them.
The minor column stays narrow and readable rather than collapsing to a rail. And **the timeline is a
bounded scroller** (`lg:max-h` + `overflow-y-auto`, dropped below `lg` where the page scrolls
instead): without a scroll container the `<ol>` grew for ever, the panel grew with it, and the
stick-to-bottom sentinel scrolled the PAGE rather than the list.

**The action panel** (`run/ActionRequiredPanel.tsx` + `run/interrupts/*`) dispatches on an
exhaustive `switch` over the shared kind union, so a fifth kind is a type error until it has a
branch. Four details it is arranged around:

- **409 is information, not an error.** `isInterruptNotPending(error)` mirrors
  `isAgentRunsNotConfigured`; the panel swaps to `alert-info` — *"Someone else answered this"* —
  and refetches. No toast, no red.
- **Expiry ticks at a rate a pure function chooses.** `expiryState(expiresAt, now)` returns `tickMs`
  — 1 s under an hour, 60 s under a day, **`null` beyond**. A naive one-second countdown on a
  seven-day deadline re-renders the panel about 600 000 times.
- **A non-approver sees no buttons, not disabled ones** — they still see the panel, because they
  need to know the run is blocked and on whom, with one sentence instead. A disabled control with a
  tooltip is how you tell a member they are second-class.
- **Focus goes to the heading on mount, never to Approve.** An autofocused destructive button plus a
  stray Enter is how 412 subscribers get an email.

**The timeline** is two pure stages plus selectors in `run/timeline/timelineModel.ts` —
`buildTimeline(events)` then `groupTimeline(rows)`, with `selectArtifacts`, `selectPendingInterrupts`,
`selectWorkStats`, `defaultExpanded` and `windowGroups` beside them. *Everything the right pane shows
that is not `run.output` is a selector over the same rows — never a second fetch.* Two corrections to
the reducer it replaces, both load-bearing:

- **`tool.end` no longer overwrites `at`.** The old one did, destroying the call's start time, which
  is exactly why a per-call duration was impossible; `at` is the start and `endedAt` / `durationMs`
  are new. A step row gains `endedSeq` for the same reason — a `done` merges into the row its
  `running` wrote, so without it the position at which a stage finished is lost and a settled run's
  trailing rows get swallowed by the last stage.
- **It is idempotent under duplicated events** (deduplicated by `event.id` first). Once a stream and
  a fetch can both feed it, the same row arrives twice and the open-call FIFO would pair the second
  start with the first answer.

Grouping, stated so it is testable: a `running` step opens a group, non-step rows attach, its
`done`/`error` closes it, a different key implicitly closes the open one (an unclosed step is a real
state, shown spinning); rows before the first step go to `__preamble__`, rows after the last closed
one to `__tail__`. Collapsed a group reads `✓ Searching knowledge · 1.4s · 3 tools`; expansion is
`defaultExpanded` XOR the reader's own toggles, so a new event never yanks open a group somebody
closed. Auto-scroll (`useStickToBottom`) fires only when the reader is at the bottom **and the last
row id changed** — keying on height yanks them down whenever they expand an old group. For long runs
it **windows rather than virtualises** (40 groups from the end, plus one "Show earlier activity"
button): row heights vary wildly, so a virtualiser needs measurement, and measurement fights both
auto-scroll and collapsing.

**Real tool results for free.** `documentCardsFromToolResult(name, result)` already existed in
`@rocketflare/shared/ai/embeddings` and is documented as serving the agent-run projection, so
`search_knowledge` / `list_documents` / `get_document` render a `DocumentLink` one-liner each —
`components/shared/DocumentLink.tsx`, the same document a `DocumentCard` shows, on one line, because
inside a timeline row four cards bury the stage that comes next — and **no tool parser was
written**. Every other tool keeps `<details><pre>`, truncated at 4 000 characters — a
200 KB result pretty-printed into the DOM is a real hang.

**The right pane is `URLTabs` (`?tab=output|artifacts|usage`), not stacked panels**, so the
approver — the person this feature exists for — does not scroll past the answer to reach the
artifact they must inspect. The input is deliberately NOT a tab (it is the block above both
columns), and the run's timestamps live in Usage: only the elapsed time is in the header, which is
the one figure a person glances at.

- **`outputs/` mirrors `forms/`**: `outputFor(agentKey) → { schema, Component, artifacts? }`, which
  killed the hard-coded `agentKey === 'summarize-text'` / `'research-topic'` branches. **An agent is
  now one shared input schema + one `forms/` entry + one `outputs/` entry.**
- **Artifacts come from the table**, ordered by their event rows, with `outputFor().artifacts?.()`
  as the zero-server-change fallback for an agent that declares none.
- **Usage says what it does not know.** `ai_usage` gained a run reference in this release but nothing
  populates it yet, so the tab reports attempts, stages, tool calls with per-tool durations, retries
  and wall-clock, and **says in words** that model cost is not attributed per run in this deployment
  rather than rendering a `$0.00`. That is the `unpricedTurns` honesty rule copied across.

**One field renderer, two callers.** `fields/schemaFields.ts` is pure: `fieldsFromJsonSchema(schema)
→ FieldSpec[] | null` over a flat object of string / number / boolean / enum. **`$ref`,
`allOf`/`anyOf`/`oneOf`, nested objects and arrays return `null`, and the caller falls back to the
JSON textarea WHOLE, never per field** — a form that silently drops a field the agent requires is
worse than a JSON box, and that failure is invisible until the run 400s. `fields/FieldInput.tsx` +
`FieldSet.tsx` then serve both the `form` interrupt kind and `formFor`'s new middle rung,
`schemaForm(agent.inputJsonSchema)`, which is why the fourth interrupt kind cost almost nothing.
`submittableValues` drops empty optionals rather than sending `''`, because `formValuesSchemaFor`
builds a `.strict()` object.

**Finding what is waiting.** The runs table's filters moved from `useState` to `useSearchParams`, so
`/agents?awaiting=1` is a URL, and there is a chip for it; every row is a real `<Link>`, so
middle-click and open-in-new-tab work — half the point of a run being a page. The **SideNav badge**
is `NavItem.badgeKey` / `badgeTone` resolved by `useNavBadges()` in `SideNav`: `navigationConfig`
stays plain data consumed by the pure, tested `filterNavConfig` rather than becoming a hook. It reads
`GET /interrupts?status=pending&pageSize=1`, is keyed `['agent-run','awaiting']` so both server
nudges already cover it, and is **never polled**. **Collapsed, it renders a dot on the icon** — or
the whole feature is invisible to everyone who collapsed the sidebar.

**The stream stays additive.** The page is built against `GET /runs/:id` — the row, its durable
events, its asks and its artifacts — polled while the server owes an answer and refreshed by the
`agent-run` nudge. `useRunStream` is layered on for CADENCE only: when it reports a `seq` the page
has not rendered, the page re-reads the run, coalesced so one fetch is ever in flight. That keeps ONE
representation of the log (the durable rows) instead of a second, lossy one reconstructed from AG-UI
— AG-UI events carry no `seq`, no row id for a step and no timestamp — and **deleting the hook leaves
a working page**, which is the property the stream was built to preserve. The stream remains the only
writer of `['agent-run-agui']` and still never touches the run row.

**And because the page re-reads a run on every new `seq`, `reconcileRun` gained a liveness guard.**
The stream removed a Workflow `instance.status()` subrequest from a 3 s loop; re-reading `GET
/runs/:id` on every stream cursor advance put a busier one back, on the client — up to ~2 a second
per viewer against the poll's 0.33. The rule that fixes it is not a throttle:

> **A run that has written a durable event within the last 30 s is alive by definition. Do not
> spend a Workflow subrequest asking.**

`reconcileRun(db, env, run, { lastEventAt })` exists to settle a run whose *instance has vanished*,
and a run that wrote a row two seconds ago manifestly has not. It is an **optional argument, so
every call site opts in explicitly** rather than inheriting a hidden default: `GET /runs/:id` and
`GET /runs/:id/agui` already load the log, so they pass its newest `at` and the binding is never
touched; `?events=0`, the stream route and every other caller pass nothing and reconcile exactly as
before. `RECONCILE_LIVENESS_MS` (30 s, exported from `services/agents/runs.ts`) is chosen from both
ends — far longer than the gap between rows in a healthy run, far shorter than a stall anybody
would notice — and the only cost is that a genuinely dead instance is detected up to one window
later. A legitimately silent minute (one long `execute` step) falls straight through to a real
reconcile, where `'waiting'` and the default arm both leave the row alone.

`routes/agents.ts` splits `loadRun` into `requireRun` (lookup + the ownership 404) and
`settleOnRead` (reconcile + `expireParkedRun`), so the two routes with a log in hand can read it
*before* they settle. Nothing is lost by the reordering: settling a run writes no event row.
**"`reconcileRun` exactly once, never in the loop" is unchanged** — the stream route still
reconciles unconditionally at open, and its test still pins it.

Also: `Row` / `Section` / `formatCost` moved out of `ChatStatsPanel.tsx` into
**`components/ai/StatRows.tsx`** — a legal markdown zone whose two consumers are both lazy, so Vite
emits it once. `components/shared` would have been the mistake (it is the eager barrel).


### The shipped examples

Both example agents now exercise the machine, and the contrast between them is the teaching:

- **`summarize-text` asks with `ctx.interrupt`.** With `index: true` it raises an `approval` keyed
  `approve-index` before writing the summary into the knowledge base, and records a `markdown`
  artifact for the summary and a `document` artifact for the stored copy. It does **not** use
  `Tool.requiresApproval`, deliberately: it has no tool loop — one `callStructuredTool`, and the
  write is straight-line code — so the flag has nothing to attach to, and bolting a loop onto *the
  file every adopter copies* purely to demonstrate one would make the simplest agent the most
  complicated. Its whole summarise phase now sits inside `ctx.once`, because a park is a retry
  boundary and tokens are a side effect: without it a run parked for a day pays for the summary
  twice and shows the phase twice in its timeline.
- **`research-topic` carries the rest.** `ask_human` raises a `choice` interrupt **from inside a
  tool handler** — the single best exercise of the whole machine, because the handler throws,
  `runHandler` rethrows, the loop parks, the resume executes the pending call and the re-entered
  handler finds its answer already recorded. `index_finding` is a write the MODEL decides to make,
  so it is gated with `requiresApproval` + `allowEdits` + `onReject: 'tell_model'`, and it is the
  only shipped code passing `approvals: ctx.approvals` and `runApproved: ctx.once` — the two halves
  that stop an answered gate being re-asked and an approved write running twice. `beforeTurn` folds
  in steering notes, and the answer and its sources are recorded as `markdown` and `table`
  artifacts.

Neither sets `approvers: 'admin'` — no kit agent touches money — so that policy is exercised by
tests only. The `research-topic` prompt gained two numbered steps telling the model when each new
tool is appropriate; an app that overrode that prompt keeps its own text and should add the
equivalent, or the model will never call them.

**A handler-raised ask must key on the QUESTION, not the call.** It parks *before* the loop
checkpoints that turn, so the resumed loop calls the model again and may get a fresh tool-call id;
only a question-derived key lands back on the same `(run_id, key)` row.

## How to apply

Take the four `packages/shared/src/ai/` files and `errors.ts` as written — they are appends, so a
copy that renamed its scope only needs the import specifier translated. Then three small knock-ons
that keep the workspace compiling; each is one edit:

1. `apps/web/src/db/schema/agent-runs.ts` — append `'awaiting_input'` to
   `AGENT_RUN_STATUS_VALUES`. **No DDL for the column**: it is `text`, which is exactly why it is
   `text`. The index predicate beside it *does* change — see the schema step below.
2. `apps/web/src/api/routes/agents.ts` — `GET /runs/:id` builds an `AgentRunWithEvents`, which now
   has `interrupts` and `artifacts`; the routes step fills them from the tables.
3. Any `Record<AgentRunStatus, …>` in your own UI gains an `awaiting_input` arm; the kit's two
   (`AgentsPage`, `RunStatusBadge`) use the label "Waiting for you" and the stylesheet's existing
   `awaiting-review` warning tone.

An app with its own agents may set `approvers: 'admin'` on an `AgentMeta`; the answer route reads it.

**The Workflow loop** touches two files an app is unlikely to have edited (`api/workflows/agent-run.ts` and
`finishStep`) plus the test mock. Take `agent-run.ts` whole. If your copy forked the Workflow class
— an extra step, a different `timeout` — port the loop by hand and **keep the `#${round}` suffix on
every step name inside it**; that is the one detail nothing in a Node suite can check for you.

**The runtime** is additive everywhere except three lines an app may have touched: the `ACTIVE` constant in
`services/agents/runs.ts` (now imported, and `claimRun` alone keeps the narrow list), `Tool` in
`services/ai/kit.ts`, and `AgentContext`. An app with its **own** `AgentContext` implementation — a
test double, most likely — gains four members it must provide. An app that copied `runToolLoop`
rather than importing it gets none of this and should re-take the file.

**For the schema**, take the two new `apps/web/src/db/schema/` files, the `agent-runs.ts` index change, the
`ai_usage` column and the `[vars]` key, then run **your own** `pnpm db:generate` — never copy the
kit's `migrations/0011_*.sql`, because every `meta/*_snapshot.json` describes the whole cumulative
schema and yours has tables the kit has never heard of. Read what drizzle-kit emits before applying
it: a *changed* partial-index predicate is the case it is weakest on, and a `CREATE` with no `DROP`
silently leaves the old narrow index in place.

**The routes** are mostly additive inside `apps/web/src/api/routes/agents.ts` (three new routes, two helpers
and a shared `loadRun`), so a copy that restyled its agent routes should take the new blocks and keep
its own. Two edits are NOT additive and are easy to miss when resolving by hand: `GET /runs/:id` and
`/agui` must both go through `loadRun` so `expireParkedRun` runs on read, and
`projectRunToAgui` now takes a third argument — a call site that omits it still compiles, and
silently drops every ask and artifact from the timeline. If your UI asserts on the AG-UI sequence of
a run, note that **`STATE_SNAPSHOT` is now the second event of every projection**.

**The stream** is additive except for three edits that are easy to miss. `projectRunToAgui` is now a fold
over `createRunProjector`; take the whole file, because the tool-call pairing fix lives inside it and
a partial merge that keeps the old name-keyed map silently mis-attributes parallel tool results. An
agent of your own that emits `tool.start` / `tool.end` should start passing the model's
`toolCallId` in both (one property each; omitting it keeps the old name-pairing behaviour). And
`AgentRunAguiResponse` gains `lastSeq`, so any hand-built response object of that type stops
compiling until it supplies one — take the `events.at(-1)?.seq ?? 0` from `routes/agents.ts`.

The client half is entirely new files plus one additive signature (`readSse`'s `onEvent`), so a copy
that restyled its run page can take `lib/runAguiStream.ts`, `hooks/useRunStream.ts` and the two
`query-keys.ts` entries and wire them when it wants to. **Do not put `['agent-run-agui']` in
`REALTIME_INVALIDATIONS`** — the reason is in the stream section above, and the failure is silent.

**The run workspace** is a UI change and touches nothing on the server. `apps/web/src/ui/pages/agents/` is
substantially new — `RunPage.tsx` plus `run/**`, `outputs/**` and `fields/**` — and
`RunDetailDrawer.tsx` and `AgentSteps.tsx` are deleted. A copy that restyled its run surface should
take the new tree wholesale and re-apply its styling, rather than merging hunk by hunk into two
files that no longer exist. Six edits outside that tree are the ones to make by hand:

1. `hooks/useAgents.ts` — add `runOwesAnswer` and point `runPollInterval`, `useAgentRuns`'s
   `refetchInterval` and `RunStatusBadge` at it. **Do this even if you take nothing else**: with
   `awaiting_input` in `ACTIVE_RUN_STATUSES`, a parked run otherwise polls for days.
2. `lib/format.ts` gains `formatDuration` / `runDuration` (they lived in the deleted drawer, which
   the runs table imported from — a real coupling).
3. `lib/query-keys.ts` gains `agentRuns.awaiting`.
4. `components/SideNav.tsx` — `badgeKey` / `badgeTone` on `NavItem`, resolved in the component. Keep
   `navigationConfig` a const; `filterNavConfig` must stay pure.
5. `lib/notificationLink.ts` plus its two call sites. An app with its own notification types adds
   them to the one `switch`.
6. `pages/chat/ChatStatsPanel.tsx` — `Row`, `Section` and `formatCost` now come from
   `components/ai/StatRows.tsx`. Do not move that file into `components/shared`: it is the eagerly
   imported barrel, and `tests/config/ui-bundle.test.ts` asserts nothing under it touches markdown.

`formFor` now takes the `AgentInfo` rather than the key (the string form still works), so it can try
`schemaForm(inputJsonSchema)` before falling back to the JSON textarea.

**The two example agents** are behind `example-agent-summarize-text` /
`example-agent-research-topic`, so a copy that deleted one never sees its changes. A copy that KEPT
one and modified it should read the diff rather than take it: the changes are small and pointed —
an interrupt around the existing `ingestText` call, `ctx.once` around the existing model call, two
`ctx.artifact` calls, and for `research-topic` two new tool factories plus `approvals` /
`runApproved` / `beforeTurn` on the existing `runToolLoop` options object. The prompt change is one
`PROMPT_REGISTRY` entry, which an app may have overridden per tenant; a tenant override wins over
the registry, so those tenants keep the old text and the new tools silently go unused until somebody
updates the override in Settings → Prompts.

**Docs.** `docs/CONCEPTS.md` §5, §9 and §14, `docs/ADAPTING.md` §3, `docs/DEPLOY.md`, `SETUP.md`
§2.5 (a `wrangler dev` acceptance walkthrough for the park — the only way to exercise
`waitForEvent`), `.claude/rules/{api,cloudflare,database,ui,testing}.md` and the per-directory
`CLAUDE.md` files are all updated in this release; a copy that keeps its own prose should still read
the new `.claude/rules` bullets, because they are the ones an agent working in that copy will be
held to.

## Conflicts to expect

`packages/shared/src/ai/agents.ts` is the one file with several separate hunks (imports, the status
enum, the event-type list, the event-payload block, `agentRunWithEventsSchema`, and two new
constant sections). An app that added its own statuses, event types or agent metadata will have to
place them by hand. `apps/web/src/ui/pages/agents/*` is likely to be rejected wholesale in a copy that has restyled the
run surface — two of its files are deleted and a directory tree added — so take that tree fresh
and re-apply styling rather than resolving hunks into files that no longer exist. Everywhere else
the compiler names every missing arm, so take the type error as the checklist.

## Verify

`pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Specifically:
`apps/web/tests/config/agui-contract.test.ts` proves the interrupt outcome round-trips over **both**
SSE and protobuf and that `resume[]` parses, and
`apps/web/tests/config/agent-interrupts.test.ts` proves `AGENT_RESUME_EVENT` is a legal Workflows
event type, the rejection semantics, and the four payload validators;
`apps/web/tests/api/rls-coverage.test.ts` proves both new tables are policied;
`apps/web/tests/config/wrangler-parity.test.ts` proves `AGENT_INTERRUPT_TIMEOUT` is in both tomls.
For the runtime, `apps/web/tests/api/agent-tool-loop-interrupt.test.ts` proves the gate raises **before**
any handler runs, that the resume path answers pending calls through the same code, and that a
handler-raised interrupt propagates; `apps/web/tests/api/agent-interrupts.test.ts` proves a park
keeps its checkpoint with `finished_at` NULL, that a re-entered `execute` finds its own earlier ask,
that a declined approval cancels with a NULL error, that a steering note is delivered once across a
park and resume, and that `sendEvent → not_found` creates `<runId>-r1`.
For the Workflow loop, `apps/web/tests/api/agent-run-workflow.test.ts` proves the step names are distinct per
round, that a resume re-enters `execute` and the run completes, that an unanswered park times out to
`cancelled` with a **NULL `error`**, that `MAX_INTERRUPT_ROUNDS` stops a runaway agent cleanly, and
that `finishStep` does not fail a parked row. `waitForEvent` itself only runs on the platform — the
`wrangler dev` walkthrough is the acceptance test for the durable park.
`apps/web/tests/api/agent-runs.test.ts` proves `GET /api/agents` answers an `inputJsonSchema` the
REAL field renderer accepts for every shipped agent — the assertion that was missing, because each
phase had tested its own half against a schema it wrote itself; `apps/web/tests/config/run-timeline.test.ts`
pins `formFor`'s middle rung and the humanised labels.
For the routes, `apps/web/tests/api/agent-interrupt-routes.test.ts` proves the 409 on a double answer,
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

For the stream, `apps/web/tests/api/agent-run-stream.test.ts` proves 403 / 404 / 400 land **before the
first frame**, that `?afterSeq=` wins over `Last-Event-ID` and a resume omits the head, that `id:`
appears **only on the last frame of each row's group** and a mid-group drop resumes at the previous
row, that a parked run emits the interrupt outcome and **closes** (the seven-day test), that the
idle and duration caps close with **no** terminal event, that a body error emits **no `RUN_ERROR`**,
that a protobuf `Accept` produces no `id:` lines and **no comment frames**, and that `reconcileRun`
is called **exactly once** (spied on the binding). `apps/web/tests/api/agui-projection.test.ts`
proves the projector equivalence — `projectRunToAgui(run, rows)` ≡
`head + rows.flatMap(push) + finish(run)` — that two parallel calls to the same tool pair correctly,
and that rows without `toolCallId` pair by name exactly as before.
`apps/web/tests/ui/run-stream.test.tsx` proves the client's cursor only moves on a frame that
carries one, the `streamEnabled` matrix, the three-empty-connections fallback, and that a run nudge
leaves `['agent-run-agui']` untouched.

For the run workspace, `apps/web/tests/config/run-timeline.test.ts` proves the timeline reducer's grouping, its
implicit close, its `__preamble__` / `__tail__` stretches, **the tool duration from start→end (the
`at`-overwrite regression)** and **idempotence under duplicated events**; the `expiryState` tick
selection including the `null` beyond a day; and `fieldsFromJsonSchema` including the **whole-form**
fallback for every unsupported keyword. `apps/web/tests/ui/run-page.test.tsx` proves the page has no
`role="dialog"`, that `runPollInterval('awaiting_input')` is `false`, that each interrupt kind posts
the right payload (`status`, never an `approved` boolean), that a 409 renders as *"Someone else
answered this"* with **no toast and no red**, that a non-approver gets one sentence rather than
disabled buttons, that focus lands on the heading, that a failure renders above the tab bar, and
that an `agent-run` nudge refetches the run while leaving `['agent-run-agui']` untouched.
`apps/web/tests/ui/sidenav.test.tsx` proves the badge renders and **becomes a dot when the nav is
collapsed**, while still announcing its count. `apps/web/tests/config/ui-bundle.test.ts` proves
`RunPage` lands in its own lazy chunk and that the eager entry still carries no markdown.

For the examples, `apps/web/tests/api/agent-run-workflow.test.ts` proves `summarize-text` with
`index: true` parks on `approve-index`, that answering it resumes the run and leaves the document in
`/documents` **exactly once** with exactly one artifact per key despite `run()` being entered twice,
that ONE model call covers both attempts, and that a DECLINED approval settles `cancelled` with
`error` NULL and nothing written. `apps/web/tests/api/agent-research.test.ts` proves `ask_human`
parks with a `choice` keyed on the question and that the re-entered handler finds the answer — one
interrupt row, not two — and that `index_finding` parks with **nothing written** (the gate raises
before the handler), then runs exactly once on approval, with the approver's `editedInput` replacing
the model's arguments.

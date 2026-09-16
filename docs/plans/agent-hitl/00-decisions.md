# The decisions that shape everything

Seven calls. Everything in phases 1–8 follows from them.

### 1. Three status lists, not one

Issue #17 says widen `('queued','running')` everywhere. That is wrong as stated — there are three
distinct predicates and they must diverge:

| List | Members | Read by |
|---|---|---|
| `ACTIVE_RUN_STATUSES` | `queued`, `running`, `awaiting_input` | the exclusive partial unique index, `findActiveRun`, `settle()`, `saveCheckpoint`, `isRunActive` |
| `CLAIMABLE_RUN_STATUSES` | `queued`, `running` | `claimRun` **only** (decision 2 is what makes this safe) |
| *(inline, unnamed)* | `queued`, `running` | `finishStep`'s backstop — "still active at the end → fail it". Widening this turns every legitimately parked run into a `failed` row |

### 2. The answer is the transition

Resolving an interrupt flips the row `awaiting_input → running` **and then** nudges the instance.
One fact that fixes T4, keeps `claimRun` untouched, and makes the `not_found` restart work.

### 3. The event is a nudge; the row is the truth

`sendEvent` carries `{ interruptId }` only; `executeRun` re-reads the row and the checkpoint. A
payload carrying the answer would be a second source of truth that can disagree with the audit row —
the same rule the WebSocket hub already follows.

### 4. Artifacts are a table; steering is an event row

They look symmetric and are not.

An **artifact** is **mutable** (a redrafted artifact must replace itself under `(run_id, key)`),
**queried across runs** ("everything this agent produced"), and **outlives the run** with an id a
card links to. An append-only positional log expresses none of that. What goes in the log is a
*thin* `artifact` row carrying `{ artifactId, key, kind, title }` — position in the timeline without
making the log the storage.

A **steering note** is immutable, positional, per-run, and belongs in the timeline a person reads.
It is an `agent_run_events` row and needs no table; the "delivered once" cursor is the **existing**
`agent_run_effects` ledger, keyed `steering:${eventId}`.

Two new tables, not three.

### 5. The projection becomes resumable

`createRunProjector(run) → { head(), push(event), finish(run) }`, with `projectRunToAgui` a fold
over it — same signature, same output, pinned by an equivalence test. Re-projecting the whole array
per tick is cheap in CPU but forces the stream to hold or re-read the entire log every tick, which
is exactly the O(events) behaviour the stream exists to remove. `finish` takes the run as an
**argument**, not from the closure, because in a stream the row changes underneath you.

### 6. A read-stream failure is not a run failure

`chat-turn.ts` emits `RUN_ERROR` when its body throws, correctly — there the stream *is* the run.
Here the run is a durable Workflow in another isolate and is almost certainly fine, so a read-stream
**logs and closes silently**. Closing with no terminal event means "reconnect", uniformly, for a
redeploy, an idle cap, a duration cap, a transport error and an abort. A deliberate inversion of the
chat rule, and it must be written down as one in `.claude/rules/api.md`.

### 7. Closed sets, never a generic form renderer

Four interrupt kinds, five `form` field types, five artifact kinds. A fifth interrupt kind is one
tuple entry, one payload schema, one UI branch. Adopting a JSON-Schema form generator would be
issue #12 all over again — and the `form` kind plus the unregistered-agent run form share **one**
field renderer, which is why the kind costs almost nothing.

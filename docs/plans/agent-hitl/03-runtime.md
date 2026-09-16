# Phase 3 — Runtime

**Goal:** `ctx.interrupt`, `Tool.requiresApproval`, steering, artifacts — and the resume path issue
#17 does not have (T1).

## `services/ai/kit.ts`

`Tool` gains `requiresApproval?: boolean | ((input) => boolean)`, `approvalMessage?`, `allowEdits?`,
`onReject?`. New `InterruptRequested` (carrying the requests) and `InterruptDeclinedError`.

`RunToolLoopOptions` gains:

- `approvals?: ReadonlyMap<toolCallId, ToolApproval>` — built by the runtime, never by the agent
- `onInterrupt?: (requests) => Promise<'throw' | 'return'>`
- `runApproved?: <T>(key, fn) => Promise<T>` — the runtime passes `ctx.once`
- `beforeTurn?: (turn) => Promise<ChatMessage[] | void>` — where steering lands

`ToolLoopResult.stopReason` gains `'interrupt'`.

> `onInterrupt` returning `'return'` instead of `'throw'` is the **Part-3 seam**: a chat host has no
> Workflow to unwind, so it needs the loop to return rather than throw.

### Where the gate goes

Inside the `while`, after the assistant turn is pushed and **before** the handler loop
(`kit.ts:471-482`). It cannot go inside `runHandler`, which by design swallows throws (T3).

1. **Parse every tool use's input with its schema.** An invalid input never becomes an interrupt —
   it takes the existing `isError` path. Nobody should be asked to approve arguments the tool would
   reject anyway.
2. **Scan the whole turn** for open gates. Scanning before executing anything is what makes
   multi-tool turns safe: if one call is gated, none of the turn's handlers have run when we park,
   so there is nothing to make idempotent on resume beyond the approved call itself. It also
   produces the plural `interrupts[]` that `RunFinishedInterruptOutcome` already models.
3. If any: **`await checkpoint()` first**, then `onInterrupt`, then throw. Checkpoint-before-raise
   is what makes the resumed attempt cheap; the other order re-pays for every turn.
4. Only now run handlers:
   - approved → `runApproved(\`tool:${interruptId}\`, …)`
   - rejected + `cancel_run` → `InterruptDeclinedError`
   - rejected + `tell_model` → a synthesised tool result, **`isError: false`** — it is an answer,
     not a fault
   - ungated → as today

### `resumePendingToolCalls()` — T1

At the very top of `runToolLoop`, **before** the `while`. Detect a trailing assistant turn whose
`tool_use` blocks have no `tool_result` — which is exactly what a parked run's checkpoint looks
like — answer them using the approvals just given, append, checkpoint, then enter the loop.

> It reuses **the same** `executeToolUses()` function as step 4. **Do not fork it** — two copies of
> the approval rules is how the gate gets bypassed on the resume path only.

### Two small things

`runHandler` gains exactly one rethrow (T3):

```ts
} catch (err) {
  if (err instanceof InterruptRequested) throw err
  return { text: …, isError: true }
}
```

The same rethrow is **not** added to `runStreamingChat` — chat has no interrupt host yet, and a tool
raising one there is a bug we want as an `isError`, not a broken stream. Say so in a comment.

`appendUserText(messages, text)` — appends as a block on a trailing user message, or a new user turn
when the last message is the assistant's. **Two consecutive user turns is a 400 from Anthropic**, and
it is exactly what naive steering produces.

## `AgentContext` (`services/agents/registry.ts`)

```ts
interrupt<K>(ask: AgentInterruptAsk<K>): Promise<AgentInterruptAnswer<K>>
steering(): Promise<AgentSteeringNote[]>
artifact(input: AgentArtifactInput): Promise<AgentArtifact>
approvals: ReadonlyMap<string, ToolApproval>   // built by the runtime; the agent never queries
```

`ctx.interrupt`'s doc comment carries three obligations:

1. **`key` is yours and must be stable across attempts** — a resumed `execute` re-enters `run()`
   from the top, and `(run_id, key)` is what makes the second call find the *answer* (T2).
2. Everything after the call is **"the far side of a Worker deploy"** — anything with a side effect
   goes behind `ctx.once`.
3. Rejection differs by kind: `approval` throws `InterruptDeclinedError`; the others resolve with
   `{ status: 'cancelled' }`.

## New `services/agents/interrupts.ts`

| Function | Notes |
|---|---|
| `requestInterrupt` | create-or-read on `(run_id, key)` — the idempotency (T2) |
| `listInterrupts` | pending rows for a run, oldest first |
| `resolveInterrupt` | **one statement** compare-and-set on `status = 'pending'`; null → 409 |
| `expireInterrupts` | every still-pending row for a run → `expired` |
| `approvalsForRun` | answers keyed by `toolCallId`, from the resolved rows |
| `expireParkedRun` | **T6** — a parked run whose asks have all expired settles `cancelled` on read. The only safety net for a park whose instance no longer exists |

## `services/agents/runs.ts` — five surgical changes

1. `ACTIVE` becomes the imported `ACTIVE_RUN_STATUSES`; a new `CLAIMABLE` is used by `claimRun`
   **only**. That one line correctly widens `settle()`, `findActiveRun` and `saveCheckpoint`.
2. **`parkRun`** — `running → awaiting_input`, and **not** a `settle()`: `finishedAt` stays NULL and
   **the checkpoint survives**, which is the whole reason a resume is cheap (T7). `settle()` nulls
   it at `runs.ts:253`.
3. **`resumeRun`** — `awaiting_input → running`, compare-and-set, called by the resolve route
   *before* it nudges (T4, decision 2).
4. `requestCancel` handles `awaiting_input` like `queued` — settle outright, `expireInterrupts`,
   then a best-effort `sendEvent` so the parked instance wakes, sees a settled row and exits rather
   than sitting on a seven-day `waitForEvent`.
5. **`appendEventAtomic`** (seq computed in SQL, one retry on `23505`) and **`claimEffect(key)`** —
   "am I the first?" over the same `(run_id, key)` index `runOnce` uses. `runOnce` replays a
   recorded *result*; `claimEffect` replays a *decision*, which is what once-only delivery needs.

`reconcileRun` keeps its `queued|running` guard (a parked row is not the runtime's to reconcile) and
gains an explicit, commented `case 'waiting': return run` so the correct-by-accident default becomes
correct-on-purpose, plus a test.

**`nudgeOrRestartInstance`** — `instance.not_found` is an *answer*, not an error (the reading
`reconcileRun` already takes): create a new instance seeded from the row, id `${runId}-r1`, `-r2`…
(T5). This breaks "instance id IS the run id": the column becomes *the latest* instance, stays
`unique()`, and `docs/CONCEPTS.md` §9 is corrected in the same PR. **Skipping this leaves a parked
run that can never be resumed — the worst outcome this feature has.**

## `services/agents/runtime.ts` — `executeRun`

`ExecuteOutcome.status` widens to include `'awaiting_input'` (a real `AgentRunStatus`, not a second
vocabulary word like `'interrupted'`).

New catch arm **before** the generic classification, in this order — **the order is the safety
property**: *a row with no parked run re-asks on the next attempt; a parked run with no row is a hang.*

```
rows   = requests.map(requestInterrupt)     // idempotent by (run_id, key)
parked = parkRun(...)                       // NOT settle()
per row: emit 'interrupt'; if claimEffect(`notify:${row.id}`) notifyApprovers(...)
emit status awaiting_input; settle nudges
return { status: 'awaiting_input', interruptIds }
```

`InterruptDeclinedError` → `cancelRun` + a `status` event carrying `reason: 'rejected'`;
`agent_runs.error` stays **NULL**, because a cancel is a status, not a message.

> **`isRetryableRunError` must return `false` for both new types**, or a step retry re-asks a human
> who already said no.

`ctx.steering()` delivers each note exactly once via `claimEffect(\`steering:${eventId}\`)`; notes
reach the model through `beforeTurn` + `appendUserText`.

## Done when

- [ ] the gate raises **before** the handler runs (assert the handler spy is not called)
- [ ] a handler-raised interrupt parks instead of becoming an `isError` (T3)
- [ ] `executeRun` returns `awaiting_input` and **keeps the checkpoint with `finished_at` NULL**
- [ ] a re-entered `execute` finds its own earlier ask rather than creating a second (T2)
- [ ] an approved tool executes **exactly once** across a step retry
- [ ] a steering note is delivered once across two attempts and never produces two user turns

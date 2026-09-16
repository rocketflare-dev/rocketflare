# Issue #17 is the right design, and it has eight bugs

It is a strong spec and this plan follows it almost everywhere. But eight things in it are wrong in
ways that would ship, and three of those leave runs permanently stranded or fail on the first real
approval. **Read this before writing any code.**

| | #17 says | Why it breaks | Fix |
|---|---|---|---|
| **T1** | `runToolLoop` throws after writing its checkpoint; resume re-enters and continues | The checkpoint's last message is **an assistant turn containing an unanswered `tool_use`**. `runToolLoop`'s `while` opens with `client.complete(messages)`, and sending a `tool_use` with no `tool_result` is a provider error on Anthropic and garbage everywhere else. **There is no resume path for pending tool calls.** | `resumePendingToolCalls()` **before** the `while` loop — [phase 3](03-runtime.md) |
| **T2** | `await ctx.interrupt({ kind, message })` | No idempotency key. A resumed `execute` re-enters `run()` **from the top** and asks again → a new interrupt row every round, forever | `key` is **mandatory**; `UNIQUE (run_id, key)`; `ctx.interrupt` is create-or-read, exactly like `ctx.once` |
| **T3** | *(silent)* | `runHandler` (`kit.ts:336`) converts **every** tool throw into an `isError` result — so `ctx.interrupt` called inside a tool handler, which is the natural place, is swallowed and the model just asks again | `runHandler` gains exactly one rethrow: `if (err instanceof InterruptRequested) throw err` |
| **T4** | resume creates a new instance when `sendEvent` → `not_found`, **and** "the claim stays `('queued','running')`" | **Contradictory.** The new instance's first step is `claim`, which runs `claimRun` against an `awaiting_input` row → `null` → `status: 'skipped'`. **The run is stranded permanently, holding the exclusive slot.** | The **resolve route** flips `awaiting_input → running` as part of its compare-and-set, *before* `sendEvent`/`create`. **The answer IS the transition.** Claim then genuinely needs no change |
| **T5** | instance id `${runId}:r1` | `:` is not a documented-legal instance-id character | `${runId}-r1` — a uuid already proves hyphens are legal, and 36+3 ≤ 64 |
| **T6** | timeout settles `cancelled`; "`awaiting_input` with no pending row is unreachable" | (a) If the **instance is gone** (a `wrangler dev` restart, instance retention) `waitForEvent` never fires and the park pins the exclusive slot forever. (b) The no-pending-row state is trivially reachable — the window between the resolve write and the resume | `expireParkedRun` on the read path, beside `reconcileRun`; the projection treats the empty-pending case as a fact, not an impossibility |
| **T7** | "every existing terminal write widens to `awaiting_input`" | Two of them must not. `settle()` must widen (or a parked run can never be cancelled) — but **parking must not go through `settle()` at all**, which nulls `checkpoint` (`runs.ts:253`) and stamps `finishedAt`; and `finishStep`'s backstop ("still active at the end → fail it", `runtime.ts:266`) must stay narrow, or every legitimately parked run becomes a `failed` row | a separate `parkRun()`; three named status lists — see [00-decisions.md](00-decisions.md) |
| **T8** | `AGENT_RESUME_EVENT = 'agent.resume'` | **Invalid event type.** Per [Workflows: events and parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/), names allow "only letters, digits, `-`, and `_`" and "including `.` is not supported and will result in a `workflow.invalid_event_type` error" | `agent-resume`, plus a pure test asserting `/^[A-Za-z0-9_-]{1,100}$/` |

**T8 is the one to appreciate.** Nothing in the suite would catch it — `createFakeWorkflowStep`
never validates the name — so it would first surface as *a parked run that can never be resumed*,
in production, on the first approval anyone ever gives.

## Two further gaps neither issue names

**`seq` collisions.** `createEmitter` keeps an in-memory counter, safe today because a Workflow step
is the only writer. A steering route writes to the same run *while* a step is emitting, and
`agent_run_events_run_seq_idx` rejects the loser. Needs `appendEventAtomic` — seq computed in SQL,
one retry on `23505`.

**Two consecutive user turns.** A resumed transcript usually ends in a `user` turn of `tool_result`
blocks; naive steering appends a second one, which Anthropic rejects outright. Needs an
`appendUserText()` that folds into a trailing user message rather than creating a new one.

## One more, in the projection

`agui-projection.ts:98,117` keys `openToolCalls` by tool **name**. Harmless today because
`runToolLoop` is strictly sequential — but the day two `search_knowledge` calls run in one turn (the
most likely parallelism a model produces) the first `tool.end` resolves to the *second* call's id
and the second falls through to `?? event.id`, emitting a `TOOL_CALL_RESULT` pointing at a
`toolCallId` no client ever saw. Fixed in [phase 6](06-streaming.md), because the streaming work
touches the projector anyway.

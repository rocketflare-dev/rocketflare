# Workflows (D5, D7)

`agent-run.ts` — `AgentRunWorkflow extends WorkflowEntrypoint<AppBindings, { runId, tenantId }>`,
bound as `AGENT_RUN_WORKFLOW` in BOTH tomls (`name` is account-scoped: `rocketflare-agent-run` /
`-staging`; `binding` + `class_name` identical — the parity test enforces). Exported from
`src/worker.ts` only.

Shape: `step.do('claim')` → a LOOP of `step.do('execute#N', { retries: { limit: 2, delay:
'10 seconds', backoff: 'exponential' }, timeout: '10 minutes' })` and, whenever that returns
`awaiting_input`, `step.waitForEvent('resume#N', { type: AGENT_RESUME_EVENT, timeout:
cfg.AGENT_INTERRUPT_TIMEOUT })` → `step.do('finish')`. The bodies are plain functions in
`../services/agents/runtime.ts` (tests call them with `{ db, env }`); the class only wires steps and
opens/closes ONE DB client per step (`withStepDatabase`, awaited `close()` in `finally`). Step return
values are small serialisable objects (ids + status), never rows.

**A step name is its IDENTITY to the platform**, so every name inside the loop carries its round.
A fixed `'execute'` called a second time replays the first call's cached result — the run re-asks
the question it already had answered, and the bug reads as "the agent ignored my approval". Nothing
in a Node suite can catch that; `tests/api/agent-run-workflow.test.ts` asserts the recorded names
are distinct per round, which is the closest we get.

Three more things the loop holds:

- **The resume payload is ignored on purpose.** The answer is already an `agent_run_interrupts` row,
  written by the resolve route, which also flips `awaiting_input → running` BEFORE it wakes the
  instance (decision 2). `execute#N+1` re-enters `run()` from the top and reads it. That is what
  lets `nudgeOrRestartInstance` create a fresh instance when the old one is gone — a new instance
  has no event to replay and needs none. `AGENT_RESUME_EVENT` is a constant because a `.` in the
  type is `workflow.invalid_event_type` (T8).
- **The `try/catch` around `execute` lives inside the loop and clears `outcome`** — a previous
  round's `awaiting_input` falling through to `finish` would say the run is parked when it is not.
- **`MAX_INTERRUPT_ROUNDS` (32)** ends a runaway agent `failed`. A correctness guard, not a capacity
  one: the step budget is 10,000 and a round costs two steps.

**The whole tool loop lives in the ONE `execute` step by decision, not by omission** — one `step.do`
per model turn was investigated and rejected (`docs/CONCEPTS.md` §9 Known gaps). Steps do not nest,
so it needs `run()` outside a step, and Workflows replays everything outside a step. Wall clock per
step is unlimited, so a long run is a bigger `timeout`, not more steps.

Rules: idempotent steps (the `agent_runs` row is the claim); cooperative cancel (poll the row between
turns); CPU is bounded PER STEP by `[limits] cpu_ms`; no `waitUntil` — await everything, including
nudges (`createStepRealtime().settle()`). `wrangler dev` runs instances locally; inspect deployed ones
with `wrangler workflows instances describe rocketflare-agent-run <runId>`.

Testing: `tests/api/agent-run-workflow.test.ts` instantiates the class with `createTestEnv()` and
`createFakeWorkflowStep(options)` (`tests/mocks/cloudflare-workers.ts`) and asserts on the rows.
The fake's `waitForEvent` is a recorder: `{ events?, onWait? }` in, `{ step, calls, waits, names,
queueEvent }` out. `onWait` is the test's stand-in for the resolve route (write the answer, flip the
row, return a payload); an empty queue with no `onWait` rejects the way the platform's timeout does,
which is how the expiry path is driven. `names` is every step name in call order.

# Phase 4 — Workflow

**Goal:** the suspend/resume loop, and the fallback for a park whose instance is gone.

`apps/web/src/api/workflows/agent-run.ts`:

```ts
const claimed = await step.do('claim', …)
if (!claimed) return { runId: params.runId, status: 'skipped' }

let outcome: ExecuteOutcome | undefined
let round = 0
for (;;) {
  try {
    outcome = await step.do(`execute#${round}`, {
      retries: { limit: EXECUTE_RETRIES, delay: '10 seconds', backoff: 'exponential' },
      timeout: '10 minutes',
    }, () => withStepDatabase(env, cfg, db => executeRun(db, cfg, env, logger, params)))
  } catch (err) { logger.error({ err }, 'agent-run: execute step failed'); break }

  if (outcome.status !== 'awaiting_input') break

  try {
    await step.waitForEvent(`resume#${round}`, {
      type: AGENT_RESUME_EVENT,               // 'agent-resume' — NOT 'agent.resume' (T8)
      timeout: cfg.AGENT_INTERRUPT_TIMEOUT,
    })
  } catch {
    outcome = await step.do(`expire#${round}`, …)
    break
  }

  if (++round > MAX_INTERRUPT_ROUNDS) { /* settle failed */ break }
}
return step.do('finish', …)
```

## Four things to get right

**Step names must be unique per instance** — hence `#${round}`. A fixed `'execute'` inside a loop is
a *replayed result*, not a second run, and the bug reads as "the agent ignored my approval".

**The existing `try/catch` around `execute` moves inside the loop**, and must not swallow a parked
outcome into the `finish` fall-through.

**`MAX_INTERRUPT_ROUNDS` (32)** is not in issue #17 and is needed: a buggy agent asking the same
question every round otherwise grows step state without bound inside one instance. The budget is
10,000 steps (25,000 max), so 32 rounds × 2 steps is nowhere near it — this is a correctness guard,
not a capacity one.

**`finishStep` gains an `awaiting_input`/expiry arm** settling **`cancelled` with `error` NULL** and
the reason on a `status` event row — *a cancel is a status, not a message*. Its existing backstop
predicate stays `queued|running` (T7), or every legitimately parked run becomes `failed`.

## The `sendEvent → not_found` fallback

Lives in `services/agents/runs.ts` (`nudgeOrRestartInstance`, [phase 3](03-runtime.md)) and is
called by the resolve route in [phase 5](05-routes.md), not by the Workflow. Recorded here because
it is what makes the loop survive a lost instance:

- `instance.not_found` is an **answer**, not an error.
- Create a new instance seeded from the row; ids go `${runId}` → `${runId}-r1` → `${runId}-r2` (T5).
- `agent_runs.instanceId` becomes *the latest* instance, stays `unique()`.
- **The new instance's `claim` succeeds only because the resolve route already flipped the row to
  `running`** (T4, decision 2). This is the coupling to hold in your head.
- `docs/CONCEPTS.md` §9's "instance id IS the run id" is corrected in the same PR.

## Test-harness changes needed

- `createFakeWorkflowStep()` (`tests/mocks/cloudflare-workers.ts:70`) currently **throws** on
  `waitForEvent`. It needs a recorder: queued events, a timeout mode, and the recorded step names.
- `RecordingWorkflow.sendEvent` (`tests/mocks/bindings.ts:400`) is a **no-op**. It needs to record,
  plus a `notFoundOnSendEvent` switch to drive the fallback path.

## Done when

- [ ] recorded step names are distinct per round
- [ ] resume re-enters `execute` and the run completes
- [ ] timeout settles `cancelled` with **NULL `error`**
- [ ] `MAX_INTERRUPT_ROUNDS` fails cleanly
- [ ] `finishStep` does **not** fail a parked row
- [ ] `sendEvent → not_found` creates `${runId}-r1` and the run completes (T4/T5)
- [ ] `reconcileRun` leaves a `'waiting'` instance alone

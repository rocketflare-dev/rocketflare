# Verification

Gate on every phase: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Do this first, before phase 1

Write the `tests/config/agui-contract.test.ts` case that round-trips `RUN_FINISHED` **with an
interrupt outcome** over SSE **and protobuf**.

Issue #17 asserts this works from a hand round-trip (56 bytes, structurally identical), and
`@ag-ui/proto@0.0.59` ships no readable `.d.ts` to confirm it statically. **If it fails there is no
cheap mitigation**: `PROTO_UNSUPPORTED_EVENTS` (`services/ai/agui.ts:25`) drops by event *type*, and
dropping all `RUN_FINISHED` on the protobuf wire is unacceptable. The fix would be turning that list
into a per-event predicate plus a `kit.` CUSTOM fallback carrying the interrupts for protobuf
clients — a different shape for phases 5 and 6. Knowing which world we are in is worth an hour.

## Automated

| Area | What |
|---|---|
| `tests/config/agui-contract.test.ts` | the interrupt outcome over SSE **and** protobuf; `resume[]` parses through `kitRunAgentInputSchema`; every new `kit.*` payload round-trips |
| `tests/config/wrangler-parity.test.ts` | `AGENT_INTERRUPT_TIMEOUT` in **both** tomls |
| new pure test (**T8**) | `AGENT_RESUME_EVENT` matches `/^[A-Za-z0-9_-]{1,100}$/`. Cloudflare rejects `.` with `workflow.invalid_event_type`, and **no existing test would catch it** — `createFakeWorkflowStep` never validates the name, so it would first appear on a real approval in production |
| new pure tests | the four payload schemas; `INTERRUPT_REJECTION`; `fieldsFromJsonSchema` incl. the **whole-form** fallback; `expiryState` tick selection; the timeline reducer (grouping, implicit close, `__preamble__`/`__tail__`, tool duration from start→end — the `at`-overwrite regression, **idempotence under duplicated events**) |
| `tests/api/agent-runs.test.ts` | park writes the row + `awaiting_input` + notification + nudge; **a second enqueue while parked deduplicates**; a parked run can be cancelled and its interrupts expire; 409 on a double answer; 403 for another member under `approvers: 'admin'`; another tenant's interrupt is a 404; `editedInput` without `allowEdits` is a 400; steering on a settled run is a 409 |
| `tests/api/agent-run-workflow.test.ts` | `executeRun` returns `awaiting_input` and **keeps the checkpoint with `finished_at` NULL**; resume re-enters and completes; **step names unique per round**; timeout settles `cancelled` with **NULL `error`**; `MAX_INTERRUPT_ROUNDS` fails cleanly; `finishStep` does not fail a parked row |
| new `agent-tool-loop-interrupt.test.ts` | the gate raises **before** the handler runs (assert the spy is **not** called); a whole turn parks when one of three calls is gated; resume executes pending calls (**T1**); approve-with-edits changes the args the handler sees; `cancel_run` vs `tell_model`; **an approved tool executes exactly once across a step retry** |
| new | `ctx.interrupt` create-or-read idempotency across a re-entered execute (**T2**); a handler-raised interrupt parks instead of becoming `isError` (**T3**); `sendEvent → not_found` creates `${runId}-r1` and the run completes (**T4/T5**); `expireParkedRun` settles a park with no instance (**T6**); `reconcileRun` leaves `'waiting'` alone; a steering note is delivered once across two attempts and never produces two user turns |
| new `agent-run-stream.test.ts` | inject `{ now, sleep }`; 403/404/400 **before the first frame**; `?afterSeq=` wins over `Last-Event-ID`; **`id:` only on the last frame of each row's group**, and a mid-group drop resumes at the previous row; a parked run emits the interrupt outcome and closes (the seven-day test); idle and duration caps close with **no** terminal event; a body error emits **no `RUN_ERROR`**; under protobuf no `id:` and **no comment frames**; `reconcileRun` called exactly once |
| `tests/api/agui-projection.test.ts` | equivalence — `projectRunToAgui(run, rows)` ≡ `head + rows.flatMap(push) + finish(run)`; two parallel calls to the same tool pair correctly; rows without `toolCallId` pair by name exactly as before |
| `tests/api/rls-coverage.test.ts` | green for both new tables |
| `tests/config/kit-manifest.test.ts` | green — `docs/plans/**` is claimed in `.rocketflare.json` |
| `tests/ui/` | `runPollInterval('awaiting_input') === false`; `streamEnabled` matrix; the panel per kind; 409 renders as "somebody else answered"; a nudge does **not** wipe `['agent-run-agui']`; a settled run renders identically streamed vs fetched; the SideNav badge incl. the collapsed dot |
| `tests/config/ui-bundle.test.ts` | still zero markdown in the main chunk; `RunPage` lands lazily |

## Test-harness work this needs

- `createFakeWorkflowStep()` (`tests/mocks/cloudflare-workers.ts:70`) **throws** on `waitForEvent`
  today — it needs a recorder with queued events and a timeout mode.
- `RecordingWorkflow.sendEvent` (`tests/mocks/bindings.ts:400`) is a **no-op** — it needs to record,
  plus a `notFoundOnSendEvent` switch.

## By hand, under `wrangler dev`

This is the acceptance walkthrough, and the only way to exercise `waitForEvent` — the Node suite
cannot.

1. `pnpm dev:db:up && pnpm db:migrate && pnpm seed --demo && pnpm dev`; sign in at
   `/login?as=owner@example.test`; start **Summarise text** with *index the result* on.
2. Watch the timeline fill **live**, then park on *"Add this summary to the knowledge base?"*.
   Confirm the Agents nav badge shows 1 and the bell **deep-links to the run**.
3. As `admin@example.test` in a second browser, answer the same interrupt — **one 200, one 409**,
   and the 409 renders as "somebody else answered", not an error toast.
4. Confirm the run completes and the document appears **exactly once** in `/documents`.
5. Park it again and **restart `pnpm dev`** before answering — the run resumes across the restart.
   That is the durability claim, and it also exercises `sendEvent → not_found` → `${runId}-r1`.
6. Park it again and **cancel** — settles `cancelled`, `error` NULL, interrupts `expired`.
7. Ask `research-topic` something ambiguous, answer its `choice` (raised from a tool handler), then
   send a **steering note** mid-run and see it in the timeline and in the answer.
8. Reload a settled run: identical to the streamed version.
   `curl -N -H 'Accept: text/event-stream' …/agui/stream` shows `data:`-only frames with `id:` on
   group boundaries only.

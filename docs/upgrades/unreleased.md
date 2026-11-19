---
version: unreleased
previous: 0.38.0
date: null
breaking: true
migrations:
  - "agent_run_turns (new table, tenant-isolated): the tool loop's journal of model turns and tool results"
  - "agent_runs gains agent_version, worker_version_id, parent_run_id (self-FK, cascade) and budget; agent_run_interrupts gains assignee_user_ids, assignee_group_ids, remind_at and reminded_at"
areas: [db, api, shared, config, cli, ui, tooling, docs]
touches_surfaces: [feature-agents]
requires_surfaces: []
manual: false
---

## What changed

Agent runs survive crashes and cancels: the tool loop records each model turn and tool result, so a retry neither re-bills a turn nor re-runs a finished tool; a cancel reaches the call in flight; a cron settles lost runs.

- `runToolLoop({ journal: ctx.journal })` records turns and tool results in the new `agent_run_turns` table, and serves them on a retry, mid-turn included.
- The loop now checkpoints a turn BEFORE its tools run, as well as after.
- `Tool.sideEffects` writes a `started` marker first. A retry that finds the marker with no result settles the call as an unknown outcome (`UNKNOWN_OUTCOME_RESULT`), unless the tool is also `Tool.durable`, in which case it re-runs with `call.idempotencyKey`.
- Handlers receive a second argument, `ToolCallInfo { toolCallId, idempotencyKey }`.
- `ctx.journal` is on every agent context and is scoped like other keys: a loop inside `ctx.map` resumes from its own journal. A plugin's `ctx.toolLoop` binds it automatically.
- **Breaking:** `ctx.once(label, fn, { inputs })` keys on `label#<hash of inputs>`. A key used twice in one attempt, whether by two `once` calls or two loops, fails the run with `EffectKeyConflictError` (event code `agent_effect_key_conflict`).
- Replay serves loop turns from the journal: a changed turn is reported as `drift` in strict mode and asked again in live mode. `orderDrift` reports moved top-level keys. Either one makes the verdict `differs`.
- `AGENT_TRANSCRIPT_RETENTION_DAYS` (default 30, optional) sets how long a settled run keeps its journal. It is pruned nightly by `pruneAgentTurns` on the `0 4 * * *` cron.
- The run body is now `runAgentRun` in `workflows/agent-run-body.ts`, written against the neutral `Step` type in `src/platform/types.ts`. `AgentRunWorkflow` is now only the Cloudflare adapter.
- A cancel now reaches the model call in flight. Each attempt polls its run every 3 s and aborts `ctx.signal`, and every `ctx.chat.client` call is raced against that signal. An aborted attempt settles `cancelled`, never as a retryable failure. `ctx.signal` is new on `AgentContext` and on a plugin's `AgentCtx`.
- **Breaking (AG-UI):** a cancelled agent run now projects as `RUN_FINISHED { outcome: { type: 'cancelled' } }`, not `RUN_ERROR` with code `agent_run_cancelled`.
- A new `*/10 * * * *` cron runs `sweepLostRuns`, which settles active runs whose Workflow instance ended unsettled, for runs nobody opens.
- Tracing:
  - The first claim exports a zero-length `run started` span under the run's root id, so a backend lists an in-flight run.
  - Run spans carry `gen_ai.conversation.id` (the run id).
  - Job spans are now named `invoke_workflow <type>` instead of `job <type>`.
  - Captured model spans carry `gen_ai.input/output.messages_ref` URIs to `GET /api/traces/:id`.
  - Every export names its conventions version as `schemaUrl` (semconv 1.45.0, `GENAI_SEMCONV_VERSION`).
- Workflows' `concurrency.limit` was evaluated and is not set. It caps instances across all tenants and does not count parked ones, so it cannot back the per-tenant cap (`docs/DEPLOY.md`).
- Why: `docs/CONCEPTS.md` §9 "Durable loop (D44)".

Phase 3 adds version pinning, HITL deadlines, reminders and assignees, child runs, and a run inspector.

- **Versions.** Each run records `agent_version` (the agent's `meta.version`, default 1) and `worker_version_id` (from a new `[version_metadata]` binding, `CF_VERSION_METADATA`). An attempt that finds a different `meta.version` applies `meta.onVersionChange`:
  - `continue` is the default;
  - `fail` fails the run with code `agent_version_changed`;
  - `rerun` cancels the run and starts a new one with idempotency key `rerun:<id>`.
  - `pinned: true` forces `fail` and allows order-derived `ctx.once` keys (`label@2`).
- **Recordings check.** `agent:replay --record <dir>` writes runs as JSON. `tests/api/agent-recordings.test.ts` replays every file in `apps/web/tests/agent-recordings/` and fails with "bump `meta.version`" when a key-moving change arrives at the same version.
- **HITL.** `meta.hitl = { timeout, remindAfter, onTimeout: 'expire' | 'reject' }` adds a per-agent deadline (capped at `AGENT_INTERRUPT_TIMEOUT`) and one reminder per ask, sent by `sendReminders` on `*/10`. `reject` answers an expired ask as a rejection and wakes the run.
- **Assignees.** An ask may name `assignees: { userIds, groupIds }`. Assignees are the people notified, see the ask in their inbox, may read the run and may answer. Owners and admins always may answer too.
- **Child runs.** `ctx.spawn(key, agentKey, input)` starts a child run (`parent_run_id`) and parks the parent with no ask until the child settles.
  - The child gets the parent's remaining budget, and the parent's meter counts the children's spend.
  - A cancel cascades to children.
  - Children are left out of `GET /runs` unless `?parentRunId=` is given.
  - New error code `agent_child_failed`. A plugin's `AgentCtx` gains `spawn`.
- **Inspector.** `GET /api/agents/runs/:id/timeline` (`@rocketflare/shared/ai/agent-timeline`) backs `rocketflare agents inspect <runId>` and the run page's admin **Inspect** tab. `GET /runs` gains the `since` and `agentVersion` filters, and the CLI `runs list` gains `--parent`, `--since` and `--agent-version`.
- **Breaking:**
  - `runSpend` takes an optional fourth argument.
  - `budgetFor` takes an optional third argument.
  - `RunMeter` gains `budget`.
  - `notifyApprovers` moved from `runtime.ts` to `hitl.ts` and now takes the ask row.
  - `GET /api/agents/runs` no longer lists child runs by default.
- Why: `docs/CONCEPTS.md` §9 "Versions, children, inspector (D44 phase 3)".

Lint (#162):

`pnpm lint` now fails on a Biome warning as well as an error, and the 29 warnings and 3 infos that `--diagnostic-level=error` had hidden are fixed.

- Both `lint` scripts (root and `apps/web`) run `biome check . --error-on-warnings`; `GATE_STEPS` displays the same command, and `.claude/rules/code-quality.md` says a warning fails the step.
- Nine `biome-ignore lint/suspicious/noExplicitAny` comments in `apps/web/tests/` are removed: `biome.json` already turns that rule off there.
- Optional chains replace `!x || x.y !== …` (agent loop, runs, ingest, AG-UI, plugin-lib), and statements replace two comma operators.
- `createInvitation` and `resendInvitation` keep the `(db, cfg, logger, …)` service signature with an unused `_logger`; `requireClean` in `scripts/plugin.mjs` drops its unused `host`.
- `RunToolLoopOptions.beforeTurn` returns `Promise<ChatMessage[] | undefined>`, not `void` in a union.
- `globToRegExp` tests its escape set with a regex character class; `chunking.ts` uses `Math.min`; three template literals replace string concatenation; tests drop `!` assertions.
- The gate's test output carries no warnings: the unreadable-API `gatedDecision` test asserts its two `::warning::` lines (and its `runs()` helper now keeps `null`), and the UI setup stubs `window.scrollTo`, which jsdom lacks.

## How to apply

1. Port the `agent_run_turns` table: copy `apps/web/src/db/schema/agent-run-turns.ts`, export it from `apps/web/src/db/schema/index.ts`, then run `pnpm db:generate` and `pnpm db:migrate`.
2. Copy `apps/web/src/api/services/agents/keys.ts` and `apps/web/src/api/services/agents/turns.ts`, and apply the diff to `services/ai/agent-loop.ts`, `services/agents/{runtime,registry,fanout,replay}.ts`, `plugins/api/ai.ts` and `scripts/agent-replay.ts`.
3. Copy `apps/web/src/platform/types.ts` and `apps/web/src/api/workflows/agent-run-body.ts`, and replace `apps/web/src/api/workflows/agent-run.ts` with the kit's adapter. If you changed the old `AgentRunWorkflow.run`, move your change into `runAgentRun`.
4. Add `agentEffectKeyConflict` to `ERROR_CODES` in `packages/shared/src/errors.ts`.
5. Add `runPruneAgentTurns` and `pruneAgentTurns` to `apps/web/src/api/scheduled.ts`, list `pruneAgentTurns` under `'0 4 * * *'`, and add `AGENT_TRANSCRIPT_RETENTION_DAYS: optionalPositiveInt(30)` to `apps/web/src/config.ts`. Extend the `src/api/scheduled.ts` entry in `apps/web/tests/config/unscoped-allowlist.test.ts` to name `runPruneAgentTurns`.
6. In every agent of your own that calls `runToolLoop`, add `journal: ctx.journal`. If a loop's state comes from tool results (as `research-topic`'s citations do), rebuild it from `loop.messages` after the loop: a served result emits no `onEvent`.
7. Mark every tool of your own that writes, sends or charges with `sideEffects: true`. If its handler passes `call.idempotencyKey` to a system that deduplicates on it, also set `durable: true`.
8. Search your agents for `ctx.once(` calls that run in a loop or more than once under the same key. Pass the differing value as `{ inputs }`, because a reused key now fails the run.
9. If a test asserts the number of `onCheckpoint` calls or a tool handler's exact arguments, update it: a turn with tools now checkpoints twice, and handlers receive `ToolCallInfo` as a second argument.
10. Copy `apps/web/src/api/services/agents/cancel.ts`. Apply the diff to `runtime.ts` (`watchCancel`, `abortableChatClient` around both chat clients, `signal` on the context, the aborted-signal catch arm, `cancel.stop()` in `finally`, `recordRunStarted`, `claimStep`'s `trace` argument), and to `registry.ts`, `replay.ts`, `plugins/api/ai.ts` and `workflows/agent-run-body.ts` (`claimStep(…, { cfg })`). Pass `signal: ctx.signal` to each of your own `runToolLoop` calls.
11. In `agui-projection.ts`, project `cancelled` as `RUN_FINISHED` with `outcome: { type: 'cancelled' }`. If a client of yours matched `agent_run_cancelled`, switch it to the outcome.
12. Add `sweepRun` to `services/agents/runs.ts`, and `runSweepLostRuns` / `sweepLostRuns` under `'*/10 * * * *'` to `scheduled.ts`. Add `"*/10 * * * *"` to `[triggers] crons` in BOTH tomls (and in `tests/config/fixtures/wrangler{,.staging}.toml` if you kept them).
13. Apply the observability diff: `genai-attributes.ts` (`GENAI_SEMCONV_VERSION`, the `_ref` and `runPending` names, `job` → `invoke_workflow`), `otlp-fetch.ts` and `otlp-protobuf.ts` (`schemaUrl`, `contentRefBase`), and `tracing.ts`. Rename your own jobs' `spanName: 'job <type>'` to `'invoke_workflow <type>'`. Saved Langfuse or Phoenix filters on `job …` names need the new name.

14. Phase 3: run `pnpm db:migrate` after porting `agent-runs.ts` and `agent-run-interrupts.ts` (or `pnpm db:generate` if you changed either table). Copy `services/agents/{versions,hitl,children,timeline}.ts` and `packages/shared/src/ai/agent-timeline.ts`. Apply the diff to:
    - `runs.ts`;
    - `runtime.ts`;
    - `budget.ts`;
    - `keys.ts`;
    - `replay.ts`;
    - `registry.ts`;
    - `fanout.ts`;
    - `interrupts.ts`;
    - `services/ai/usage.ts`;
    - `scheduled.ts` (`sendReminders`);
    - `routes/agents.ts`;
    - `plugins/api/ai.ts`;
    - the shared `agents.ts`, `interrupts.ts` and `errors.ts`.
15. Add `[version_metadata]` with `binding = "CF_VERSION_METADATA"` to BOTH tomls (and to the test fixtures, if you kept them). Then run `pnpm --filter @rocketflare/web exec wrangler types`.
16. If one of your agents should not continue across a deploy, set `meta.version` and `onVersionChange`. To have the gate catch a key change that came without a version bump, record a run into `apps/web/tests/agent-recordings/` with `--record`.
17. If your code lists runs through `GET /api/agents/runs` and expects children, pass `parentRunId`. If your own code called `notifyApprovers`, import it from `services/agents/hitl`.
18. Port the CLI `agents inspect` (`apps/cli/src/commands/agents.ts` and `cli.ts`) and the UI Inspect tab (`RunInspectTab.tsx`, `useAgentRunTimeline`, and `queryKeys.agentRuns.timeline`).
19. In the root `package.json` and `apps/web/package.json`, change the `lint` script from `biome check . --diagnostic-level=error` to `biome check . --error-on-warnings`.
20. In `scripts/lib/gate-lib.mjs`, change the `lint` step's `display` to `biome check . --error-on-warnings`.
21. In `.claude/rules/code-quality.md`, replace "`pnpm lint` (errors only)" with "`pnpm lint` (a warning fails it, as an error does)".
22. Port the kit diff's code edits from the release; every one is local to the line Biome names.
23. Run `pnpm exec biome check .` and fix each warning it still reports in your own code: an app's own code can carry warnings the kit never had.
24. Port `apps/web/tests/config/ci-workflows.test.ts` (the `runs()` helper and the unreadable-API case) and the `window.scrollTo` stub in `apps/web/tests/ui/setup.ts` from the release.

## Conflicts to expect

- `apps/web/src/api/workflows/agent-run.ts` → the body moved to `agent-run-body.ts` → take the kit's adapter, then re-apply your own step changes in `runAgentRun`.
- `apps/web/src/api/services/agents/examples/research-topic.ts` → `journal`, plus `rehydrateSeen(loop.messages)` after the loop → keep your edits, and add both.
- `apps/web/src/api/services/agents/CLAUDE.md`, `services/ai/CLAUDE.md`, `workflows/CLAUDE.md` → rows and rules for the journal → take the kit's text.

- `apps/web/wrangler.toml` / `wrangler.staging.toml` `[triggers] crons` → one new line → keep your own crons, and add `"*/10 * * * *"` to both files.
- `apps/web/src/api/services/agents/agui-projection.ts` → the `cancelled` arm → take the kit's.

- `apps/web/src/api/services/agents/runtime.ts` → `notifyApprovers` moved out to `hitl.ts`, and new catch arms for child runs were added → take the kit's version, then re-apply your own changes.
- `apps/web/src/api/services/invitations.ts` → the unused `logger` became `_logger` → keep yours if your copy uses the logger there.
- Any line your copy changed near a Biome warning → the kit rewrote that line → keep your change and fix the warning by hand.

## Verify

1. `pnpm gate` passes.
2. `pnpm web test:api -- tests/api/agent-loop-journal.test.ts tests/api/agent-durable-loop.test.ts` passes.
3. After one `research-topic` run, `SELECT role, count(*) FROM agent_run_turns WHERE run_id = '<id>' GROUP BY role` returns rows for both `model` and `tool`.
4. `pnpm web agent:replay research-topic --tenant <slug>` reports that run as `match`, with `turns n/n served`.
5. `pnpm web test:api -- tests/api/agent-sweeper.test.ts` passes. `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=*/10+*+*+*+*"` logs `sweepLostRuns` while `pnpm dev` is running.
6. Start a `research-topic` run and cancel it while the model is answering: it settles `cancelled` within about 3 s, and `GET /api/agents/runs/<id>/agui` ends with `RUN_FINISHED` `outcome.type: "cancelled"`.
7. `pnpm web test:api -- tests/api/agent-versions.test.ts tests/api/agent-hitl.test.ts tests/api/agent-children.test.ts tests/api/agent-recordings.test.ts` passes.
8. `pnpm cli agents inspect <runId>` prints the run's version, spend and records.
9. `pnpm exec biome check .` reports no warnings and no infos.
10. `pnpm gate` passes, and its lint step prints `biome check . --error-on-warnings`.
11. `pnpm test` prints no `::warning::` line and no `Not implemented: Window's scrollTo()` line.

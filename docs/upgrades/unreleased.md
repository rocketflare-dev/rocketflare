---
version: unreleased
previous: 0.38.0
date: null
breaking: true
migrations:
  - "agent_run_turns (new table, tenant-isolated): the tool loop's journal of model turns and tool results"
areas: [db, api, shared, config, docs]
touches_surfaces: [feature-agents]
requires_surfaces: []
manual: false
---

## What changed

Agent tool loops record each model turn and tool result as it settles, so a retried attempt is never billed twice or re-runs a finished tool, and tool-loop runs replay strictly.

- `runToolLoop({ journal: ctx.journal })` records turns and tool results in the new `agent_run_turns` table, and serves them on a retry, mid-turn included.
- The loop now checkpoints a turn BEFORE its tools run, as well as after.
- `Tool.sideEffects` writes a `started` marker first. A retry that finds the marker with no result settles the call as an unknown outcome (`UNKNOWN_OUTCOME_RESULT`), unless the tool is also `Tool.durable`, in which case it re-runs with `call.idempotencyKey`.
- Handlers receive a second argument, `ToolCallInfo { toolCallId, idempotencyKey }`.
- `ctx.journal` is on every agent context and is scoped like other keys: a loop inside `ctx.map` resumes from its own journal. A plugin's `ctx.toolLoop` binds it automatically.
- **Breaking:** `ctx.once(label, fn, { inputs })` keys on `label#<hash of inputs>`. A key used twice in one attempt, whether by two `once` calls or two loops, fails the run with `EffectKeyConflictError` (event code `agent_effect_key_conflict`).
- Replay serves loop turns from the journal: a changed turn is reported as `drift` in strict mode and asked again in live mode. `orderDrift` reports moved top-level keys. Either one makes the verdict `differs`.
- `AGENT_TRANSCRIPT_RETENTION_DAYS` (default 30, optional) sets how long a settled run keeps its journal. It is pruned nightly by `pruneAgentTurns` on the `0 4 * * *` cron.
- The run body is now `runAgentRun` in `workflows/agent-run-body.ts`, written against the neutral `Step` type in `src/platform/types.ts`. `AgentRunWorkflow` is now only the Cloudflare adapter.
- Why: `docs/CONCEPTS.md` §9 "Durable loop (D44)".

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

## Conflicts to expect

- `apps/web/src/api/workflows/agent-run.ts` → the body moved to `agent-run-body.ts` → take the kit's adapter, then re-apply your own step changes in `runAgentRun`.
- `apps/web/src/api/services/agents/examples/research-topic.ts` → `journal`, plus `rehydrateSeen(loop.messages)` after the loop → keep your edits, and add both.
- `apps/web/src/api/services/agents/CLAUDE.md`, `services/ai/CLAUDE.md`, `workflows/CLAUDE.md` → rows and rules for the journal → take the kit's text.

## Verify

1. `pnpm gate` passes.
2. `pnpm web test:api -- tests/api/agent-loop-journal.test.ts tests/api/agent-durable-loop.test.ts` passes.
3. After one `research-topic` run, `SELECT role, count(*) FROM agent_run_turns WHERE run_id = '<id>' GROUP BY role` returns rows for both `model` and `tool`.
4. `pnpm web agent:replay research-topic --tenant <slug>` reports that run as `match`, with `turns n/n served`.

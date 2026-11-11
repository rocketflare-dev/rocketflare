# Agent runtime

The agent runtime on Cloudflare Workflows. One table (`agent_runs`), one event log
(`agent_run_events`), one Workflow class (`AgentRunWorkflow`, `../../workflows/agent-run.ts`), one
registry. **Routes enqueue, never run**: never call an agent's `run()` from a route.

| File | Role |
|---|---|
| `registry.ts` | `AGENTS: Record<AgentKey, AgentDefinition>`; `AgentDefinition = { meta: AgentMeta, run(ctx) }`; `AgentContext` — `db`, `cfg`, `env`, `tracer` (the step's recorder), `input`, `emit`, `checkCancelled`, `chat { client, model, maxOutputTokens }`, `tools`, `checkpoint { load, save }`, `once`, `interrupt` / `steering` / `artifact` / `approvals`, `decide`, `prompt(vars, promptKey?)` (a second key resolves ANOTHER registry prompt, to run another agent's body), `step`, `scope` / `map`, `recordUsage` |
| `fanout.ts` | `withFanout(base)` attaches `scope` and `map`. A scope prefixes every keyed primitive (`once`, `decide` + `sift`/`pick` via `decideWithShapes`, `interrupt`, `artifact`, `step`) with `<prefix>/` and has NO checkpoint. `map` runs item `i` as `once('key[i]', () => fn(item, scope('key[i]')), { replay: 'inner' })`, at most `min(concurrency ?? 4, AGENT_MAP_MAX_CONCURRENCY = 6)` at once; the first real error stops scheduling and is thrown after in-flight items settle; `InterruptRequested` does NOT stop scheduling — every ask merges into one `InterruptRequested`, in item order (one park) |
| `budget.ts` | The run's meter. `createRunMeter` starts from `runSpend` (every attempt's `ai_usage` rows); `check()` before each call (`meta.budget` over `AGENT_RUN_MAX_TOKENS` / `AGENT_RUN_MAX_COST_USD`, then `AGENT_TENANT_DAILY_COST_USD` via `tenantAgentSpendToday`) throws `AgentBudgetExceededError` (never retried → `failed`, event `code: 'agent_budget_exceeded'`); `record()` writes one row with the run id, AWAITED. `meterChatClient(client, meter, { feature?, billedToPlatform? })` wraps the traced client OUTSIDE the trace (a refused call opens no span) — `ctx.chat.client`, and `ctx.decide`'s chat fallback through `resolveDecisions`' `wrapChat` with the `agent-decide` resolution's `billedToPlatform`. `assertTenantDailyBudget` / `TenantBudgetExceededError` (429 `ai_budget_exceeded`) is the enqueue-time half |
| `decisions.ts` | `ctx.decide`: `createDecide(deps)` → `(key, { state, questions })` plus `.sift(key, …)` (one request, the same `noul` per item, kept at `threshold`) and `.pick(key, …)` (one `choice` over the items + `none`). **Recorded once per `(run_id, key)`** in `agent_run_decisions` — a re-entered `run()` gets the stored answers (`replayed: true`); the same key with a different `questions_hash` throws `DecisionKeyConflictError`. The engine resolves LAZILY (`resolveDecisions`). A fresh call writes: `decide <key>` span, row, `ai_usage` (`agent:<key>:decide` — once per ask for TypeSafe; per model call, from the metered client, for the `llm_self_report` fallback), then a `decision` event with answers in QUESTION order (jsonb reorders keys, so the row cannot be the source) |
| `interrupts.ts` | `requestInterrupt` (**create-or-read on `(run_id, key)`**), `resolveInterrupt` (**one** compare-and-set on `pending`; null → 409), `expireInterrupts`, `approvalsForRun` (settled asks by `toolCallId`; `expired` reads as a decline), `interruptExpiryFrom` (`AGENT_INTERRUPT_TIMEOUT`; unparseable = no deadline, never a failure). `reason` is written ONLY by `aguiReasonFor`; `responseSchema` is DERIVED from `interruptPayloadSchema(spec)`, never hand-written |
| `artifacts.ts` | `upsertArtifact` — **`key` is the upsert key** (a redraft replaces itself, safe on a retry); validated against the shared contract HERE, since the size caps keep a jsonb column bounded |
| `tools/` | Built-ins on `ctx.tools` (`buildAgentTools(ctx)` in `index.ts` — add kit-wide tools there, never import `searchChunks` into an agent), all bound to the run's `AccessScope` and all answering JSON. `search_knowledge`: hybrid `searchChunks`, WHOLE passages (≤ `PASSAGE_MAX_CHARS`) in a `RESPONSE_MAX_CHARS` budget, grouped by document with `passage`/`charOffset`; every answer carries `note` (nearest-neighbour, NOT a relevance filter), nothing indexed → `knowledgeBase` + `hint`, no embeddings → `{ error: 'knowledge_search_unavailable', hint }`; `buildAgentTools` also passes the union of the plugins' `knowledgeSources(scope)` (`pluginKnowledgeSources`) as `platformSources`, and those documents come back `platform: true` (get_document cannot open them). `get_document`: `{ offset, maxChars }` window; **the cap is the CALLER's** `AgentToolContext.maxDocumentChars` (`GET_DOCUMENT_MAX_CHARS` for a run, `CHAT_GET_DOCUMENT_MAX_CHARS` from `chat-turn.ts`); an over-ask is CLAMPED, never rejected. `list_documents`: indexed only, newest first; `listKnowledgeDocuments` feeds the others' dead ends. A hidden id is answered exactly like an unknown one |
| `examples/summarize-text.ts` | Single-call: exclusive, one terminal tool via `callStructuredTool`, optional `ingestText` when `input.index` |
| `examples/research-topic.ts` | Agentic: `runToolLoop` over `[...ctx.tools, submit_answer]`, `ctx.checkCancelled()` in `onStep` (the loop takes no `AbortSignal`), each `onEvent` → an event row. Ending without the terminal call is salvaged by `meta.policy` (`onExhaustion: 'final-answer'`); citations are filtered to the ids the tools returned, so a hallucinated id is dropped |
| `examples/triage-research.ts` | Decisions, and the one NON-exclusive (batchable) built-in: one `search_knowledge` frozen by `ctx.once('triage:search')`, `ctx.decide.sift('relevant', …)`, `ctx.decide('answerable', …)`, then CODE routes — low confidence → `research-topic`'s body on its own prompt, P(yes) < 0.5 → "not covered" with no model call, else one forced answer under `ctx.once('triage:answer', fn, { replay: 'rerun' })` |
| `replay.ts` | `replayRun(db, cfg, env, run, agent, { mode, logger })` runs an agent's CURRENT code over one settled run → `ReplayResult` (`verdict`, `outputDiff`, per-decision status, `misses`, refused `writes`, `reran`). The context answers from the record; chat and tool handlers are misses in `strict`, real in `live`. **Read-only twice over**: a READ ONLY transaction, and `ctx.db` refuses `insert`/`update`/`delete` before the SQL is sent. Driven only by `scripts/agent-replay.ts` (`pnpm web agent:replay`) |
| `run-stream.ts` | `GET /runs/:id/agui/stream`: `runStreamBody` tails `agent_run_events` on ONE connection (`tailRunEvents`, bounded by `RUN_STREAM_TAIL_LIMIT`) through `createRunProjector`. `{ now, sleep }` injected. A parked run needs no branch — `finish` answers `awaiting_input` with the interrupt outcome and the connection closes |
| `agui-projection.ts` | `projectRunToAgui(run, events, { interrupts, artifacts })` — a FOLD over `createRunProjector(run) → { head, push, finish }`; `finish` takes the run as an ARGUMENT (in a stream the row changes underneath). PURE: event row ids ARE the AG-UI message / tool-call ids; `threadId = runId`. Tool calls pair on `data.toolCallId ?? name` while the EMITTED id stays `event.id`. The log says WHERE an ask/artifact appeared, the table what became of it; a row whose entry is absent is skipped, never invented. `awaiting_input` with pending asks ends `RUN_FINISHED { outcome: { type: 'interrupt' } }` (`'interrupt'`, not `'interrupted'`); with NO pending ask, no terminal event (the window before `resumeRun`). A settled `cancelled` run is `RUN_ERROR` `agent_run_cancelled` |
| `runs.ts` | `enqueueRun(db, cfg, env, input)`: validate → the tenant is active (`assertTenantActive`, 403 `tenant_suspended`; `enqueueRunBatch` too) → `idempotencyKey` (run id = `idempotentRunId(tenant, agent, key)`; an existing row is the answer, `deduplicated`, settled or not; a `queued` hit with no instance gets one via `ensureInstance`; a failed `create()` DELETES the idempotent row so the retry starts afresh) → the slot's active run → `{ deduplicated: true }` → `AGENT_MAX_ACTIVE_RUNS_PER_TENANT` (429 `agent_runs_limit`) and daily spend (429 `ai_budget_exceeded`) → insert `queued` (+ `trace_id`) → `AGENT_RUN_WORKFLOW.create({ id: runId })`; no binding → 503 `agent_runs_not_configured`. `enqueueRunBatch` (non-exclusive only, else 400 `agent_exclusive`; ONE insert under a `batch_id`; ONE `createBatch()`, all or nothing, so on a throw each instance is created alone — `already exists` counts as started — and only a real failure settles its row `failed`). `claimRun` (`UPDATE … WHERE status IN (queued,running) RETURNING`, `attempt+1`); `finishRun`/`failRun`/`cancelRun` settle only an ACTIVE row; `parkRun` (`running → awaiting_input`, **not** a settle — `finishedAt` NULL, checkpoint kept); `resumeRun` (`awaiting_input → running`); `nudgeOrRestartInstance` (`sendEvent`; on `instance.not_found` a NEW instance `<runId>-r1`, `-r2`…); `expireParkedRun`; `appendEventAtomic` (`seq` in SQL, one retry on `23505`); `runOnce` / `claimEffect` (`agent_run_effects`, unique `(run_id, key)`); `loadCheckpoint`/`saveCheckpoint` (cleared by every settle). `requestCancel(db, tenantId, runId, realtime?, env?)`: queued → cancelled; running → `cancelRequestedAt`; already cancel-requested → FORCE (`instance.terminate()` best-effort, settle `cancelled`) — pass `c.env`. `reconcileRun`: `instance.status()`; `not_found` → failed; no binding → no-op; **`{ lastEventAt }` inside `RECONCILE_LIVENESS_MS` (30 s) returns the row without touching the binding** — opted into per call site, never defaulted |
| `runtime.ts` | Step bodies as plain functions: `claimStep`, `executeRun`, `finishStep`. `executeRun` settles a run of a suspended tenant `cancelled` (`reason: 'tenant_suspended'`) before any model call. `executeRun(…, { round })` brackets the attempt as `execute#N` in the run's ONE trace (`traceIdForRun`, parent `rootSpanIdForRun`) and flushes in `finally` while the step client is open; only the final `finish` passes `{ cfg }`, which records the root via `recordRunRoot`. `isRetryableRunError`: only `AiError` unavailable/rate_limit and DB-unavailable, while `attempt <= EXECUTE_RETRIES` (2); **`false` for both interrupt types and `ToolLoopExhaustedError`**. Catch arms: `InterruptRequested` → rows, then `parkRun`, then an `interrupt` event and `notifyApprovers` behind `claimEffect('notify:<id>')`; `InterruptDeclinedError` → `cancelRun` + `expireInterrupts` + a `status` event `reason: 'rejected'` (`error` NULL); `ToolLoopExhaustedError` → `failed`, event code `agent_policy_exhausted`. **`finishStep` has TWO arms**: the failure backstop (inline `queued\|running`), and an expiry arm for a row still `awaiting_input` as the workflow ends (expire asks, settle `cancelled`, `reason: 'expired'`) — except a park abandoned at `MAX_INTERRUPT_ROUNDS`, which arrives `outcome.status === 'failed'`: **the outcome decides, never the row** |

Rules:

- **Claim is the row, not the queue.** A retried step re-claims; a settled row is never rewritten.
  **Three status lists diverge on purpose**: `ACTIVE_RUN_STATUSES` (`queued|running|awaiting_input`)
  — the exclusive index, `findActiveRun`, `settle()`, `saveCheckpoint`, every terminal write;
  `CLAIMABLE_RUN_STATUSES` (`queued|running`) — `claimRun` ONLY; `finishStep`'s backstop keeps its
  own inline `queued|running` — widening it turns every parked run into a `failed` row.
- **Exclusive = the partial unique index** `agent_runs_active_exclusive_idx` on `(tenant_id,
  agent_key, concurrency_key)` over active rows with a key. The slot: `input.concurrencyKey` when
  given (one active run per key, whatever `meta.exclusive` says), else `''` for an exclusive agent,
  else NULL (no slot, never `deduplicated`). A non-exclusive agent is the one to batch, and its
  per-run budget is what bounds a bad day.
- **A step retry OR a resume re-enters `run()` from the top**, so side effects (an ingest, a ledger
  write, an outbound call) go through `ctx.once(key, fn)` — `agent_run_effects_run_key_idx` is the
  guarantee; the result is jsonb, so **return ids, not rows**. At-least-once with a recorded
  result, not exactly-once.
- **A resumable loop passes `resume: await ctx.checkpoint.load()` and `onCheckpoint:
  ctx.checkpoint.save`**, so a retry continues the conversation instead of re-billing it. State
  derived from tool results DURING the loop must be rebuilt from the resumed transcript
  (`rehydrateSeen` in `research-topic`), or citations earned before the retry are dropped. An
  unparseable checkpoint is `null` — start fresh, never fail.
- **A loop's limits are `policy: meta.policy`** — never a hand-rolled turn counter or salvage.
  `AGENT_MAX_TURNS` stays the ceiling; every limit counts across attempts; `onExhaustion:
  'final-answer'` (default) forces one call to the single terminal tool, `'fail'` throws
  `ToolLoopExhaustedError`. A tool call a RULE forbids is `authorizeTool`, not a handler check.
- **`ctx.interrupt({ key, spec })` parks the run.** `key` is MANDATORY and stable across attempts —
  `UNIQUE (run_id, key)` is what makes the re-entered `run()` find the ANSWER instead of asking
  forever; derive it from an entity id, a step name or the question, never a counter or a clock.
  Everything after it is on the far side of a park that may span days and a deploy, so it goes
  behind `ctx.once`. A rejection is `status: 'cancelled'`, never an `approved` boolean; its meaning
  is `rejectionFor(spec)` — a declined `approval` throws `InterruptDeclinedError`,
  `choice`/`input`/`form` hand the refusal to the model. The catch arm writes **the rows first and
  parks second**: a row with no park re-asks, a park with no row hangs.
- **The answer is the transition.** The resolve route flips the interrupt row, then `resumeRun`,
  and only THEN `nudgeOrRestartInstance`; `sendEvent` carries `{ interruptId }` only — a payload on
  the wire would be a second source of truth. `instance.not_found` is recovered (`<runId>-r1`).
- **A gated tool is gated by the LOOP, never its handler.** `Tool.requiresApproval` /
  `requiresApprovalWhen(input)` make `runToolLoop` scan the whole turn before any handler runs,
  checkpoint, and raise. `resumePendingToolCalls` answers the trailing `tool_use` blocks through
  **the same** `executeToolUses` — never fork it, or the gate is bypassed on resume. Pass
  `approvals: ctx.approvals` and `runApproved: ctx.once`, or the gate is re-asked and the approved
  call runs twice. `ctx.steering()` delivers notes exactly once; fold them in through `beforeTurn`.
- **Reads**: `GET /runs/:id` reads the log, THEN settles (`settleOnRead`: `reconcileRun` with the
  log's newest `at` as `lastEventAt`, then `expireParkedRun`), THEN reads the asks — asks read
  before the settle return a `pending` ask beside a `cancelled` run.
- **Run stream (`run-stream.ts`) — a READ stream inverts the terminal convention.** It owns
  nothing, so **no `RUN_ERROR` for its own failure**: it logs and closes, and closing with no
  terminal event means *reconnect*. The SSE **`id:` goes on the LAST frame of a row's group and on
  no other** (a mid-group drop must resume at the previous row). **`reconcileRun` exactly once,
  before the first frame, never in the loop** (nor any other Workflow/DO subrequest). **Never a
  `: ping` frame in binary mode** (not valid protobuf). `?afterSeq=` beats `Last-Event-ID`; a
  garbage explicit cursor is a 400, a garbage header is ignored.
- **Fan out with `ctx.map`, never `Promise.all` over `ctx` calls** — two items calling
  `ctx.decide('relevant', …)` collide on `(run_id, key)`. Freeze the item list (`once`) first,
  return jsonb from `fn`, keep `keyOf` stable. A tool loop inside an item restarts on a retry.
  Running another agent's body inline stays a plain spread through `withFanout`, NOT a scope,
  because that body resumes from the run's checkpoint.
- **Usage is the meter's, never the agent's**: no `recordUsage` and no `onUsage` ledger write in an
  agent — `ctx.chat.client` and `ctx.decide` already write one row per call; a second double-counts.
  `ctx.recordUsage(call)` is for a client the agent built itself.
- **Cancellation is cooperative, then forced**: `checkCancelled()` polls between turns (and between
  tool results); `AgentCancelledError` maps to `cancelled`. **The second cancel forces it** —
  nothing polls in a hung model call, and an exclusive agent stuck `running` blocks the tenant.
  `reconcileRun` reads `terminated` as `cancelled`.
- **DB is the truth, WS is a nudge**: events go to `agent_run_events` first, then
  `entity.changed { entity: 'agent-run', id }`.
- **Knowledge**: pass `[...ctx.tools, ...ownTools, terminalTool]` to `runToolLoop`. The tools read
  what the run's REQUESTER may read (scope built at EXECUTE time from `requestedByUserId`; no
  requester → tenant-visible only). Never build a query from a model-supplied tenant id. **A tool
  answer must be actionable** — never a bare "nothing found": `error` + `hint`, and what does exist.
- **The tool loop runs INSIDE one `execute` step, deliberately** (`docs/CONCEPTS.md` §9 Known
  gaps). Do not split it per turn without a profile showing CPU, not I/O, is the limit.
- **A decision is a question, its consequence is code**: `ctx.decide` for "what IS this?", then
  branch in TypeScript on the answer and its `confidence`; never a hand-rolled classifier call and
  never TypeSafe's API from feature code. Keys follow `ctx.once`'s rule; freeze a decision's ITEMS
  behind `ctx.once` first. Never tune a production threshold on the `llm_self_report` fallback
  without an eval.
- **An agent must stay replayable**: everything it learns from outside comes through `ctx` (`once`,
  `decide`, `interrupt`, `tools`, `chat`); a query on `ctx.db` replays against TODAY's data. Mark a
  `once` whose `fn` is a pure model call `{ replay: 'rerun' }`; leave side effects on the default.
- **Per-agent model**: `resolveChat(..., { promptKey: meta.promptKey })` consults `agent_models`.
- Adding an agent: key in `@rocketflare/shared/ai/agents` (`CORE_AGENT_KEYS` + schemas) → prompt in
  `services/prompts.ts` → `examples/<key>.ts` → entry in `CORE_AGENTS` (`docs/ADAPTING.md` §3). No
  migration. (`AGENT_KEYS` / `AGENTS` are those plus every installed plugin's.)

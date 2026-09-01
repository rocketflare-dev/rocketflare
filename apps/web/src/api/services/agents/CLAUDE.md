# Agent runtime (D7, D17)

The pg-boss agent runtime ported onto Cloudflare Workflows. One table (`agent_runs`), one event log
(`agent_run_events`), one Workflow class (`AgentRunWorkflow`, `../../workflows/agent-run.ts`), one
registry. "Routes enqueue, never run."

| File | Role |
|---|---|
| `registry.ts` | `AGENTS: Record<AgentKey, AgentDefinition>`; `AgentDefinition = { meta: AgentMeta, run(ctx) }`; `AgentContext` (db, cfg, env, logger, tracer, tenantId, runId, userId, input, `emit`, `checkCancelled`, `chat { client, model, maxOutputTokens }`, `prompt(vars)`, `step(...)`) |
| `examples/summarize-text.ts` | THE example: exclusive, precheck, one terminal tool via `callStructuredTool`, `step`/`tool.*`/`text` events, `recordUsage('agent:summarize-text')`, optional `ingestText` when `input.index` |
| `runs.ts` | `enqueueRun` (validate → insert `queued` → `AGENT_RUN_WORKFLOW.create({ id: runId })` → `instanceId`; partial-unique dedupe → `{ deduplicated: true }`; no binding → 503 `agent_runs_not_configured`), `claimRun` (`UPDATE … WHERE status IN (queued,running) RETURNING`, `attempt+1`), `finishRun`/`failRun`/`cancelRun` (only ever settle an ACTIVE row), `requestCancel` (queued → cancelled; running → `cancelRequestedAt`), `reconcileRun` (`instance.status()` on read; `not_found` → failed; no binding → no-op), `appendEvent` + `nudgeRun` |
| `runtime.ts` | The three step bodies as plain functions: `claimStep`, `executeRun`, `finishStep`; `EXECUTE_RETRIES = 2`; error classification (`isRetryableRunError`: only `AiError` unavailable/rate_limit and DB-unavailable rethrow — and only while `attempt <= EXECUTE_RETRIES`) |

Rules:

- **Claim is the row, not the queue.** Every terminal write is `WHERE status IN ('queued','running')`; a retried step re-claims and a settled row is never rewritten.
- **Exclusive = the partial unique index** `agent_runs_active_exclusive_idx`. A non-exclusive agent needs that index relaxed (documented gap; every v1 agent is exclusive).
- **Cancellation is cooperative**: `requestCancel` sets the flag, the run's `checkCancelled()` polls between turns; `AgentCancelledError` is a TYPE the runtime maps to `cancelled`. A step in flight finishes.
- **DB is the truth, WS is a nudge**: events go to `agent_run_events` first, then `entity.changed { entity: 'agent-run', id }`; viewers re-query `GET /api/agents/runs/:id`.
- **Per-agent model**: `resolveChat(..., { promptKey: meta.promptKey })` consults `agent_models`.
- The tool loop runs INSIDE one `execute` step (v1). Scaling path: one `step.do` per model turn with the transcript persisted between turns (`runToolLoop` already returns `messages`).
- Adding an agent: key in `@gmgo/shared/ai/agents` (`AGENT_KEYS` + schemas) → prompt in `services/prompts.ts` → `examples/<key>.ts` → entry in `AGENTS`. No migration.

# Workflows (D5, D7)

`agent-run.ts` — `AgentRunWorkflow extends WorkflowEntrypoint<AppBindings, { runId, tenantId }>`,
bound as `AGENT_RUN_WORKFLOW` in BOTH tomls (`name` is account-scoped: `rocketflare-agent-run` /
`-staging`; `binding` + `class_name` identical — the parity test enforces). Exported from
`src/worker.ts` only.

Shape: `step.do('claim')` → `step.do('execute', { retries: { limit: 2, delay: '10 seconds',
backoff: 'exponential' }, timeout: '10 minutes' })` → `step.do('finish')`. The bodies are plain
functions in `../services/agents/runtime.ts` (tests call them with `{ db, env }`); the class only
wires steps and opens/closes ONE DB client per step (`withStepDatabase`, awaited `close()` in
`finally`). Step return values are small serialisable objects (ids + status), never rows.

**The whole tool loop lives in the ONE `execute` step by decision, not by omission** — one `step.do`
per model turn was investigated and rejected (`docs/CONCEPTS.md` §9 Known gaps). Steps do not nest,
so it needs `run()` outside a step, and Workflows replays everything outside a step. Wall clock per
step is unlimited, so a long run is a bigger `timeout`, not more steps.

Rules: idempotent steps (the `agent_runs` row is the claim); cooperative cancel (poll the row between
turns); CPU is bounded PER STEP by `[limits] cpu_ms`; no `waitUntil` — await everything, including
nudges (`createStepRealtime().settle()`). `wrangler dev` runs instances locally; inspect deployed ones
with `wrangler workflows instances describe rocketflare-agent-run <runId>`.

Testing: `tests/api/agent-run-workflow.test.ts` instantiates the class with `createTestEnv()` and
`createFakeWorkflowStep()` (`tests/mocks/cloudflare-workers.ts`) and asserts on the rows.

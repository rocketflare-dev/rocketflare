# Durable agent runtimes: how AgentRun compares (November 2026)

> Kit-only research note (`kitOnly`; the rename removes it from copies). Written 2026-11-17 against
> kit 0.36.1. Claims about our code cite `file:line`; external claims cite a URL and were checked on
> 2026-11-17 unless marked **[unverified]**. The roadmap in §10 was agreed with the maintainer in a
> design review the same day and starts after D43 (knowledge facts, 0.37.0) ships.

## 1. Summary

We built AgentRun ourselves on Cloudflare Workflows and Postgres: one Workflow instance per run, the
whole agent body inside one `step.do` per attempt, and every durable fact (checkpoint, effects,
decisions, interrupts, events) in tenant-scoped Postgres tables. This review compares it with
Mastra, Cloudflare's own Agents SDK and Think harness, Anthropic's Agent SDK and Managed Agents,
Vercel's Workflow SDK, Flue, Temporal, Inngest, LangGraph, Restate, DBOS, the OpenAI Agents SDK and
about twenty others.

**Verdict: keep the architecture, change how the loop inside it records its work.**

Nothing off the shelf runs durable agent loops on Cloudflare Workflows. Mastra has no Workflows
runner. Vercel's Workflow SDK cannot orchestrate on Workers (`node:vm` is a stub there,
[vercel/workflow#2028](https://github.com/vercel/workflow/issues/2028)) and its Cloudflare "Worlds"
are community packages. Temporal workers need Node. Inngest and Restate run their orchestrator off
Cloudflare. Cloudflare's own agent stack keeps state in per-object SQLite that our RLS, tenant
foreign-key cascade and cross-tenant indexes cannot reach, which is why we rejected the Agents SDK
in the first place (`docs/CONCEPTS.md:851`).

**Where we lead.** Tenant isolation of every piece of agent state; typed decisions with recorded
distributions (`ctx.decide`, D37); replay of past runs against today's code (D38); per-run, per-agent
and per-tenant budgets plus a loop policy (D39); AG-UI as a pure projection of an append-only log,
with a resumable cursor; evals that run real code in-process and a feedback → dataset path (D33).
No framework reviewed has all of these, and none has replay.

**Where we trail.**

1. The tool loop is checkpointed per turn, after all tools ran. A crash mid-turn re-bills that
   model call and re-runs every tool that had already finished. Settled runs keep no transcript, so
   tool-loop agents replay only with `--live`.
2. Durability depends on authors choosing stable string keys, and a reused `once` key silently
   returns the first result.
3. No version pinning: a run parked across a deploy resumes on new code with no signal.
4. No MCP, client or server.
5. No sub-agents as separate runs; inline composition shares one 10-minute step.
6. Operability: no sweeper for lost runs, no cancel signal into model calls, the root span only at
   finish, runs and events kept forever.
7. No inspector: a run is debugged through three separate tools.

**What the field converged on**, and what we take from it:

| Industry pattern | Our answer |
|---|---|
| Each model call and tool call is durable | Record turns and tool results by `toolCallId`, inside our existing step (§10, item 2) |
| In-flight runs pinned to code | Not available on Workflows; explicit `meta.version` + resume policy (item 6) |
| Typed, persisted human interrupts | Have it; add reminders, timeout action, assignees (item 9) |
| AG-UI for UIs, MCP for tools, OTel GenAI for traces | AG-UI and OTel already; MCP client as a plugin (item 11) |
| Durability as a pluggable engine | Upstream Rocketpod's `Step` seam (item 1) |

## 2. How AgentRun works today

### Lifecycle

```
POST /api/agents/runs ─► enqueueRun ─► agent_runs row (queued) ─► AGENT_RUN_WORKFLOW.create({ id: runId })
                                                                        │
  claim ─► execute#1 ─┬─► done ───────────────────────────────────────► finish
                      └─► parked (awaiting_input) ─► waitForEvent resume#1 ─► execute#2 ─► …
                                                     └─ timeout ─► expire#1 ─► finish
```

- Route and checks: validate input → tenant active → idempotency key → exclusive slot →
  per-tenant active cap (429) → tenant daily spend (429) → insert → create instance
  (`apps/web/src/api/services/agents/runs.ts`, `routes/agents.ts:216-256`).
- Steps: `apps/web/src/api/workflows/agent-run.ts:80-150`. Every step name carries its round,
  because Workflows replays a repeated name's recorded result.
- `execute#N`: `retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '10
  minutes'` (`agent-run.ts:95-96`). Only provider-unavailable, rate-limit and database-unavailable
  errors retry (`services/agents/runtime.ts:163`).

### The one-step decision

The whole agent `run()`, every model turn and tool call included, runs inside one `step.do` per
attempt (`agent-run.ts:19-26`, `apps/web/src/api/workflows/CLAUDE.md`). Steps cannot nest, so
per-turn steps would force `run()` outside a step, and Workflows replays everything outside a step.
This was investigated and settled (`docs/CONCEPTS.md` §9). It now has a second argument in its
favour: Workflows has billed steps since 2026-08-10, 500k a month included and then $0.80 per
100k ([pricing](https://developers.cloudflare.com/workflows/reference/pricing/)). One step per
attempt is cheap; a step per tool call across a 30-turn loop is not.

### Where the state lives

| Table | Holds |
|---|---|
| `agent_runs` | status, input, output, error, attempt, `instance_id`, `checkpoint` (jsonb), `trace_id`, `concurrency_key`, `batch_id` (`db/schema/agent-runs.ts:54-101`) |
| `agent_run_events` | the append-only log the UI and AG-UI read; `seq` unique per run |
| `agent_run_effects` | `ctx.once` results, unique `(run_id, key)` |
| `agent_run_decisions` | `ctx.decide` records with `questions_hash` |
| `agent_run_interrupts` | human asks: approval, choice, input, form |
| `agent_run_artifacts` | outputs a person opens |
| `ai_usage`, `ai_spans` | spend ledger; local trace store (14-day prune) |

Every table carries `tenant_id` and calls `tenantIsolation()`. Workflow step results are kept tiny
(`{ runId, status }`), well under the 1 MiB step limit.

### The authoring surface

An agent is `{ meta, run(ctx), triggers?, bindable? }` (`services/agents/registry.ts:236-254`).
`meta` carries zod input and output schemas, a prompt key, `exclusive`, `approvers`, `budget` and
`policy` (`packages/shared/src/ai/agents.ts:54-121`). `ctx` (`registry.ts:96-234`) gives the agent:

| Primitive | Durability |
|---|---|
| `ctx.once(key, fn)` | result recorded per `(run, key)`; at-least-once with a recorded result |
| `ctx.decide(key, questions)` | typed judgement recorded per `(run, key)`; key reuse with different questions throws |
| `ctx.interrupt({ key, spec })` | parks the run; answer read back from the row on resume |
| `ctx.checkpoint` | free-form state across attempts |
| `ctx.map(key, items, fn)` | fan-out, each item a `once` in its own scope, 6 in flight at most |
| `runToolLoop(...)` | resumable from a per-turn checkpoint |

A condensed real agent (`services/agents/examples/triage-research.ts:74-144`):

```ts
export const triageResearchAgent: AgentDefinition<TriageResearchInput, TriageResearchOutput> = {
  meta: { key: 'triage-research', inputSchema, outputSchema, promptKey: 'triage-research', exclusive: false },
  async run(ctx) {
    const passages = await ctx.once('triage:search', () => search(ctx, question))
    const screen = await ctx.decide.sift('relevant', { items: passages, threshold: 0.5 })
    const triage = await ctx.decide('answerable', { state, questions: { answerable: { type: 'noul' } } })
    if (confidence < 0.4) return escalate(ctx)   // runs research-topic's body inline, same ctx
    return answer(ctx)                          // ctx.once('triage:answer', callStructuredTool(...))
  },
}
```

### Size and dependencies

About 16k lines across `services/agents`, `services/ai` (which includes chat, ingest and
retrieval) and `observability`, plus 3.6k of shared contracts. The provider client is hand-rolled
(`services/ai/client.ts`, 1,718 lines): `@anthropic-ai/sdk` for Anthropic, raw `fetch` for the
OpenAI Responses API and compatible vendors, `env.AI.run` for Workers AI, with per-model request
rules in `packages/shared/src/ai/models.ts`. OTLP export is hand-encoded (no OpenTelemetry SDK runs
on Workers). The only agent-adjacent dependencies are `@ag-ui/*` 1.0.4, pinned exactly.

## 3. The field

### Profiles of the six that matter most

**Mastra** (1.x; 1.0 stable 2026-01-20,
[announcement](https://mastra.ai/blog/announcing-mastra-1)). The most complete TypeScript agent
framework. `Agent`, `createTool`, and `createWorkflow`/`createStep` with `.then`, `.parallel`,
`.branch`, `.foreach`, `.dowhile`, nested workflows and sleeps
([control flow](https://mastra.ai/docs/workflows/control-flow.md)). Durability is snapshot
checkpointing to a database after each step and each turn; a resumed step re-runs from its top
([snapshots](https://mastra.ai/docs/workflows/snapshots)). `DurableAgent` (beta since 1.45, crash
recovery in 1.51) adds lease-based recovery of orphaned runs
([durable agents](https://mastra.ai/docs/long-running-agents/durable-agents)); each checkpoint
rewrites the whole snapshot, and Mastra advises tuning autovacuum. Suspend/resume and tool approval,
supervisor agents (`.network()` deprecated), memory including Observational Memory, RAG, MCP client
and server, scorers and datasets, tracing exporters, Studio playground (`mastra dev`). AG-UI is
first-party. Runs on Workers through `@mastra/deployer-cloudflare` with D1 or Durable Object
storage, but there is no Workflows or Durable Objects execution engine — runners are built-in,
Inngest, or an experimental Temporal one ([runners](https://mastra.ai/docs/deployment/workflow-runners.md)).
No pinning of in-flight runs. Apache-2.0 except `ee/`; platform from $0 to $250/month.

**Cloudflare Agents SDK and Think** (`agents` 0.33.0, 2026-11-03; `@cloudflare/think` 0.23.0).
An `Agent` is a Durable Object with SQLite, synced state, schedules, `@callable` RPC, WebSockets,
sub-agents and sessions ([agent class](https://developers.cloudflare.com/agents/agent-class/)).
Durable execution is "fibers": a registered SQLite row, `stash()` checkpoints, `onFiberRecovered`
after eviction — the closure is not replayed
([durable execution](https://developers.cloudflare.com/agents/agent-class/durable-execution/)).
Chat runs on AI SDK v6/v7's UI message protocol, not AG-UI; tool approval is AI SDK
`needsApproval`. Agents and Workflows integrate through `runWorkflow()` and `AgentWorkflow`
(2026-02-03, [run workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/)).
Cloudflare's guidance: use fibers and schedules when the agent manages its own lifecycle, and a
Workflow for "a discrete pipeline that could fail and retry independently"
([long-running agents](https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/)).
Think (experimental) adds tree-structured sessions with forking and compaction, codemode in Dynamic
Workers, and turn recovery inside a fiber ([Project Think](https://blog.cloudflare.com/project-think/)).
Tracing emits OTel GenAI-named spans (`invoke_agent`, `execute_tool`, `tool_approval`), kept 7 days
and billed from 2026-12-01 ([tracing](https://developers.cloudflare.com/agents/runtime/observability/tracing/)).

**Vercel Workflow SDK** (`workflow` 5.5.0, 2026-11-10, Apache-2.0; formerly Workflow DevKit) and
**`WorkflowAgent`** (`@ai-sdk/workflow`, replaces `DurableAgent`). `'use workflow'` and `'use step'`
directives; a compiler splits one file into step and workflow bundles, and step ids come from file
path plus function name ([code transform](https://workflow-sdk.dev/docs/how-it-works/code-transform)).
Durability is event sourcing with deterministic replay in a sandbox with seeded `Math.random` and
`Date.now`. `sleep`, typed hooks (`defineHook({ schema })` with `.create()` and `.resume()`),
webhooks, resumable streams (`getWritable`) ([hooks](https://workflow-sdk.dev/docs/foundations/hooks)).
Each run is **pinned to the deployment that started it**
([versioning](https://workflow-sdk.dev/docs/foundations/versioning)). `workflow inspect` CLI and a
local web UI; `@workflow/vitest` with `waitForHook` and `wakeUp`. Off Vercel: Local and Postgres
Worlds (Postgres needs a long-lived worker); Cloudflare only through unmerged
([#1372](https://github.com/vercel/workflow/pull/1372)) or community packages. Vercel's own
comparison doc points out that Cloudflare Workflows has no version pinning and no patching API
([comparison](https://workflow-sdk.dev/docs/comparisons/workflow-sdk-vs-cloudflare-workflows)).

**Flue** (`@flue/runtime` 2.3.0, 2026-10-12, Apache-2.0, [withastro/flue](https://github.com/withastro/flue)).
Built by the Astro team, now maintained at Cloudflare; Cloudflare presents it as the framework layer
over its Pi and Think harnesses ([blog](https://blog.cloudflare.com/agents-platform-flue-sdk/)). An
agent is a React-style function: `'use agent'`, then hooks (`useModel`, `useTool`,
`usePersistentState`, `useSubagent`) whose return value is the system prompt; it re-renders before
each model call, so a tool can be mounted only once state allows it. **Its durability model is the
most useful idea in this review**
([durability](https://flueframework.com/docs/guide/durability/)): an append-only log is the source of
truth; recovery reads the log and continues rather than replaying the loop; a recorded tool result is
never re-run; an unresolved ordinary tool call settles as an unknown-outcome error the model sees;
only tools marked `durable: true` re-run, with `step.do` keyed by `toolCallId`. No native
human-approval primitive — the documented pattern is a persisted flag set by a tool. No workflow
primitive; the docs show wrapping `dispatch()` in a Cloudflare Workflows `step.do`.

**Claude Managed Agents** (beta, header `managed-agents-2026-04-01`,
[overview](https://platform.claude.com/docs/en/managed-agents/overview)). Anthropic runs the loop:
Agents, Environments (Anthropic sandbox, self-hosted sandbox, or fully self-hosted), Sessions and
Events over SSE, with compaction, caching, vaults, memory stores, multi-agent, outcome graders and
session budgets built in. Not ZDR or HIPAA eligible unless fully self-hosted. Anthropic's
[Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) post (2026-04-08) is
the clearest statement of the architecture everyone is converging on: a **session** (durable event
log), a disposable **harness** (the loop) and a **sandbox** ("hands") that never sees credentials.
The **Claude Agent SDK** spawns the `claude` CLI as a subprocess with disk transcripts, so it cannot
run inside a Worker ([hosting](https://code.claude.com/docs/en/agent-sdk/hosting)).

**Temporal** (TypeScript SDK). Event history with deterministic replay; the agent loop lives in the
workflow and model and tool calls run as activities. Best-in-class versioning: Worker Versioning GA
2026-03-30 with pinned and auto-upgrade modes
([blog](https://temporal.io/blog/ga-worker-versioning-public-preview-upgrade-on-continue-as-new)).
OpenAI Agents SDK and AI SDK integrations
([docs](https://docs.temporal.io/develop/typescript/integrations/openai-agents)). Workers cannot run
Temporal workers.

### The rest, briefly

| Solution | Durability | Workers fit | Idea worth borrowing |
|---|---|---|---|
| Inngest + AgentKit | memoised steps, function re-invoked; `step.ai` | functions yes, orchestrator no | `step.ai.infer` as a durable model call |
| LangGraph.js | checkpointer per super-step; `interrupt()` | embeddable, checkpointer issues reported | `durability` mode: exit / async / sync |
| Restate | server journal + replay | handlers yes, server no | `durableCalls` middleware journalling every model response |
| DBOS | Postgres checkpoints, library only | not found | closest to us: loop is the workflow, each call a step |
| OpenAI Agents JS | none (serialised `RunState`) | experimental | `needsApproval` + serialisable run state |
| Trigger.dev v4.5+ | resumable long tasks | trigger only | Sessions as bidirectional streams outliving one run |
| Hatchet | cached-step replay on Postgres | client only | its stuck-DAG and cascading-cancel fixes as a checklist |
| Convex Agent + Workflow | journal replay | no | stream deltas persisted as the source of truth |
| Upstash Workflow Agents | HTTP step memoisation | yes | every tool `execute` wrapped in a step by default |
| Rivet | actor state + replayed workflows | yes (DO driver) | an inspector exposed over MCP for coding agents |
| VoltAgent | suspend/resume | likely | optional observability console as a companion |
| Letta | server state | client only | self-edited, versioned memory with background consolidation |
| Effect workflow | event-sourced replay | core portable | compensation and durable clock as typed primitives |
| Pydantic AI | nine pluggable engines | no | durability as an adapter interface |
| MS Agent Framework 1.0 | superstep checkpoints | no | commit state only at barrier boundaries |
| Google ADK 2.0 | opt-in resumability | no | HITL as a typed interrupt raised from a node |
| AWS Strands TS 1.0 | session restore only | plausible | swarm-style handoff |
| CrewAI Flows | SQLite persistence | no | asks with an assignee, a notification, an SLA and a timeout |
| Dapr Agents 1.0 | Dapr workflow replay | no | workload identity per agent |
| Absurd | Postgres stored procedures | via Postgres | a whole durable engine in one SQL file |
| Bedrock AgentCore | managed sessions | n/a | policy enforced at the tool gateway |
| Foundry Agent Service | sandbox with persistent FS | n/a | an identity per session and per agent |
| Google Agent Runtime | managed | n/a | Memory Bank's split of events and extracted memories |

Sources: the per-product links in §11.

### What has died or changed shape in 2026

LlamaIndex.TS archived (2026-04-30). Motia's engine relicensed to Elastic 2.0. Letta retired its V1
server. BeeAI lost IBM maintenance. OpenAI's Assistants API shut down 2026-08-26, and Agent Builder
and Evals leave the platform 2026-11-30. Mastra deprecated `.network()`; Vercel deprecated
`DurableAgent`; Cloudflare deprecated `McpAgent`. This churn is the strongest argument for a thin
core of our own over a framework dependency.

## 4. Capability matrix

Legend: ✅ built in · ◐ partial or beta · ❌ absent · — not applicable.

| Capability | **Rocketflare** | Mastra | CF Agents / Think | Vercel WF SDK | Flue | Temporal | Inngest | LangGraph | Claude Managed | OpenAI Agents |
|---|---|---|---|---|---|---|---|---|---|---|
| Durability unit | attempt + per-turn checkpoint | step snapshot | fiber stash | step (replay) | log entry | activity (replay) | step (memo) | super-step | session log | ❌ |
| Recorded tool results survive a crash | ◐ per turn | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| "Unknown outcome" for interrupted side effects | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ? | ❌ |
| Human approval, durable | ✅ 4 typed kinds | ✅ | ◐ AI SDK | ✅ hooks | ◐ pattern | ✅ signals | ✅ | ✅ | ✅ | ◐ |
| Asks with assignee / reminder / SLA | ◐ approvers only | ❌ | ❌ | ❌ | ❌ | DIY | DIY | ❌ | ❌ | ❌ |
| Stream resume after disconnect | ✅ cursor | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ❌ |
| Token streaming for background runs | ❌ | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ |
| AG-UI | ✅ | ✅ | ◐ community | ❌ | ❌ | ❌ | ❌ | ✅ | ◐ community | ◐ community |
| Sub-agents as separate runs | ❌ inline | ✅ | ✅ | ✅ | ✅ | ✅ child | ✅ | ✅ | ✅ | ✅ handoffs |
| Graphs / parallel | code + `map` (6) | ✅ DSL | code | code | code | code | code | ✅ graph | — | code |
| Memory beyond the thread | ❌ (D43 facts next) | ✅ | ◐ beta | ❌ | ◐ state | ❌ | ◐ | ◐ store | ✅ | ◐ sessions |
| RAG | ✅ hybrid + RRF | ✅ | ◐ | ❌ | ❌ | ❌ | ❌ | ◐ | ◐ | ◐ |
| MCP client | ❌ | ✅ | ✅ | ✅ AI SDK | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ |
| MCP server | ❌ (Rocketpod has one) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ◐ | — | ❌ |
| Sandboxed code execution | ❌ | ◐ workspace | ✅ Sandbox / Dynamic Workers | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ | ◐ |
| Typed decisions with distributions | ✅ D37 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Budgets and loop policy | ✅ run / agent / tenant | ◐ | ◐ | ❌ | ◐ | DIY | ◐ | ◐ | ✅ session | ◐ max turns |
| Evals | ✅ D33 | ✅ scorers | ❌ | ❌ | ◐ Braintrust | ❌ | ❌ | ◐ LangSmith | ✅ outcomes | ◐ |
| Replay past runs on new code | ✅ D38 | ◐ time travel | ❌ | ❌ | ❌ | ◐ replayer test | ❌ | ◐ fork | ❌ | ❌ |
| OTel GenAI conventions | ✅ + local store | ◐ exporters | ✅ | ✅ AI SDK 7 | ✅ | ◐ | ◐ | ◐ | ✅ | ◐ own tracing |
| In-flight version pinning | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ? | — | — |
| Agent state under the tenant's RLS | ✅ | ◐ your DB | ❌ per-object SQLite | ◐ your DB | ❌ per-object SQLite | ◐ | ❌ | ◐ | ❌ vendor | ❌ |
| Runs natively on Workers | ✅ | ◐ deployer | ✅ | ❌ | ✅ | ❌ | ◐ | ◐ | — | ◐ |

`?` = not documented; see §11 for unverified items.

## 5. Gaps, ranked

### 5.1 Mid-turn crashes re-bill and re-run tools

`runToolLoop` writes its checkpoint once per turn, after the turn's tool results are on the
transcript (`services/ai/agent-loop.ts:1135-1136`); the gate path is the one exception and
checkpoints before it raises. When an attempt dies part-way through a turn — the 10-minute step
timeout, an isolate eviction, a database blip — the retry resumes from the previous turn: it pays
for the model call again and **re-runs every tool that had already finished in that turn**, unless
the author wrapped the tool in `once`. An interrupt raised by one handler discards its siblings'
results the same way (`docs/CONCEPTS.md:873` area, "Policy (D39)"). Settling a run clears the
checkpoint (`services/agents/runs.ts:635`), so no turn survives for replay, which is why
`research-topic` replays only with `--live`.

*Who does it well*: Flue (record and resume, unknown outcome), Vercel and Temporal (each tool call is
a replayed step), DBOS and Restate (journal every model response).

### 5.2 Keys are the author's problem

`once`, `decide`, `interrupt` and `map` all take a string key the author invents. `runOnce`
returns whatever is recorded under a key (`services/agents/runs.ts:1172-1190`), and nothing tells
"the retry asking again" from "a second, different call that reused the key". This loop silently
returns the first query's passages three times:

```ts
for (const q of queries) await ctx.once('search', () => search(q))
```

`decide` guards this (`questions_hash` and `DecisionKeyConflictError`); `once` does not.

*Who does it well*: Vercel derives step ids at build time and fails duplicates; Cloudflare's own
`step.count`; Flue keys by `toolCallId`.

### 5.3 No version pinning

A resumed or retried attempt re-enters the deployed `run()` from the top (`registry.ts:152-154` says
so). An input schema that changed fails the run; a checkpoint that no longer parses restarts the
loop and re-bills (`agent-loop.ts:402-411`); a key that moved misses its record. Nothing records
which code a run started on. Cloudflare Workflows offers no pinning or patching
([Vercel's comparison](https://workflow-sdk.dev/docs/comparisons/workflow-sdk-vs-cloudflare-workflows);
Cloudflare documents none). Runs park for up to `AGENT_INTERRUPT_TIMEOUT` (default 168 hours), so
most parked runs live through at least one deploy.

*Who does it well*: Temporal (Worker Versioning), Vercel (deployment pinning). Neither approach is
open to us.

### 5.4 No MCP

No MCP client for agent tools and no MCP server (`docs/CONCEPTS.md:897` lists the Langfuse/Phoenix
MCP gap). Every reviewed framework except Temporal ships a client. MCP's 2026-07-28 spec is final
and breaking — no session handshake, elicitation through `InputRequiredResult` or a Task's
`input_required`, Tasks moved to an extension
([release](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)) — so anything
built now should target it.

Native tools in code remain our default integration path (`docs/CONNECTORS.md`): they are typed,
requester-scoped and testable. MCP buys breadth, and it is also the widest injection surface we
could add.

### 5.5 Sub-agents share one step

Composition is inline: `triage-research` calls `researchTopicAgent.run(...)` on the same ctx
(`examples/triage-research.ts:244-269`), sharing one checkpoint, one budget and one 10-minute
attempt. A timeout is not retryable (`runtime.ts:163`), so a long sub-task can fail the parent.
There is no parent/child run (`services/agents/fanout.ts:22`, `docs/CONCEPTS.md:713`).

### 5.6 Operability

| Gap | Evidence |
|---|---|
| A lost instance is settled only when someone reads the run; no sweeper, no dead-letter queue | `docs/CONCEPTS.md:504-507`, §5 gaps |
| Cancel is cooperative between turns; no `AbortSignal` reaches a model call in flight | `services/agents/CLAUDE.md` |
| Budgets are checked before each call, so a run overshoots by its last call and by calls in flight under `map` | `docs/CONCEPTS.md:875` |
| The active-run cap is counted, not locked; a burst can exceed it | `docs/CONCEPTS.md:873` |
| A run's root span reaches the backend only at finish; an in-flight run has no root there | `docs/CONCEPTS.md` §9 tracing gaps |
| No metrics export | same |
| A cancelled run emits nothing on the AG-UI stream rather than `RUN_FINISHED cancelled` | `docs/CONCEPTS.md:865` area |
| Runs and events are never pruned (spans and plugin events are) | `apps/web/src/api/scheduled.ts` |
| Chat has no spend cap | `docs/CONCEPTS.md:875` |
| No vitest-pool-workers smoke project; real Workflows replay semantics are untested under Node | `docs/CONCEPTS.md:519-521` |

### 5.7 Smaller gaps

- **Token streaming for runs**: text events arrive whole, through a polling tail (500 ms to 2 s)
  (`docs/CONCEPTS.md:865`). Chat streams tokens already.
- **Memory**: no cross-run memory. Per-person memory was parked on purpose in the D43 review; the
  domain-linked knowledge facts in D43 are our answer to "memory beyond vector search".
- **Code sandbox**: tools are in-process TypeScript; plugins run unsandboxed in the same Worker
  (`docs/THREAT-MODEL.md:75-77`).
- **Prompt versioning**: none (`docs/CONCEPTS.md:873`).
- **Documentation conflict**: the D32 decisions line says trace content capture is "on by default"
  (`docs/CONCEPTS.md:802`); the config default is off (`apps/web/src/config.ts:139`) and
  `docs/CONCEPTS.md:792` says off. The code is right.

## 6. Developer experience

### The same agent in five runtimes

A support agent with a lookup tool and a refund tool that needs a person's approval.

**Rocketflare** — tools are zod schemas plus handlers; the gate is declared on the tool and the
runtime parks the run (simplified; option names from `RunToolLoopOptions`, `agent-loop.ts:434`):

```ts
const refund: Tool = {
  name: 'refund', description: 'Refund an order', schema: z.object({ orderId: z.string() }),
  requiresApproval: true, approvalMessage: 'Refund this order?',
  handler: async (i) => billing.refund(i.orderId),
}
export const supportAgent: AgentDefinition<Input, Output> = {
  meta: { key: 'support', inputSchema, outputSchema, promptKey: 'support', exclusive: false, approvers: 'admin' },
  async run(ctx) {
    const result = await runToolLoop(ctx.chat.client, {
      model: ctx.chat.model, system: await ctx.prompt({}), tools: [...ctx.tools, lookupOrder, refund, finish],
      onCheckpoint: ctx.checkpoint.save, resume: await ctx.checkpoint.load(),
      runApproved: ctx.once, /* … */
    })
    return result.terminalInput
  },
}
```

**Vercel WorkflowAgent** — the directive makes the tool a durable step; approval is a flag
([WorkflowAgent doc](https://unpkg.com/ai@7.0.40/docs/03-agents/07-workflow-agent.mdx)):

```ts
async function refundStep(input: { orderId: string }) { 'use step'; return billing.refund(input.orderId) }

export async function support(messages: UIMessage[]) {
  'use workflow'
  const agent = new WorkflowAgent({
    model: 'anthropic/claude-sonnet-4-6', instructions: 'Help with orders.',
    tools: { refund: tool({ inputSchema: z.object({ orderId: z.string() }), needsApproval: true, execute: refundStep }) },
  })
  return (await agent.stream({ messages: await convertToModelMessages(messages), writable: getWritable() })).messages
}
```

**Flue** — the tool is mounted only once state allows it; `durable: true` marks the side effect
([tools](https://flueframework.com/docs/guide/tools/)):

```ts
'use agent'
const refund = defineTool({ name: 'refund', input: v.object({ orderId: v.string() }), durable: true,
  async run({ data, step, toolCallId }) {
    await step.do('refund', () => billing.refund(data.orderId, { idempotencyKey: toolCallId }))
    return 'refunded'
  } })
export function Support() {
  useModel('anthropic/claude-sonnet-4-6')
  const [approved, setApproved] = usePersistentState('approved', false)
  useTool(recordApprovalTool(setApproved))
  if (approved) useTool(refund)
  return 'Help with orders. Refunds need an operator approval code.'
}
```

**Mastra** — a tool flagged for approval on the agent; the run suspends and resumes
([HITL](https://mastra.ai/docs/agents/human-in-the-loop.md)):

```ts
const refund = createTool({ id: 'refund', inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ context }) => billing.refund(context.orderId) })
const support = new Agent({ name: 'support', model, instructions: 'Help with orders.',
  tools: { lookupOrder, refund }, requireToolApproval: ['refund'] })
```

**Cloudflare Workflows, raw** — every step and wait named by hand:

```ts
export class Support extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const call = await step.do('llm-1', () => callModel(event.payload.prompt))
    const ev = await step.waitForEvent<{ approved: boolean }>('approve', { type: 'approval', timeout: '24 hours' })
    if (ev.payload.approved) await step.do('refund', () => refund(call.args))
  }
}
```

### Where our DX is strong

- **One contract everywhere**: zod in `packages/shared` for input, output, interrupts and events;
  the route, the UI and the CLI parse the same schema.
- **Approval belongs to the tool**, with edits, `onReject` and binding to the exact call shown
  (`services/agents/CLAUDE.md`). That is richer than any framework's `needsApproval`.
- **Typed judgements** (`ctx.decide`) replace prompt-and-parse with recorded distributions; nothing
  else reviewed has this.
- **Test doubles**: `FakeChatClient` scripts model turns; `createFakeWorkflowStep` drives waits and
  expiry (`apps/web/tests/helpers/ai.ts`, `tests/mocks/cloudflare-workers.ts`).
- **Agent-facing docs**: per-directory `CLAUDE.md` files and the `rf-*` skills (`rf-traces`,
  `rf-evals`, `rf-agent-replay`) coach a coding agent through the work.

### Where it is weak

- **String keys everywhere** (§5.2). An author has to know which work needs `once` and invent a key
  that stays stable across deploys. Vercel and Flue make most of that disappear.
- **Wiring**: our `runToolLoop` call passes checkpoint load and save, `runApproved` and policy by
  hand. Vercel and Mastra hide this.
- **Testing needs Postgres**: every testkit builder needs a real database handle
  (`apps/web/tests/kit/unit.ts:1-23`). Vercel tests steps as plain functions and runs whole
  workflows in-process with `waitForHook` and `wakeUp`.
- **No inspector**: a run is debugged through `rocketflare traces show`, the run's event view and
  the local replay script. Vercel has `workflow inspect runs|steps|events|hooks --json --web`;
  Mastra has Studio.
- **Replay is a script only**, with no route or UI.

### DX patterns worth taking

| Pattern | From | Validated? | Where it lands |
|---|---|---|---|
| Record and resume; unknown outcome for interrupted side effects | Flue | shipped, documented | item 2 |
| Keys from recorded data (`toolCallId`) | Flue | shipped | items 2–3 |
| Duplicate keys fail loudly | Vercel (build), Cloudflare (`step.count`) | shipped | item 3 |
| Typed hooks resumable from any route | Vercel `defineHook` | shipped | Later |
| State-gated tools | Flue | shipped | note for agent authors; no runtime change |
| Inspector CLI and local UI | Vercel, Mastra | shipped | item 10 |
| In-process workflow tests with hook and sleep helpers | `@workflow/vitest` | shipped | Later, with a database-free testkit |

"Validated" means the pattern ships in a released, documented version. Flue's `'use agent'`
compiler output, its testing story and its workflow primitive (discussion #390) are not yet, and are
not proposed.

## 7. Future maintainability

### What we own

| Surface | Lines | Churn driver |
|---|---|---|
| Provider client (`services/ai/client.ts`) | 1,718 | new models, API versions, vendor quirks |
| Model traits (`packages/shared/src/ai/models.ts`) | hand-kept table | each model release (e.g. kit 0.20.0) |
| OTLP encoder (`observability/otlp-*.ts`) | ~1.3k with recorder | OTel GenAI conventions, still "Development" |
| AG-UI pin (`@ag-ui/*` 1.0.4) | dependency | protocol releases |
| Agent runtime, loop, records, replay | ~6.8k + 152 workflow | our own roadmap |

### Framework risk against ownership cost

Adopting a framework would trade these costs for churn we do not control. In 2026 alone, the
frameworks reviewed renamed their core abstractions (`DurableAgent` → `WorkflowAgent`, `.network()`
→ supervisors, `McpAgent` → `createMcpHandler`), relicensed (Motia), archived (LlamaIndex.TS) or
pivoted (Letta, OpenAI Agent Builder). Mastra ships minor releases weekly. The Workflow SDK's npm
line was in `5.0.0-beta` as recently as July 2026.

The standards are moving too, but they move in public with deprecation policies: MCP now has a
12-month deprecation policy, OTel GenAI conventions moved to their own repository in June 2026
([semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai)), AG-UI
is backed by most hyperscalers. **Adopt standards, not frameworks**, and keep each behind a seam we
already have:

| Seam | Isolates |
|---|---|
| `ChatClient` (`services/ai/types.ts`) | providers; an AI SDK 7 provider layer could sit behind it if keeping up with models gets expensive |
| `genai-attributes.ts` | trace attribute names |
| `agui-projection.ts` | the UI wire format |
| `DecisionClient` (`services/ai/decisions/types.ts`) | decision engines |
| run engine (missing in Rocketflare; exists in Rocketpod) | the durable executor |

### The run-engine seam

Rocketpod, our Cloudflare-free fork, already runs AgentRun on OpenWorkflow. Its run body
(`rocketpod/apps/web/src/api/workflows/agent-run-body.ts`, 160 lines) is written against a neutral
`Step` type in `src/platform/types.ts`, and `src/node/runs.ts` adapts OpenWorkflow to it. The
`services/agents` directories hold the same files in both kits. Upstreaming that seam keeps the two
kits aligned: everything above it (runtime, loop, records, replay) ports between them unchanged,
and every item in §10 that sits above the engine reaches Rocketpod without a hand port.

## 8. Operability

### Platform envelope (Cloudflare Workflows, Workers Paid, 2026)

| Limit | Value | Our exposure |
|---|---|---|
| Steps per instance | 10,000 default, up to 25,000 | ~3 per round, 32 rounds max — no risk |
| Step result | 1 MiB (streams for more) | we return `{ runId, status }` |
| CPU per step | 30 s default, up to 5 min | model calls are I/O, not CPU |
| `waitForEvent` timeout | 1 s to 365 days, default 24 h | we pass `AGENT_INTERRUPT_TIMEOUT` (168 h) |
| Retention | 7 days default for new Workflows since 2026-09-10, max 30 | **bounds a park**; restart-on-`not_found` covers it |
| Concurrent instances | 50,000 per account (waiting ones don't count) | tenant cap 50 |
| Steps billed | $0.80 per 100k after 500k/month | argues for one step per attempt |

Source: [limits](https://developers.cloudflare.com/workflows/reference/limits/),
[pricing](https://developers.cloudflare.com/workflows/reference/pricing/).

### New platform features we do not use yet

From the [2026 changelog](https://developers.cloudflare.com/changelog/product/workflows/):
`instance.subscribe()` event streaming (Sep), steps returning a `ReadableStream` (Apr), per-step
context `ctx.attempt` / `step.name` / `step.count`, saga rollbacks (Jun), per-Workflow
`concurrency.limit` (Nov 10), EU / US / FedRAMP jurisdictions (Oct), full `--local` dev (Mar–Apr).
`concurrency.limit` is a candidate backstop for our counted active-run cap; jurisdictions matter
for EU tenants; `subscribe()` is the cheapest route to live run output later.

### Liveness and recovery

Lost runs are settled on read (`reconcileRun`, 30 s liveness window), parks are bounded by instance
retention and recovered through a restarted instance on `not_found`. That is sound for a run someone
looks at and wrong for one nobody opens: it stays "running" in counts and caps. A sweeper cron
closes that, and it is also what HITL reminders need.

### Observability

Our tracing exports OTel GenAI attributes with Langfuse and OpenInference aliases and always keeps a
14-day local copy in `ai_spans`, readable through `rocketflare traces`. That is ahead of
Cloudflare's own agent tracing (7 days, billed from 2026-12-01). What is missing: the agent span
names the conventions now define (`invoke_agent`, `execute_tool`, `invoke_workflow`, with
`gen_ai.conversation.id` and `_ref` content attributes —
[agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)),
a root span from the start of a run, and metrics.

## 9. Where we are ahead

1. **Agent state is tenant data.** Every run table is in Postgres under `tenant_id`,
   `tenantIsolation()` and the tenant foreign-key cascade; tools act within the requester's
   `AccessScope`. Per-object SQLite (Cloudflare, Flue) and vendor-hosted sessions (Managed Agents,
   OpenAI) cannot give a multi-tenant SaaS that.
2. **Typed decisions** (D37): yes/no, choice and score questions with distributions and confidence,
   recorded once per key, calibrated engine first and the chat model as a labelled fallback.
3. **Replay** (D38): today's code over settled runs, strict by default, read-only transaction, a
   verdict and a JSON diff per run, `--candidate` for a variant. No reviewed framework has it.
4. **Budgets and policy** (D39): per run, per agent and per tenant per day, plus turns, tool calls,
   concurrency, active duration, repeated failures and a salvage-or-fail rule.
5. **The log is the truth; AG-UI is a view.** Event rows project to AG-UI on read, with a resumable
   cursor and no lost frames.
6. **Approval is rich**: four closed interrupt kinds, edits re-validated against the tool's schema,
   approver checks, one go-ahead bound to the exact call shown.
7. **Evals from production** (D33): real code in-process, deterministic and model judges, committed
   baselines, thumbs → `rocketflare evals promote`.

## 10. Recommendations and roadmap

Agreed in the 2026-11-17 review. The programme starts after D43 (knowledge facts, 0.37.0) ships and
runs in this order. Effort: S ≤ 3 days, M ≈ 1–2 weeks, L > 2 weeks.

### Keep

- **Cloudflare Workflows + Postgres**, one step per attempt. Mine Flue for validated patterns; do
  not take a dependency on it, Mastra or the Workflow SDK.
- **Our provider client** for now. If the cost of keeping up with models grows, spike AI SDK 7
  behind `ChatClient` on one provider and compare code size, the traits test and trace output.

### Phase 1 — durable loop (one release, one porting note)

1. **Upstream the run-engine seam** from Rocketpod (`Step` / `Platform` types, a run body written
   against them, Cloudflare Workflows as the adapter). First, so items 2–3 are written against it.
   *S*
2. **Record and resume the tool loop** (from Flue).
   - Checkpoint the assistant turn **before** its tools run; record each tool result as it settles,
     keyed by `toolCallId`.
   - On a retry, a recorded result is never re-run. A tool not yet recorded re-runs if it is
     read-only; a tool marked `Tool.sideEffects: true` settles as an "unknown outcome" error the
     model sees, unless it is also `durable`, in which case it re-runs with `toolCallId` as its
     idempotency key.
   - Keep the transcript after settle in a new `agent_run_turns` table (run, seq, role, content
     jsonb, `toolCallId`; `tenantIsolation()`), pruned after `AGENT_TRANSCRIPT_RETENTION_DAYS`
     (default 30). Runs, events and decisions are kept as today.
   - Recorded model turns become replay records, so **strict replay works for tool-loop agents**
     without `--live`, for runs inside the retention window. Older runs fall back to a miss.
   *M*
3. **Key safety**, a hybrid that stays correct across deploys:
   - tool-loop keys come from the recorded `toolCallId` — no author key;
   - `ctx.once(label, fn, { inputs })` keys on the label plus a hash of `inputs`, which fixes the
     loop bug in §5.2;
   - a label-and-inputs collision within one attempt throws `EffectKeyConflictError`;
   - replay reports `order_drift` when today's code asks for keys in a different order;
   - pure order-derived keys only for agents marked `pinned: true` (item 6).
   Pure order-derived keys for every agent were considered and rejected: without platform pinning a
   run parked across a deploy would replay new code against old positions. *S–M*

### Phase 2 — operability

4. **Operations**: a sweeper cron that settles lost runs; an `AbortSignal` from cancel into the
   model call; the run's root span emitted at start; `RUN_FINISHED` with a cancelled outcome; a
   look at `concurrency.limit` as a backstop for the counted cap. *S–M*
5. **OTel GenAI agent spans**: `invoke_agent`, `execute_tool`, `invoke_workflow` with
   `gen_ai.conversation.id` and `_ref` content attributes, pinned to a named conventions version.
   Fix `docs/CONCEPTS.md:802`. *S*

### Phase 3 — next quarter

6. **Version pinning, and the agent context to keep it honest.**
   - `agent_runs` gains `agent_version` (the author bumps `meta.version`) and `worker_version_id`
     (from a `[version_metadata]` binding in both tomls).
   - Resume policy per agent when the version changed while parked: `continue` (default; safe
     because keys come from data), `fail` (required for `pinned: true`), or `rerun` from the input.
   - CI replays recorded runs of every changed agent; a key-sequence change without a version bump
     fails with a message that says "bump `meta.version`".
   - Rules in `services/agents/CLAUDE.md` say when to bump (keys, step order, schemas, tools; not a
     prompt edit), and `rf-agent-replay` gains a "before you change an agent" step, so a coding
     agent changing a workflow knows to do it.
   An automatic hash of `run.toString()` was rejected: it misses imported helpers and prompts and is
   noisy under minification. *M*
7. **HITL upgrades**: `remindAfter` per agent (needs the sweeper), `onTimeout: 'expire' | 'reject'`
   — never approve-by-default — and named assignees by user or visibility group. *S–M*
8. **Child runs**: `ctx.spawn(agentKey, input)` creates a separate instance with `parent_run_id`;
   the parent parks on the child through the interrupt machinery; the child's budget is carved from
   the parent's; cancel cascades; traces link. A child is visible only through its parent, never as
   a separate run in lists or the inbox. Inline composition stays the default for short sub-tasks.
   *M*
9. **Inspector**: one `GET /api/agents/runs/:id/timeline` contract in `packages/shared` merging
   events, turns, effects, decisions, interrupts, children, spend against budget and version
   fields; `rocketflare agents inspect <runId> [--json]` plus `runs list` filters; a run-timeline
   page in the admin UI on the same contract. *M*
10. **MCP client as a plugin**, not core: on the 2026-07-28 spec, bearer tokens only at first,
    tenant-registered servers with credentials stored like `ai_configs`, approval on by default for
    every MCP tool. Native tools in code stay the default way to integrate. *M*
11. **MCP server, upstreamed from Rocketpod** — once validated. Rocketpod's `/mcp` (commits
    `b79ada8`, `4bd04f3`) may lean on assumptions that only hold for the identity provider it was
    built against; check its OAuth and tenancy model against generic OIDC, IdP-managed tenancy and
    `docs/THREAT-MODEL.md` before porting. *M*

### Later

- **Live run output**: near term, poll faster or nudge per event while someone watches a run; full
  token streaming through `instance.subscribe()` or a per-run Durable Object relay only if a product
  need appears.
- **Typed external hooks** (`defineHook`-style asks answerable from Slack or a webhook by signed
  token), with their own threat-model entry.
- **Replay as a route** with a diff view; strict mode only.
- **MCP OAuth** (outbound) and MCP Tasks / A2A `INPUT_REQUIRED` mapping of our interrupts.
- **Code sandbox** through Cloudflare Sandbox or Dynamic Workers, credentials injected by an egress
  proxy and never visible to the sandbox. *L*
- **A database-free testkit** with `waitForInterrupt` / `resume` helpers, after the seam lands.
- **Retention for runs and events** — an open operability question, because some tenants will treat
  run history as an audit log.

### Avoid

- **Adopting Mastra or the Workflow SDK as the runtime.** Neither has a Cloudflare Workflows engine;
  the Workflow SDK cannot orchestrate on Workers at all; both bring storage and tenancy models that
  sit outside our RLS.
- **Agents SDK or Flue state as the system of record.** Per-object SQLite is outside RLS, the tenant
  cascade and cross-tenant indexes. A Durable Object as a stream relay, with Postgres as the truth,
  is fine.
- **Per-person memory** in this programme — parked in the D43 review; domain-linked facts come
  first.
- **The Claude Agent SDK inside the Worker.** It needs a subprocess and a disk; if we ever want a
  coding-agent harness, Cloudflare's Container harness is the route.
- **Approve-by-default timeouts.**

## 11. Appendix

### Sources (checked 2026-11-17)

Cloudflare: [Agents docs](https://developers.cloudflare.com/agents/) ·
[agent class](https://developers.cloudflare.com/agents/agent-class/) ·
[durable execution](https://developers.cloudflare.com/agents/agent-class/durable-execution/) ·
[lifecycle](https://developers.cloudflare.com/agents/runtime/lifecycle/) ·
[run workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/) ·
[long-running agents](https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/) ·
[human in the loop](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/) ·
[tracing](https://developers.cloudflare.com/agents/runtime/observability/tracing/) ·
[Think](https://developers.cloudflare.com/agents/harnesses/think/) ·
[Project Think](https://blog.cloudflare.com/project-think/) ·
[Flue on the agents platform](https://blog.cloudflare.com/agents-platform-flue-sdk/) ·
[Claude Managed Agents on Cloudflare](https://blog.cloudflare.com/claude-managed-agents) ·
[Containers and Sandbox GA](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/) ·
[Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) ·
[Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/) ·
[rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) ·
[Workflows changelog](https://developers.cloudflare.com/changelog/product/workflows/)

Anthropic: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) ·
[context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) ·
[long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) ·
[Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) ·
[evals for agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) ·
[Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) ·
[Agent SDK hosting](https://code.claude.com/docs/en/agent-sdk/hosting) ·
[compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold) ·
[context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) ·
[MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector) ·
[prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

Frameworks: [Mastra](https://github.com/mastra-ai/mastra) and
[docs](https://mastra.ai/docs/long-running-agents/durable-agents) ·
[Workflow SDK](https://workflow-sdk.dev/) ·
[AI SDK 7](https://vercel.com/blog/ai-sdk-7) ·
[Flue](https://flueframework.com/docs/guide/durability/) ·
[Temporal OpenAI Agents](https://docs.temporal.io/develop/typescript/integrations/openai-agents) ·
[AgentKit](https://github.com/inngest/agent-kit) ·
[LangGraph durable execution](https://docs.langchain.com/oss/javascript/langgraph/durable-execution.md) ·
[Restate on Workers](https://docs.restate.dev/services/deploy/cloudflare-workers) ·
[DBOS AI](https://docs.dbos.dev/ai/ai-quickstart) ·
[OpenAI Agents JS](https://github.com/openai/openai-agents-js) ·
[Trigger.dev v4.5](https://trigger.dev/changelog/v4-5-0) ·
[Hatchet](https://hatchet.run/) ·
[Convex agents](https://docs.convex.dev/agents/workflows) ·
[Upstash agents](https://upstash.com/docs/workflow/agents/overview) ·
[Rivet](https://github.com/rivet-dev/rivet) ·
[VoltAgent](https://github.com/VoltAgent/voltagent) ·
[Letta](https://github.com/letta-ai/letta) ·
[Effect workflow](https://effect.website/docs/v4/api/effect/unstable/workflow/Workflow) ·
[Pydantic AI durable execution](https://pydantic.dev/docs/ai/capabilities/durable_execution/overview/) ·
[MS Agent Framework 1.0](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/) ·
[Google ADK 2.0](https://adk.dev/2.0/) ·
[Strands TS 1.0](https://strandsagents.com/blog/strands-agents-typescript-v1/) ·
[CrewAI human feedback](https://docs.crewai.com/en/learn/human-feedback-in-flows) ·
[Dapr Agents](https://www.cncf.io/announcements/2026/03/23/general-availability-of-dapr-agents-delivers-production-reliability-for-enterprise-ai/) ·
[Absurd](https://lucumr.pocoo.org/2026/4/4/absurd-in-production/) ·
[Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html) ·
[Foundry Agent Service](https://devblogs.microsoft.com/foundry/foundry-agent-service-ga/) ·
[Google Agent Runtime](https://docs.cloud.google.com/agent-builder/agent-engine/overview)

Protocols: [AG-UI](https://docs.ag-ui.com/introduction) ·
[MCP 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) ·
[A2A](https://a2a-protocol.org/latest/specification/) ·
[OTel GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)

### Unverified or contested

- How Cloudflare Workflows treats an in-flight instance across a deploy: no document says; treated
  here as "resumes on current code", which matches our code's own assumption (`registry.ts:152-154`).
  Worth a test on a real deploy.
- Workflow SDK GA in April 2026 (third-party source only); whether `WorkflowAgent`'s streamed model
  calls are steps; whether the QuickJS mode runs on Workers.
- What Flue's `'use agent'` compiles to; Flue's testing utilities.
- Temporal's TypeScript OpenAI Agents integration: docs say pre-release, a 2026-10-30 blog says GA.
- Whether Mastra's span attributes follow OTel GenAI conventions.
- Prices for Mastra platform tiers, Inngest, Restate, Letta, Braintrust, Langfuse, Managed Agents,
  AgentCore and Google Memory Bank.
- Status of Cloudflare's August 2026 "Cloudflare Agents" product and of Agent Memory (private beta).

### Glossary

| Term | Meaning here |
|---|---|
| Attempt | one execution of `execute#N`; retries are new attempts of the same step |
| Checkpoint | `agent_runs.checkpoint`, the tool-loop transcript saved per turn |
| Effect | a `ctx.once` record in `agent_run_effects` |
| Park | a run waiting on a person (`awaiting_input`, `waitForEvent`) |
| Record and resume | recovery that reads recorded results and continues, rather than replaying code |
| Replay (D38) | running today's code over a settled run, answering from its records |
| Unknown outcome | a tool call that started but has no recorded result, reported to the model as such |
| Pinning | running a resumed instance on the code that started it |

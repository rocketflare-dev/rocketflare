# Is this how Cloudflare does it?

Checked against current docs rather than recollection, because the whole plan rests on it.

## The suspend mechanism: yes, this is the blessed pattern

[`step.waitForEvent` + `sendEvent`](https://developers.cloudflare.com/workflows/build/events-and-parameters/)
is documented with **"wait for human approval"** as a named use case.

- Timeout **1 second to 365 days**, default 24 h.
- Explicitly re-callable: *"you can call it multiple times within a Workflow, and use control flow
  to conditionally wait for an event."* — which is exactly the `execute#N` / `resume#N` loop.
- Event type names allow **only letters, digits, `-` and `_`**; a `.` gives
  `workflow.invalid_event_type` (see T8 in [00-issue-17-corrections.md](00-issue-17-corrections.md)).

From [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/):

| Limit | Paid | Free |
|---|---|---|
| Wall clock per step | **unlimited** (the kit's existing claim is correct) | — |
| CPU per step | 30 s default, configurable to 5 min | 10 ms |
| Steps per instance | 10,000 default, up to 25,000 | 1,024 |
| Concurrent instances | 50,000 — **`waiting` instances are excluded** | 100 |
| **Instance retention** | **30 days** | **3 days** |

So parking is genuinely free ("millions can wait simultaneously"), and this plan's two steps per
interrupt round against `MAX_INTERRUPT_ROUNDS = 32` is nowhere near the step budget.

**Retention, not the timeout, is the real bound on a park.** On Free, a run parked longer than
3 days loses its instance outright, `waitForEvent` never fires, and only T6's read-path
`expireParkedRun` plus the `not_found` restart recover it. Those two are **load-bearing, not
defensive**.

## The placement of the agent loop: a real divergence, and worth naming

Cloudflare's canonical agent stack is the **Agents SDK (a Durable Object per agent)** for the
LLM/tool loop and real-time communication, **plus Workflows** for durable pipelines and HITL pauses:

| Scenario | Cloudflare says |
|---|---|
| chat/messaging, real-time, tasks under 30 s | Agents alone |
| data pipelines, report generation, guaranteed delivery, **human-in-the-loop approval flows** | Agents **+** Workflows |
| background jobs, scheduled sync, event-driven processing | **Workflows alone** |

A Rocketflare agent run is started by `POST /api/agents/runs`, executes without a connected client,
and is read back from durable rows — that is the third row, *Workflows alone*, and the HITL row puts
the approval pause in the Workflow either way. **So the kit is inside the documented envelope.**
What it does not have is the Agents-SDK half: a stateful DO owning the loop and streaming to a live
client. The kit runs the loop in the Workflow and streams from Postgres ([phase 6](06-streaming.md)).
That is a deliberate, already-documented trade (D7; `services/agents/CLAUDE.md`; the thesis that
declined Effect Agent in #9): one Worker, Postgres as the single tenant-scoped truth, ~1,900 lines
the team owns.

## Why the kit cannot take the Agents SDK: state exits the tenancy model

**Agents SDK v0.3.7 (Feb 2026) shipped `runWorkflow()`, `waitForApproval()`, `approveWorkflow()` and
`rejectWorkflow()`** — very close to the shape phases 3–5 build by hand. Two problems, and the
addressing one is the smaller.

### 1. Addressing is a client-supplied string — solvable, but convention not structure

Agents are reached at `/agents/{agent}/{instance-name}`, and
[the docs are explicit that the instance name comes from the client](https://developers.cloudflare.com/agents/api-reference/calling-agents/)
(`useAgent({ name: "user-abc123" })`). Cloudflare's guidance is to *"**optionally**, enforce that
users can only access their own agents"* before `routeAgentRequest()`, with `onBeforeConnect` /
`onBeforeRequest` hooks; the burden rests entirely on the server.

This **is** solvable — never use `routeAgentRequest`, always
`getAgentByName(env.X, \`${tenantId}:${runId}\`)` derived server-side after auth, exactly the shape
`routes/ws.ts` already uses for the notifications hub. But it converts isolation from **structure
into convention**: today a forgotten tenant predicate is caught by
`tests/config/unscoped-allowlist.test.ts`, which parses every query and fails when a tenant-scoped
table is touched without naming a tenant. **That test cannot see a DO name string.** A missing
prefix would be neither a type error nor a test failure.

### 2. The state leaves Postgres — the real cost

[Agent state is an embedded SQLite database inside each instance](https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/)
— *"every individual Agent instance has its own SQL (SQLite) database"* — and the docs mention **no
cross-instance querying, no backup, no deletion mechanism and no export**.

| Kit invariant | What happens |
|---|---|
| **RLS scaffolding (D1)** — every tenant table carries `tenantIsolation()`, `rls-coverage.test.ts` reads the live catalog | No Postgres role, no policy, nothing to attach one to. Agent state is outside everything `docs/RLS.md` describes |
| **Tenant delete cascades** — `tenantRef(tenants)` is `ON DELETE CASCADE` | A DO's SQLite is outside that FK graph. **Deleting a tenant leaves its agents' state behind** — including model transcripts, which the kit currently nulls on settle *precisely so a verbatim transcript does not sit in the table for the life of the row*. A retention problem, not untidiness |
| **The HITL inbox** ([phase 5](05-routes.md)) — `(tenant_id, status, created_at desc)` | "What is waiting on me across every agent in this organisation" is a cross-instance query DOs do not do. Fan out with no index — or shadow the rows into Postgres |
| **Analytics (D19)** — every cube reads Postgres via Hyperdrive, scoped by `tenantIdOf(ctx)` | Agent state cannot be a cube, a fact table, or join the `ai_usage` ledger |
| **Migrations** | Two systems: wrangler DO class migrations alongside drizzle |

Group visibility (D29) *would* survive — a DO can hold the Hyperdrive binding, so `ctx.tools` could
still take an `AccessScope` and scope its SQL. It is specifically the agent's own state that leaves.

### The decisive point

**The fix for the inbox is to shadow the rows into Postgres — which is this plan.** Adopting the SDK
would mean paying for a second state model **and still writing `agent_run_interrupts`**, because
every query that makes HITL usable is cross-run and tenant-scoped.

So: build this. Cite the SDK in `docs/CONCEPTS.md` §9 as the supported alternative with these
trade-offs named, so the next person finds the comparison rather than rediscovering it — and so an
adopter who is single-tenant, or who wants the SDK's streaming and scheduling, can choose
differently on purpose.

---

## Spike result (run 2026-09-16, before phase 1)

`RUN_FINISHED` carrying an interrupt outcome **round-trips over protobuf intact** on
`@ag-ui/proto@0.0.59` — `id`, `reason`, `message`, `toolCallId`, `responseSchema`, `expiresAt` and
`metadata` all survive `decode(encode(ev))` byte-identically. So `PROTO_UNSUPPORTED_EVENTS` stays a
type list, and phases 5–6 keep their planned shape. No `kit.` CUSTOM fallback is needed.

**One trap the spike exposed.** The outcome discriminator is **`'interrupt'`, not `'interrupted'`**
(`RunFinishedInterruptOutcomeSchema.type` is `z.literal('interrupt')`). Getting it wrong does not
throw: `@ag-ui/proto`'s `encode` logs `Malformed devent detected, falling back to unvalidated
event` and writes a 43-byte frame with the outcome **silently dropped**, which no test asserting
"encode did not throw" would catch. Always assert on the DECODED value.

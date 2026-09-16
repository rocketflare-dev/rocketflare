# Phase 6 — Live run progress

**Goal:** a run's timeline fills in ~500 ms instead of 3-second lumps, resumably, without holding a
connection for a seven-day park. Closes [issue #7](https://github.com/rocketflare-dev/rocketflare/issues/7).

Independent of [phase 7](07-ui.md); both need [phase 5](05-routes.md) first.

## The route

**`GET /api/agents/runs/:id/agui/stream`** — a polling SSE route (new service
`api/services/agents/run-stream.ts`) that tails `agent_run_events` inside the stream body, projects
each row through the resumable projector (decision 5), and frames it as spec AG-UI with `seq` as the
cursor.

**GET, not POST**: `csrf.ts:26` passes GET/HEAD/OPTIONS, `/api` is already in `API_PREFIXES` /
`run_worker_first` (so **no toml change**), and a third-party AG-UI client can use a bare
`EventSource` — which is why `Last-Event-ID` is honoured at all, with `?afterSeq=` winning when both
are present (the kit's own client is explicit; a stale browser value must never override it).

## Two rejected alternatives, with reasons

**Carrying events on the existing WebSocket nudge** — rejected on **tenant isolation**, not taste.
`NotificationsHub` fans out per *tenant*, but run visibility is per *run* (`visible(auth, run)`,
`routes/agents.ts:41`). A nudge carrying `{ entity, id }` is safe because the id is useless without
a row read that re-checks ownership; a nudge carrying the *payload* would broadcast one member's
assistant text, tool inputs and document excerpts to every socket in the tenant. Closing that means
teaching the hub per-run subscription and authorisation, and the hub deliberately has no database.
It also inverts "DB is the truth, WS is a nudge", which is load-bearing in four other places.

**A per-run Durable Object fan-out** — premature, and named as the future seam for *tokens*. A push
can always be missed (reconnect, redeploy, eviction), so `seq` gaps must still be closed by a tail
query: it is the polling design **plus** a relay, a second long-lived connection billed as DO
duration, and a new authorisation story — for roughly 250 ms of average latency.

## The cost argument

Measure against what it **replaces**, not against zero. Today, per active run per viewer, every 3 s:
`getRun` + `reconcileRun` (**a Workflow `instance.status()` subrequest**) + `listEvents` returning
*every row, unbounded*. The stream does one indexed
`WHERE (tenant_id, run_id) AND seq > $cursor LIMIT 200`, usually returning nothing, on a connection
already open.

**It is cheaper per unit of wall clock than the poll it replaces, at 6× the resolution.**

## Constants

In `@rocketflare/shared/ai/agents` — protocol behaviour the client must agree with, **not `[vars]`**,
which would buy nothing and add parity-test surface.

| Constant | Value | Why |
|---|---|---|
| `RUN_STREAM_POLL_MS` | 500 | a step lands as "immediate" |
| `…_SLOW_MS` | 1000 after 10 empty ticks | an agent's cadence is bursty; fast matters *just after* a row |
| `…_IDLE_MS` | 2000 after 30 empty ticks | deliberately **below today's 3 s**, so the stream's worst case beats the poll's best. Reset to 500 on any row |
| `…_TAIL_LIMIT` | 200 rows | bounds one tick's CPU and frame burst; a full page re-loops immediately |
| `…_HEARTBEAT_MS` | 15 000 | under the usual idle-proxy timeout |
| `…_IDLE_MS` (cap) | 300 000 | 5 min of silence: wedged or in one very long step; better recycled |
| `…_MAX_MS` | 600 000 | 10 min — keeps ticks (~320) provably under the 1 000-subrequest ceiling, bounds mid-stream session expiry, matches the `execute` timeout, and **makes a redeploy indistinguishable from the normal path** so the reconnect is exercised on every stream rather than only during an incident |

## Before the first frame

Everything that can fail is JSON, **outside** `stream(c, …)`: auth, `read AgentRun`, `uuidParam`,
the 404 for an invisible run, `reconcileRun` (**exactly once, at open — never in the loop**, it is a
Workflow subrequest per call), and a 400 on a garbage cursor. `streamDatabase(c)` + `close()` in
`finally` even though this route writes nothing; **one** Hyperdrive connection for the life of the
stream, not one per tick.

## Terminal conditions

| State | Out | Connection |
|---|---|---|
| `succeeded` / `failed` / `cancelled` | the terminal AG-UI event | close |
| **`awaiting_input`** | `RUN_FINISHED { outcome: { type: 'interrupt', … } }` | **close** |
| active, idle cap / duration cap / body error / client abort | **nothing** | close |

**The parked run needs no code in the route** — the projector already returns a terminal for
`awaiting_input` ([phase 5](05-routes.md)), so the generic branch fires. A run parked for seven days
holds no connection, no query and no invocation, and re-opens on the existing nudge when the answer
lands. That degrades exactly to today's architecture, which is the right answer.

A stream failure emits **no `RUN_ERROR`** — decision 6.

## The cursor is the sharpest trap here

One row is not one AG-UI event: a `text` row is `START → CONTENT → END`.

> **Write `id: <seq>` on the last frame of a row's group and no other frame in that group.**

Otherwise a drop between `TEXT_MESSAGE_START` and `END` leaves the browser's last-event-id already at
`seq`, the resume starts at `seq+1`, and the client holds a text message that **never closes,
forever, with no error**. Replaying a whole group is safe because every id is keyed off the row id,
so a replayed group is byte-identical.

Corollaries:

- `RUN_STARTED` carries `id: 0` and is emitted **only when `afterSeq === 0`**
- **protobuf has no cursor** (no SSE framing) — it resumes by `?afterSeq=` only. Document it beside
  `PROTO_UNSUPPORTED_EVENTS`
- **never write a `: ping` comment frame in binary mode** — it is not a valid protobuf frame and no
  client can decode the stream afterwards

## Fix the tool-call pairing bug here

`agui-projection.ts:98,117` keys `openToolCalls` by tool **name**. Harmless today (the loop is
sequential), catastrophic the day two `search_knowledge` calls run in one turn. Fix:

- the runtime writes the model's `call.toolUseId` into the `data` of **both** `tool.start` and
  `tool.end` (it already has it — `chat-turn.ts` uses it for exactly this)
- the projector keys on `data.toolCallId ?? name`
- **the emitted AG-UI `toolCallId` stays `event.id`** — "the event row ids ARE the AG-UI ids" is a
  documented invariant of the module
- old rows fall back to the name path, so historic runs project identically; pin that with a test

## Text stays per assistant turn — not a trade-off

`agent_run_events` is a durable, indexed, tenant-isolated log replayed in full by three endpoints. A
2 000-token answer would be 2 000 rows ≈ 800 KB *per turn*, permanently — and because a Workflow
step must `await` every write, ~4 seconds of added latency per turn, *spent making the run slower in
order to look faster*.

**The real complaint is silence, not text**: nothing happens for 20 s while a tool runs. The fix is
*more `step` and `tool.*` rows*, which are genuine durable facts, landing instantly at 500 ms.

Tokens are the one payload legitimately **not** durable — lossy, never replayed, never written —
which is exactly the shape a DO fan-out serves. Build that then, for tokens only, on top of this.

## Client

`apps/web/src/ui/lib/runAguiStream.ts` — a sibling of `aguiStream.ts` (that one POSTs and owns a
turn; this GETs and owns nothing), reusing `readSse` and `parseErrorBody`, keeping `@ag-ui/core` in
the lazy chunk. Returns `{ lastSeq, terminal, aborted }`; **reconnect lives in the hook, not the
transport.**

Three contract changes, each easy to miss:

- **`readSse`'s `onEvent` gains the frame** (`sse.ts:101,122` parses `id` and discards it, so the
  cursor is unreachable). Purely additive; `aguiStream.ts` ignores the second argument.
- **`AgentRunAguiResponse` gains `lastSeq`** — AG-UI events carry no `seq`, so without it the client
  cannot compute a resume cursor and every reconnect replays the whole run.
- **`GET /runs/:id?events=0`** returns the bare row, under `queryKeys.agentRuns.row(id) =
  ['agent-run','row',id]` — still inside `['agent-run']` so the nudge refreshes it, but now one
  indexed read instead of `reconcileRun` plus the whole log.

### The cache rule, flatly

> The stream is the **only** writer of `['agent-run-agui', id]`, appends to it with `setQueryData`,
> and never touches the run row. A terminal frame invalidates `queryKeys.agentRuns.all` **once**.
> Nothing else.

A terminal status is never synthesised client-side — that is how a UI claims success for a run the
server later marks failed.

### `['agent-run-agui']` is deliberately absent from `REALTIME_INVALIDATIONS`

The kit's convention is that an `entity.changed` entity string *is* a query-key root, and
`appendEvent` nudges on **every row**. Put the accumulated AG-UI list under `['agent-run']` and every
event the runtime writes blows away the list the stream just built, triggering a full re-fetch —
**turning the stream into a more expensive poll.** Name the root; put a UI test on it.

### Coexistence — exactly one of {stream, agui-poll} live

| Trigger | After this lands |
|---|---|
| WS `entity.changed { entity: 'agent-run' }` | unchanged; refetches `row(id)` (now cheap) and the list. Does **not** touch `['agent-run-agui']` |
| list poll | unchanged. **The list never streams** — one stream per tab, because `wrangler dev` behind the Vite proxy is HTTP/1.1 and the browser allows six connections |
| run row poll | 3 s while the run owes an answer, `false` for `awaiting_input`, `false` once settled |
| the stream | opens on run-page mount iff `queued`/`running`; closes on settle, park, idle, cap or unmount |
| fallback | after **3 consecutive connections delivering zero frames**, stop and give `['agent-run-agui', id]` a `RUN_POLL_MS` `refetchInterval` — identical to today's behaviour against a different URL. Retried on the next mount or status transition |

## Done when

- [ ] `?afterSeq=` wins over `Last-Event-ID`; resume omits `RUN_STARTED`
- [ ] **`id:` appears only on the last frame of each row's group**, and a mid-group drop resumes at
      the previous row
- [ ] a parked run emits the interrupt outcome and **closes** (the seven-day test)
- [ ] idle and duration caps close with **no** terminal event; a body error emits no `RUN_ERROR`
- [ ] under a protobuf `Accept`: no `id:` lines, **no comment frames**, `TOOL_CALL_RESULT` still dropped
- [ ] `reconcileRun` called **exactly once** (spy on the binding)
- [ ] projector equivalence: `projectRunToAgui(run, rows)` ≡ `head + rows.flatMap(push) + finish(run)`
- [ ] two parallel calls to the same tool pair correctly; rows without `toolCallId` pair by name as before

---
globs:
  - apps/web/wrangler*.toml
  - apps/web/src/worker.ts
  - apps/web/src/api/queue.ts
  - apps/web/src/api/scheduled.ts
  - apps/web/src/api/workflows/**
  - apps/web/src/api/durable-objects/**
  - apps/web/scripts/cf-provision.sh
  - apps/web/.dev.vars.example
---

# Cloudflare Workers

One Worker, one deploy target. The Hono app, the `NotificationsHub` Durable Object, the
`AgentRunWorkflow` and the queue/cron handlers all ship in `apps/web/src/worker.ts`. Reference: docs/DEPLOY.md. Everything here lives in `apps/web/`; wrangler is a devDependency of
that package, so run it as `pnpm --filter @rocketflare/web exec wrangler …` (never `pnpm exec wrangler` at the
workspace root) or through the root scripts (`pnpm deploy[:staging]`, `pnpm provision`, `pnpm types`).

## Bindings

- Typed by `pnpm types` → `apps/web/worker-configuration.d.ts` (`Cloudflare.Env`), committed. After editing a
  toml, run `pnpm types` and commit the result
- Baseline: `ASSETS`, `HYPERDRIVE`, `RATE_LIMIT_KV`. Phase 2: `JOBS_QUEUE`, `NOTIFICATIONS_HUB`,
  `FILES`. Phase 3 (built): `AGENT_RUN_WORKFLOW` (`[[workflows]]`, class `AgentRunWorkflow`) and `AI`
  (`[ai] binding = "AI"`, Workers AI embeddings). Phase 4 (analytics, D19, built) adds **no binding**:
  cubes read through `HYPERDRIVE`, fact tables rebuild on a cron, and the optional `ANALYTICS_ENGINE`
  dataset is deliberately NOT wired (the toml comment is the only trace). Optional: `ANALYTICS_ENGINE`,
  `HYPERDRIVE_APP`
- Optional bindings are optional in code too: the rate limiter no-ops without `RATE_LIMIT_KV`,
  tracing without Langfuse keys, email without `RESEND_API_KEY`, realtime nudges without
  `NOTIFICATIONS_HUB`. Check presence, don't crash — **except where silence would lose data**: a
  missing `JOBS_QUEUE` throws `JobsQueueNotConfiguredError` (no inline fallback) and a missing
  `FILES` is a 503 `storage_not_configured`, a missing `AGENT_RUN_WORKFLOW` is a 503
  `agent_runs_not_configured` (before any row is written), and a missing `AI` binding is merely the next
  step in both AI chains (`services/ai/resolve.ts`: chat → 503 `ai_not_configured` unless a key or tenant
  row exists; embeddings → `EMBEDDINGS_API_KEY` → 503). With the binding present, Workers AI is the
  zero-key floor for BOTH — and every call bills the account, so removing `[ai]` from both tomls is the
  deliberate zero-spend switch. The same binding also converts knowledge uploads
  (`env.AI.toMarkdown`, `services/ai/convert.ts`): without it a PDF/Office/HTML upload is a 503
  `conversion_not_configured` at the route (nothing stored), text-type uploads keep working; document
  conversion is free on Workers AI (image conversion bills, which is why images are not accepted)
  Decide which of the three a new binding is and say so in its service header
- `[vars]` = non-secret config, visible in the toml. Secrets = `.dev.vars` locally,
  `wrangler secret put` deployed. Never a secret in a toml. AI vars in both tomls:
  `AGENT_MAX_OUTPUT_TOKENS = "16384"`, `AGENT_MAX_TURNS = "30"`; `LANGFUSE_BASE_URL` /
  `LANGFUSE_TRACING_ENVIRONMENT` default in `config.ts` and are added to BOTH files only when
  overridden (the parity test compares `[vars]` keys). AI secrets: `ANTHROPIC_API_KEY`,
  `EMBEDDINGS_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` — all optional

## Two tomls, one shape (D6)

`apps/web/wrangler.toml` (production) and `apps/web/wrangler.staging.toml` are standalone copies. `[env.*]` does not
inherit bindings, so two files are more honest than one with a hidden gap. They may differ in:
`name`, `routes`, `workers_dev`, `[vars]` values, resource `id`s, and account-scoped names. They
must NOT differ in: binding names, `class_name`s, `compatibility_date`/`flags`, `[limits]`,
`[triggers].crons`, `[assets]`, `[[migrations]]`. `apps/web/tests/config/wrangler-parity.test.ts` enforces
this; `REQUIRE_PROVISIONED=1` additionally forbids `<PLACEHOLDER>` values (CI sets it before deploy).

## Account-scoped names

Workflow `name`, queue `queue`, R2 `bucket_name` and Analytics Engine `dataset` are unique per
Cloudflare account, not per Worker. **Whichever script last deployed a Workflow name owns it**, and
every instance created under that name — including by the other environment's binding — runs with
the owner's bindings, against the owner's database. Staging therefore suffixes all of them with
`-staging`; `binding` and `class_name` stay identical so no application code is environment-aware.
`pnpm --filter @rocketflare/web exec wrangler workflows list` shows Name → Script name if you suspect a hijack.
The kit's Workflow is `rocketflare-agent-run` (production) / `rocketflare-agent-run-staging`;
`binding = "AGENT_RUN_WORKFLOW"` and `class_name = "AgentRunWorkflow"` are identical in both files.
Nothing is created by hand — `wrangler deploy` registers the Workflow, `[ai]` needs no resource.

The one place a name leaks into code is the queue consumer: `batch.queue` is the NAME
(`rocketflare-jobs` / `rocketflare-jobs-staging`), so `apps/web/src/api/queue.ts` matches it by
**prefix** — `isJobsQueue()` / `JOBS_QUEUE_NAME_PREFIX` in `apps/web/src/api/services/jobs.ts` —
and `ackAll()`s any queue it does not know. Renaming the queue = both tomls (`[[queues.producers]]`
+ `[[queues.consumers]]`) + that one constant (`tests/api/queue-dispatch.test.ts` pins both names).
Prefix matching also means a `rocketflare-jobs-dlq` would be dispatched to the SAME consumer if you
ever bound a consumer to it — a dead-letter queue you want to inspect rather than reprocess needs a
name outside the prefix or its own branch in `queue.ts`.

## `[limits] cpu_ms` is per step

Workflows bound CPU **per `step.do`** by the script's `cpu_ms` (30 s default, 300 s max on Paid).
CPU is not wall clock: a step that is 95 % I/O still dies if it *processes* enough items. Declare
`[limits]` in BOTH files or in neither (parity test). Split a heavy phase into its own step to draw a
fresh budget. Isolate memory is 128 MiB and not configurable — page through large tables, never
preload them into a `Map`. In the kit the whole tool loop of an agent runs inside the ONE `execute`
step (`step.do('execute', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
timeout: '10 minutes' }, …)`): model calls are I/O, so CPU is rarely the limit, but an agent that
chunks or parses a lot of text in-step draws against the same 30 s. The scaling path is one `step.do`
per model turn with the transcript persisted between turns (`runToolLoop` already returns `messages`).

## Handler shapes

- `queue(batch, env, ctx)` (`apps/web/src/api/queue.ts`): `loadConfig(env)` like `fetch`, prefix-match
  `batch.queue` → `processJobsBatch(batch, { env, config, logger })` (`api/queues/jobs.ts`); per
  message: invalid envelope → `ack()` (poison), handler ok → `ack()`, handler threw → `retry({
  delaySeconds })` (30 s doubling, 15 min cap; toml `max_retries = 3`, `retry_delay = 60` only for a
  retry without an explicit delay); own DB client per message, closed in `finally`; **no `waitUntil`
  in a consumer**. Plain function so tests call it (`.claude/rules/testing.md`)
- `scheduled(event, env, ctx)`: `SCHEDULED_TASKS` keyed on `event.cron` (`'0 4 * * *'` →
  `pruneExpired`; `'15 * * * *'` → `refreshFactTables`, D19 — every `FACT_TABLES` entry, per tenant,
  DELETE+INSERT, per-tenant failures collected and logged as a warning); one DB client per run, closed
  in `waitUntil`; each task try/caught; a new cron string must be added to BOTH tomls and the table
  (the parity test compares `[triggers].crons`). `wrangler dev` never fires crons on its own — trigger
  them by hand (below). Renaming the fact cron = both tomls + the `SCHEDULED_TASKS` key +
  `tests/api/scheduled-facts.test.ts`
- `AgentRunWorkflow` (`apps/web/src/api/workflows/agent-run.ts`): `run(event, step)` → `step.do('claim')` →
  `step.do('execute', { retries, timeout })` → `step.do('finish')`; each step wraps its body in
  `withStepDatabase(env, cfg, db => …)` — ONE DB client per step, `close()` awaited in `finally`
  (Hyperdrive is the pool). Bodies are plain functions in `services/agents/runtime.ts`; step return
  values are small serialisable objects (`{ runId, status }`), never rows. Steps are idempotent because
  the `agent_runs` row is the claim (`UPDATE … WHERE status IN (queued,running) RETURNING`; a retry
  re-claims). Cancellation is cooperative: the run polls `cancelRequestedAt` between model turns. No
  `waitUntil` in a step — nudges are collected and awaited by `createStepRealtime().settle()`, the
  tracer is flushed at the end of `executeRun`
- `NotificationsHub` DO (`apps/web/src/api/durable-objects/notifications-hub.ts`): one per tenant
  (`idFromName(tenantId)`), **stateless** (no `ctx.storage` → `[[migrations]]` stays `new_classes`
  only), hibernation API (`acceptWebSocket` with tags `tenant:<id>`/`user:<id>`, attachment `{
  userId, sessionId, connectedAt }`), `setWebSocketAutoResponse(ping → pong)` instead of any
  `setInterval`. Publish via RPC — `broadcast(event)`, `broadcastToUser(userId, event)`,
  `broadcastToUsers(userIds, event)` → `{ delivered }`, `connectionCount()` → `{ count }` — never
  `fetch` dispatch; `fetch()` accepts ONLY the upgrade forwarded by `routes/ws.ts` (trusted `X-*`
  identity headers, safe because the object is reachable solely via the binding). The class is
  exported from `src/worker.ts`, never from `api/index.ts`
- Never run long work in `fetch`. Enqueue or create a workflow instance (`.claude/rules/api.md`)

## Bundle size (D19 caveat)

`pnpm build:api` (`wrangler deploy --dry-run --outdir dist/api`) is where the Worker's size shows;
`gzip -c dist/api/worker.js | wc -c` is the number. **No figure is written down here or in any other
doc, deliberately** — it moves with every dependency bump, so a quoted one is wrong almost
immediately and reads as a budget nobody is holding. Measure it when you need it.

drizzle-cube dominates the bundle, and it is one import: `drizzle-cube/adapters/hono` statically
imports `dist/adapters/mcp-transport-*.js` (the MCP SDK plus inlined chart rendering) even when
`mcp.enabled` is false. It is not the kit pulling React or recharts into the Worker — the sourcemap
has no `node_modules/react|recharts` entries reached from `src/api`. It is under the Workers script
cap (3 MiB gzip on the free plan, higher on Paid), so it is accepted for now. Do not "fix" it by
adding chunking or externals to the Worker build; the real fix is upstream (a lazy `import()` of the
MCP path in the adapter) or a thin adapter of our own over `drizzle-cube/server`. When you add a
dependency to `src/api`, compare `gzip -c dist/api/worker.js | wc -c` before and after — **the delta
is the thing to look at, not the absolute.**

## `nodejs_compat`: what is allowed

Allowed and used: `Buffer`, `AsyncLocalStorage`, `node:crypto` hashing, `process.env` **inside
dependencies only**. Banned in `apps/web/src/`: `pg`, `pg-boss`, `ws`, `node:fs`, `node:child_process`,
`node:http`, `@hono/node-server`, `@opentelemetry/sdk-node`, any `setInterval` at module scope,
`process.env` (read config via `loadConfig(env)`). `pnpm build:api` (dry-run `wrangler deploy`) is
the check `tsc` cannot do — run it before pushing a new dependency.

## Local testing of the non-HTTP entry points

`wrangler dev` (`pnpm dev:api`, :3001) emulates KV, Queues, DO, R2 and Workflows locally and uses
`localConnectionString` for Hyperdrive. **Start and stop the stack through the scripts, never by
killing a pid**: `pnpm dev` runs `scripts/dev-server.mjs --preflight` first (clears this repo's
leftovers, then refuses to start — exit 1, naming the pid — if anything else holds :3000/:3001),
then supervises `wrangler dev` and Vite ITSELF (no `concurrently`: two children of one node
process is a tree that can be killed, and it lets the script own the output) — a spinner while
they boot, then ONE ready line with the Vite URL, then only app logs, warnings and errors
(wrangler's twice-printed bindings table, its Local-Explorer banner and its copies of requests the
app already logged are filtered; `DEV_VERBOSE=1` or `--verbose` prints every raw line, and
`pnpm dev:api` / `pnpm dev:ui` run either server unfiltered). Ctrl-C, SIGTERM and a child that
dies during boot all go through one `shutdown` — children signalled, then the repo swept, so no
`workerd` is orphaned; a child that dies AFTER ready restarts in 2 s. `pnpm dev:stop` kills the
tree supervisor-FIRST and loops (SIGTERM pass, then SIGKILL passes) until the repo is quiet — a
supervisor can respawn a child between passes and `workerd` often needs the SIGKILL —
and `pnpm dev:status` prints the tree with the port holders. Vite is `strictPort`: a Vite that
quietly moved to :3001 would serve the UI from the API's port and proxy to itself. Ownership is by
command line or cwd inside this repo, and only a `--start` supervisor counts (so a second
terminal's `--stop` is never a target), which is why another checkout on :3001 is reported, never
killed:

```bash
# Fire a cron (wrangler 4.x; the older /cdn-cgi/handler/scheduled path is rewritten to this):
curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=0+4+*+*+*"     # nightly prune
curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=15+*+*+*+*"    # fact-table rebuild (D19)
# Alternative: `wrangler dev --test-scheduled` exposes /__scheduled?cron=…
# Same code without the Worker: `pnpm web db:refresh-facts [table] [--tenant=<uuid>]`, then
# `pnpm web db:check-facts` (exit 1 when a table is stale) or GET /api/analytics/facts/status (admin+).
# Queues: there is no local HTTP trigger. wrangler dev runs the consumer IN-PROCESS, so any producer
# call from the running worker is delivered locally: invite someone (POST /api/invitations from the
# People page) and watch the same terminal print `queue: processing jobs batch` → `[email:dev] …
# Link: <accept url>` → `jobs: done`. For deterministic runs call `processJobsBatch` from a test with
# a hand-built MessageBatch (tests/api/jobs-consumer.test.ts).
# Durable Object: the /ws upgrade (101) only works under wrangler dev / deployed — Node's fetch
# rejects status 101, so tests/api/notifications-hub.test.ts covers the RPC methods and the 400
# guards with a fake DurableObjectState, and tests/api/ws.test.ts stops at the forwarded request
# (the bindings stub answers 501). Open the UI against :3001 and look for the green header dot.
# R2: `wrangler dev` emulates the FILES bucket locally (state under .wrangler/); nothing to create.
# Workflows: `wrangler dev` runs AgentRunWorkflow instances locally — POST /api/agents/runs from the
# running worker (or the UI) and watch the same terminal log `agent-run: …`; the row moves
# queued → running → succeeded and `GET /api/agents/runs/<id>` lists its events. Inspect deployed ones with
pnpm --filter @rocketflare/web exec wrangler workflows instances describe rocketflare-agent-run <runId>
# Workers AI: `wrangler dev` proxies the `AI` binding to Cloudflare (a logged-in account; the calls are
# real). Tests never touch it — `RecordingAi` answers deterministic vectors (.claude/rules/testing.md).
# Offline switch: `pnpm bootstrap --offline` / `--online` (toggleAiBlock in scripts/lib/bootstrap-lib.mjs
# comments the [ai] block out of BOTH tomls, or restores it, text-level — parity stays green because
# the block is absent from both). `pnpm typecheck` then regenerates worker-configuration.d.ts without
# `AI`: never commit that diff — run `--online` first.
```

`pnpm --filter @rocketflare/web exec wrangler tail [-c wrangler.staging.toml]` streams deployed logs; `[observability.logs]` is on.

## Provisioning (`apps/web/scripts/provision.ts`, `scripts/cf-provision.sh`)

The tomls are patched at the **string level only**: `wrangler --update-config` refuses the
commented TOML the kit ships and re-serialising through a TOML library drops every comment, so
`scripts/provision/patch-toml.ts` (anchored regexes, every other byte preserved, idempotent, a
different existing id refused unless `--force`) is the one writer of ids, `APP_URL`, `EMAIL_FROM`
and the `routes` line — `cf-provision.sh --apply` calls it; nobody hand-types an id. (The only other
programmatic toml writer is `toggleAiBlock` above, same byte-preserving rule.) Worker secrets go in
over stdin (`wrangler secret put NAME` reads stdin when it is not a TTY — never `--body`, never
`secret bulk`); the vendor tokens are read from the environment first, then `apps/web/.provision.env`
(git-ignored, 0600, written by `pnpm provision tokens` — TTY only, hidden input, verified per vendor —
never `.dev.vars`, which `wrangler dev` loads into the Worker); every printed line passes the
ONE `redact()` in `scripts/provision/redact.ts` (connection strings, `re_*`, `napi_*`, bearer tokens,
40+ hex — the 32-hex resource ids stay readable on purpose).

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
that package, so run it as `pnpm --filter @gmgo/web exec wrangler …` (never `pnpm exec wrangler` at the
workspace root) or through the root scripts (`pnpm deploy[:staging]`, `pnpm provision`, `pnpm types`).

## Bindings

- Typed by `pnpm types` → `apps/web/worker-configuration.d.ts` (`Cloudflare.Env`), committed. After editing a
  toml, run `pnpm types` and commit the result
- Baseline: `ASSETS`, `HYPERDRIVE`, `RATE_LIMIT_KV`. Phase 2: `JOBS_QUEUE`, `NOTIFICATIONS_HUB`,
  `FILES`. Phase 3: `AGENT_RUN_WORKFLOW`, `AI`. Optional: `ANALYTICS_ENGINE`, `HYPERDRIVE_APP`
- Optional bindings are optional in code too: the rate limiter no-ops without `RATE_LIMIT_KV`,
  tracing without Langfuse keys, email without `RESEND_API_KEY`, realtime nudges without
  `NOTIFICATIONS_HUB`. Check presence, don't crash — **except where silence would lose data**: a
  missing `JOBS_QUEUE` throws `JobsQueueNotConfiguredError` (no inline fallback) and a missing
  `FILES` is a 503 `storage_not_configured`. Decide which of the three a new binding is and say so
  in its service header
- `[vars]` = non-secret config, visible in the toml. Secrets = `.dev.vars` locally,
  `wrangler secret put` deployed. Never a secret in a toml

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
`pnpm --filter @gmgo/web exec wrangler workflows list` shows Name → Script name if you suspect a hijack.

The one place a name leaks into code is the queue consumer: `batch.queue` is the NAME
(`gmgo-starter-jobs` / `gmgo-starter-jobs-staging`), so `apps/web/src/api/queue.ts` matches it by
**prefix** — `isJobsQueue()` / `JOBS_QUEUE_NAME_PREFIX` in `apps/web/src/api/services/jobs.ts` —
and `ackAll()`s any queue it does not know. Renaming the queue = both tomls (`[[queues.producers]]`
+ `[[queues.consumers]]`) + that one constant (`tests/api/queue-dispatch.test.ts` pins both names).
Prefix matching also means a `gmgo-starter-jobs-dlq` would be dispatched to the SAME consumer if you
ever bound a consumer to it — a dead-letter queue you want to inspect rather than reprocess needs a
name outside the prefix or its own branch in `queue.ts`.

## `[limits] cpu_ms` is per step

Workflows bound CPU **per `step.do`** by the script's `cpu_ms` (30 s default, 300 s max on Paid).
CPU is not wall clock: a step that is 95 % I/O still dies if it *processes* enough items. Declare
`[limits]` in BOTH files or in neither (parity test). Split a heavy phase into its own step to draw a
fresh budget. Isolate memory is 128 MiB and not configurable — page through large tables, never
preload them into a `Map`.

## Handler shapes

- `queue(batch, env, ctx)` (`apps/web/src/api/queue.ts`): `loadConfig(env)` like `fetch`, prefix-match
  `batch.queue` → `processJobsBatch(batch, { env, config, logger })` (`api/queues/jobs.ts`); per
  message: invalid envelope → `ack()` (poison), handler ok → `ack()`, handler threw → `retry({
  delaySeconds })` (30 s doubling, 15 min cap; toml `max_retries = 3`, `retry_delay = 60` only for a
  retry without an explicit delay); own DB client per message, closed in `finally`; **no `waitUntil`
  in a consumer**. Plain function so tests call it (`.claude/rules/testing.md`)
- `scheduled(event, env, ctx)`: dispatch table keyed on `event.cron`; each task try/caught; a new
  cron string must be added to BOTH tomls and the table
- Workflow steps are idempotent (upserts), return < 1 MiB (ids, not rows), open their own DB client
  and close it in `finally`. Cancellation is cooperative: poll the run row between steps
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

## `nodejs_compat`: what is allowed

Allowed and used: `Buffer`, `AsyncLocalStorage`, `node:crypto` hashing, `process.env` **inside
dependencies only**. Banned in `apps/web/src/`: `pg`, `pg-boss`, `ws`, `node:fs`, `node:child_process`,
`node:http`, `@hono/node-server`, `@opentelemetry/sdk-node`, any `setInterval` at module scope,
`process.env` (read config via `loadConfig(env)`). `pnpm build:api` (dry-run `wrangler deploy`) is
the check `tsc` cannot do — run it before pushing a new dependency.

## Local testing of the non-HTTP entry points

`wrangler dev` (`pnpm dev:api`, :3001) emulates KV, Queues, DO, R2 and Workflows locally and uses
`localConnectionString` for Hyperdrive:

```bash
# Fire a cron (wrangler 4.x; the older /cdn-cgi/handler/scheduled path is rewritten to this):
curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=0+4+*+*+*"
# Alternative: `wrangler dev --test-scheduled` exposes /__scheduled?cron=…
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
# Workflows: instances created locally run locally; inspect deployed ones with
pnpm --filter @gmgo/web exec wrangler workflows instances describe gmgo-starter-agent-run <id>
```

`pnpm --filter @gmgo/web exec wrangler tail [-c wrangler.staging.toml]` streams deployed logs; `[observability.logs]` is on.

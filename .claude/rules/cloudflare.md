---
globs:
  - wrangler*.toml
  - src/worker.ts
  - src/api/queue.ts
  - src/api/scheduled.ts
  - src/api/workflows/**
  - src/api/durable-objects/**
  - scripts/cf-provision.sh
  - .dev.vars.example
---

# Cloudflare Workers

One Worker, one deploy target. The Hono app, the `NotificationsHub` Durable Object, the
`AgentRunWorkflow` and the queue/cron handlers all ship in `src/worker.ts`. Reference: docs/DEPLOY.md.

## Bindings

- Typed by `pnpm types` → `worker-configuration.d.ts` (`Cloudflare.Env`), committed. After editing a
  toml, run `pnpm types` and commit the result
- Baseline: `ASSETS`, `HYPERDRIVE`, `RATE_LIMIT_KV`. Phase 2: `JOBS_QUEUE`, `NOTIFICATIONS_HUB`,
  `FILES`. Phase 3: `AGENT_RUN_WORKFLOW`, `AI`. Optional: `ANALYTICS_ENGINE`, `HYPERDRIVE_APP`
- Optional bindings are optional in code too: the rate limiter no-ops without `RATE_LIMIT_KV`,
  tracing without Langfuse keys, email without `RESEND_API_KEY`. Check presence, don't crash
- `[vars]` = non-secret config, visible in the toml. Secrets = `.dev.vars` locally,
  `wrangler secret put` deployed. Never a secret in a toml

## Two tomls, one shape (D6)

`wrangler.toml` (production) and `wrangler.staging.toml` are standalone copies. `[env.*]` does not
inherit bindings, so two files are more honest than one with a hidden gap. They may differ in:
`name`, `routes`, `workers_dev`, `[vars]` values, resource `id`s, and account-scoped names. They
must NOT differ in: binding names, `class_name`s, `compatibility_date`/`flags`, `[limits]`,
`[triggers].crons`, `[assets]`, `[[migrations]]`. `tests/config/wrangler-parity.test.ts` enforces
this; `REQUIRE_PROVISIONED=1` additionally forbids `<PLACEHOLDER>` values (CI sets it before deploy).

## Account-scoped names

Workflow `name`, queue `queue`, R2 `bucket_name` and Analytics Engine `dataset` are unique per
Cloudflare account, not per Worker. **Whichever script last deployed a Workflow name owns it**, and
every instance created under that name — including by the other environment's binding — runs with
the owner's bindings, against the owner's database. Staging therefore suffixes all of them with
`-staging`; `binding` and `class_name` stay identical so no application code is environment-aware.
`pnpm exec wrangler workflows list` shows Name → Script name if you suspect a hijack.

## `[limits] cpu_ms` is per step

Workflows bound CPU **per `step.do`** by the script's `cpu_ms` (30 s default, 300 s max on Paid).
CPU is not wall clock: a step that is 95 % I/O still dies if it *processes* enough items. Declare
`[limits]` in BOTH files or in neither (parity test). Split a heavy phase into its own step to draw a
fresh budget. Isolate memory is 128 MiB and not configurable — page through large tables, never
preload them into a `Map`.

## Handler shapes

- `queue(batch, env, ctx)`: switch on `batch.queue`; per message try/catch → `ack()` or `retry({
  delaySeconds })`; the consumer is a plain function so tests can call it (`.claude/rules/testing.md`)
- `scheduled(event, env, ctx)`: dispatch table keyed on `event.cron`; each task try/caught; a new
  cron string must be added to BOTH tomls and the table
- Workflow steps are idempotent (upserts), return < 1 MiB (ids, not rows), open their own DB client
  and close it in `finally`. Cancellation is cooperative: poll the run row between steps
- The DO uses the hibernation API and RPC methods (`broadcast`, `stats`), not `fetch` dispatch; no
  global `setInterval` — use `setWebSocketAutoResponse`
- Never run long work in `fetch`. Enqueue or create a workflow instance (`.claude/rules/api.md`)

## `nodejs_compat`: what is allowed

Allowed and used: `Buffer`, `AsyncLocalStorage`, `node:crypto` hashing, `process.env` **inside
dependencies only**. Banned in `src/`: `pg`, `pg-boss`, `ws`, `node:fs`, `node:child_process`,
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
# Queues: there is no local HTTP trigger. A producer call from the running worker (e.g. a route
# hit through the UI) is delivered to the local consumer inside wrangler dev; for deterministic
# runs call the consumer function from a test with a hand-built MessageBatch.
# Workflows: instances created locally run locally; inspect deployed ones with
pnpm exec wrangler workflows instances describe gmgo-starter-agent-run <id>
```

`wrangler tail [-c wrangler.staging.toml]` streams deployed logs; `[observability.logs]` is on.

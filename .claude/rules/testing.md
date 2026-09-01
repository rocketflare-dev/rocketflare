---
globs:
  - apps/web/tests/**
  - apps/web/vitest.config.ts
  - apps/web/.env.test
  - apps/web/docker-compose.test.yml
  - apps/cli/tests/**
  - apps/cli/vitest.config.ts
---

# Testing Patterns

Vitest in `apps/web` (all commands below are root scripts that delegate there, or run inside
`apps/web`), four projects (`apps/web/vitest.config.ts`): `api` + `api-isolated` (Node, **real Postgres** on 5433),
`ui` (jsdom + Testing Library), `config` (Node, no database: wrangler parity, env schema, pure
helpers, and `tests/dashboards/**` — the dashboard-template structure test, D19). `pnpm test` is two `vitest run` invocations (`test:shared`, `test:isolated`) because
vitest 3 resolves `isolate` per run, not per project.

## Tests run under Node, against the real Hono app

- `app.request(req, env, ctx)` with `env = createTestEnv(overrides)` from `apps/web/tests/mocks/bindings.ts`:
  `DATABASE_URL` from `apps/web/.env.test`, `MemoryKV` as `RATE_LIMIT_KV`, a `RecordingQueue` as
  `JOBS_QUEUE`, a `MemoryR2Bucket` as `FILES`, a `RecordingDurableObjectNamespace` as
  `NOTIFICATIONS_HUB`, a `RecordingAi` as `AI` (deterministic 1024-dim vectors; `respond` overridable),
  a `RecordingWorkflow` as `AGENT_RUN_WORKFLOW` (records `create({ id, params })`, `setStatus(id, …)`
  drives `instance.status()`, `get()` of an unknown id throws `instance.not_found`), a `HYPERDRIVE`
  whose `connectionString` is the test URL; `ctx = createExecutionContext()` collects `waitUntil`
  promises so a test can `await waitOnExecutionContext(ctx)` before asserting side effects
- Reach the stubs through **`stubs(env)`** → `{ kv, queue, files, hub, ai, workflow }`: `queue.messages`
  (what a route enqueued — `[{ body, options }]`), `files.objects` (key → stored bytes/metadata),
  `hub.broadcasts` (`[{ tenantId, args: [method, ...args] }]` — every RPC call on any stub, e.g.
  `['broadcast', event]`; the stub's `fetch` answers 501), `kv.store`, `ai.runs` (`[{ model, inputs }]`),
  `workflow.created` (`[{ id, params }]`) + `workflow.setStatus(id, { status })`. `createTestEnv({
  JOBS_QUEUE: undefined })` / `{ FILES: undefined }` / `{ NOTIFICATIONS_HUB: undefined }` /
  `{ AGENT_RUN_WORKFLOW: undefined }` / `{ AI: undefined }` exercise the missing-binding branches
  (throws / 503 / no-op / 503 `agent_runs_not_configured` / next embeddings tier)
- `cloudflare:workers` is aliased to `apps/web/tests/mocks/cloudflare-workers.ts` (stub `DurableObject`,
  `WorkflowEntrypoint`, plus `createFakeWorkflowStep()` → `{ step, calls }` — runs each `step.do`
  callback inline and records `{ name, config? }`) so worker modules import under Node
- `apps/web/tests/helpers/request.ts` `request()` / `json()` drive the app through every middleware with a
  per-file random client IP (rate-limit isolation); `apps/web/tests/helpers/auth.ts` factories
  (`createTestUser`, `createTestTenant`, `linkUserToTenant`, `createTestTenantWithUser`,
  `createTestSession` → cookie value, `createTestApiKey` → plaintext) use `uniqueId()` suffixes;
  `inject('seed')` gives the run's seeded owner/tenant/API key/session (`TestSeed`)
- No `@cloudflare/vitest-pool-workers` in the default suite (D15). It cannot reach a real Postgres
  through Hyperdrive locally; the value here is integration tests against real Postgres

## Database discipline

- `apps/web/tests/setup.ts` (globalSetup, memoised on `globalThis` because two projects share it): roles →
  migrate → grants → **truncate once** → seed one user/tenant/API key exposed via `provide()`/`inject()`
- Tests never truncate per file. Create what you need with unique data and let it stay; the schema
  is designed for parallel files. If a test genuinely needs an empty table, it is `// @vitest-isolate`
- `apps/web/tests/helpers/db.ts` `safetyCheck()` refuses to run unless `NODE_ENV=test` and `DATABASE_URL`
  is `localhost`. Never point tests at Neon
- Per-file `apps/web/tests/api-setup.ts` closes clients after each file (connection budget: forks × pools)

## The `// @vitest-isolate` marker

`api` shares one module registry per worker; `api-isolated` gives each file a fresh one. If a
file uses `vi.mock`, `vi.stubGlobal`, `vi.spyOn(globalThis…)` or otherwise needs a clean process,
its FIRST line must be **exactly** the marker, with nothing after it; the reason goes on line 2:

```ts
// @vitest-isolate
// Spies on the global fetch, so this file needs its own module registry.
```

`isMarkedIsolated` (`apps/web/tests/helpers/isolation.ts`) compares the trimmed first line to
`// @vitest-isolate` — `// @vitest-isolate — mocks a module` does NOT match, and `vitest.config.ts`
then places the file in the shared `api` project. Forgetting it does not fail in your file; it hands
the fake to whatever runs next in that worker. `apps/web/tests/api/isolation-contract.test.ts`
catches a missing or malformed marker only when its heuristic (`vi.mock|doMock|stubGlobal|stubEnv|
spyOn(globalThis`) matches the file; anything else that leaks (a module-level singleton you mutate,
a fake `WebSocket` factory left set) is on you.

## Testing background work — plain functions, no platform

- Queue consumer (`apps/web/tests/api/jobs-consumer.test.ts` is the template): build messages with
  `buildJobEnvelope(input)` from `services/jobs.ts` (or a deliberately invalid body for the poison
  path) and call the plain function directly —

  ```ts
  const message = { id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1, ack: vi.fn(), retry: vi.fn() }
  const batch = { queue: 'rocketflare-jobs', messages: [message], ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<unknown>
  await processJobsBatch(batch, { env, config: loadConfig(env), logger: fakeLogger(), createDb: () => ({ db, close }) })
  ```

  `createDb` lets the test hand in the shared pool with a `close` spy (assert it was called once per
  message). Assert on DB rows and `ack`/`retry` — valid → `ack`, invalid envelope → `ack` and no
  retry, handler threw → `retry({ delaySeconds: backoffSeconds(attempts) })`. The dispatcher
  `queue(batch, env, ctx)` is tested the same way with the two queue names (`queue-dispatch.test.ts`)
- Durable Object: instantiate `NotificationsHub` with a fake `DurableObjectState`
  (`getWebSockets(tag)` over tagged fake sockets with `send` spies) and call the RPC methods; the
  101 upgrade cannot run under Node (`notifications-hub.test.ts`, `// @vitest-isolate` because it
  stubs `WebSocketRequestResponsePair`). Route tests for `/ws` stop at the forwarded request
- Nudges: `stubs(env).hub.broadcasts` after `waitOnExecutionContext(ctx)` — assert the tenant id,
  the method and the event `type`; `realtime-nudges.test.ts` covers the kit's emitters
- Workflow (`agent-run-workflow.test.ts`, `// @vitest-isolate` because it mocks the resolve seam):
  the step bodies are plain exported functions in `services/agents/runtime.ts` — `claimStep(db, env,
  logger, params)`, `executeRun(db, cfg, env, logger, params)`, `finishStep(db, env, logger, params,
  outcome?)` — call them directly against Postgres, or instantiate `new AgentRunWorkflow(ctx, env)`
  with `createTestEnv()` and drive `run({ payload: { runId, tenantId } }, createFakeWorkflowStep().step)`;
  assert on `calls` (`claim`, `execute` with its `retries`/`timeout` config, `finish`) and on the
  `agent_runs` / `agent_run_events` rows. Test the claim-row gate: `claimRun` on a settled row returns
  `null` and `claimStep` returns `false`; a cancel while `queued` never reaches `execute`
- AI seam: `vi.mock('@/api/services/ai/resolve', async importOriginal => ({ ...(await importOriginal()),
  resolveChat: vi.fn(async () => ({ client: new FakeChatClient(script), provider, model, source,
  maxOutputTokens })) }))` in a `// @vitest-isolate` file (`chat.test.ts`, `agent-run-workflow.test.ts`).
  `FakeChatClient(script)` (`tests/helpers/ai.ts`) answers turns of `{ text, toolUses, usage, error }`,
  streams text in word-sized deltas and records every `calls[i]` (`ChatParams`) so a test can assert the
  system prompt, tools and `toolChoice` the route sent; `sseFrames(res)` parses a `streamSSE` body back
  into `ChatStreamEvent`s. Adapters (`ai-client.test.ts`) take an injected `fetch` — `sseResponse(chunks)`
  builds a fake `text/event-stream` `Response` — so no test reaches a provider. Connection-test and
  resolver branches use `createTestEnv({ ANTHROPIC_API_KEY, EMBEDDINGS_API_KEY })` overrides
- Agent runs (`agent-runs.test.ts`): `POST /api/agents/runs` → 202 + a `queued` row + one entry in
  `stubs(env).workflow.created` with `id === run.id`; the exclusive dedupe (same run back with
  `deduplicated: true`; 409 with `?strict=1`); `createTestEnv({ AGENT_RUN_WORKFLOW: undefined })` →
  503; reconcile-on-read by `workflow.setStatus(id, { status: 'errored' })` then `GET /runs/:id`
- Ingest/retrieval (`ingest-retrieval.test.ts`, `document-index-job.test.ts`): the `RecordingAi` stub
  is the embedder (override `respond` for keyword-keyed vectors), assert `documents.status`,
  `chunks` count, `stubs(env).queue.messages` for the `document.index` handoff over 50 chunks, and that
  tenant B's search never returns tenant A's chunks
- Uploads into knowledge (`document-upload.test.ts`, `document-convert-job.test.ts`): the same stub's
  `toMarkdown` records `stubs(env).ai.conversions` and answers markdown made of the blob's bytes, so a
  fixture PDF is text typed `application/pdf`; override `convert` for `format: 'error'` (→ `failed` +
  ack) or a throw (→ `failed` + retry); `createTestEnv({ AI: undefined, EMBEDDINGS_API_KEY })` is the
  Worker that embeds but cannot convert (503 `conversion_not_configured`, nothing stored)
- Cron: call `scheduled({ cron: '0 4 * * *' }, env, ctx)` and assert the task ran; unknown cron → no-op.
  `scheduled-facts.test.ts` does the same for `'15 * * * *'` (asserts `SCHEDULED_TASKS` registers
  `refreshFactTables`, then dispatches it and reads the fact rows for seeded activity)
- **Cube isolation (D19, MANDATORY — `tests/api/cubes/cube-isolation.test.ts`)**: seed two tenants with
  different members and `activity_events` (`refreshFactTable(db, name, { tenantId })` after seeding so
  the fact cube has rows), then for EVERY cube in `allCubes` run the same `POST /cubejs-api/v1/load`
  as tenant A and as tenant B with a session cookie + `Origin` and assert each sees exactly its own
  rows — and that B's user/tenant ids never appear anywhere in A's payload. The `cases` table is keyed
  by cube name and compared to `allCubes` — **adding a cube without a case fails the suite**. The file
  also covers a join (`ActivityEvents → Users`), `/meta`, 401 / 403 `no_tenant` envelopes, `/mcp`
  JSON-RPC `initialize`, and executes every template portlet query for a tenant (rows > 0).
  `cubes/security.test.ts` unit-tests `extractSecurityContext` / `tenantIdOf`
- Fact tables (`tests/api/services/fact-table-refresh.test.ts`): call `refreshFactTable` directly
  against Postgres — one row per grain (NULL actor included), idempotent, only the refreshed tenant's
  rows replaced, `factTableColumnNames` in declaration order, unknown table throws; `computeFreshness`
  is pure (fresh / stale / never-built cases) and `checkFactTableFreshness` reads the live tables
- Analytics pages (`analytics-pages.test.ts`): first `GET /pages` creates the template pages once;
  `POST /api/tenants` seeds them; CRUD as owner, 403 for a member on every write, 404 across tenants,
  reset restores the template, template delete → 403 `template_page`, `recreate` repairs,
  `/facts/status` is admin+
- Producers: assert on `stubs(env).queue.messages` (RecordingQueue) — `body.type`, `body.payload` —
  and that the route did NOT do the work itself (no `[email:dev]` line, no provider fetch)
- Uploads: `new FormData()` + `form.append('file', new File([bytes], 'a.png', { type: 'image/png' }))`
  as the request body (no `Content-Type` header — the runtime sets the boundary); assert the row, the
  object in `stubs(env).files.objects`, and the 413/415 envelopes (`files.test.ts`,
  `document-upload.test.ts`)

## What every API test file includes

- A tenant-isolation assertion for list/read endpoints (tenant B cannot see tenant A's row); for a
  cube that assertion is a case in `tests/api/cubes/cube-isolation.test.ts`
- An unauthenticated 401 and a wrong-role 403 for a protected route
- The error envelope shape `{ error, statusCode, code? }` on at least one failure path

## UI tests

`apps/web/tests/ui/setup.ts` (jest-dom). `renderWithProviders()` gives QueryClient + Auth + Ability + Router.
Shallow component tests; mock `fetch` where needed, no MSW. `contrast.test.ts` gates the design tokens.
Polling hooks (`agents-page`, `agent-run-detail`, `documents-page`): test the pure decision
(`runPollInterval(status)`), not `refetchInterval` with fake timers; `agent-run-detail` mounts inside
`WebSocketProvider` with the `FakeSocket` to prove an `entity.changed { entity: 'agent-run' }` nudge
refetches. Streaming (`chat-page.test.tsx`, `sse.test.ts`): `tests/ui/helpers/sse.ts` builds fake
`text/event-stream` `Response`s (`sseResponse(frames)`, `streamResponse` for arbitrary chunk
boundaries, `hangingSseResponse` for the Stop button); assert with `waitFor`, not `findBy` — bubbles
remount when the optimistic id becomes the persisted one. Pure parsers (`chunking.test.ts`,
`permissions.test.ts` — the matrix incl. `AiConfig`/`Prompt`/`Conversation`/`AgentRun`/`Document`/
`Dashboard`/`Analytics`) live in the `config` project, as does **`tests/dashboards/all-templates.test.ts`**
(D19, no database): every `DASHBOARD_TEMPLATES` entry is checked structurally — `layoutMode: 'rows'`,
row widths sum to 12, unique row/group/portlet ids, every column resolves to a portlet or group, every
portlet placed exactly once with x/y/w/h matching its row, filters mapped only to declared filters,
**every `Cube.member` in a portlet query exists in `allCubes`** (the frozen-names guard), `recordsTable`
is `ungrouped`, the chart rules from `DASHBOARD_PATTERNS.md`, registry keys/orders/one default.
Changing a template or a cube member without running it is how a stored dashboard breaks silently.

## Commands

`pnpm test:db:up` once, then `pnpm test` (root: every package, `pnpm -r test`; web tests load
`apps/web/.env.test` via their own `dotenv` script, so no cwd juggling). Single projects run through
the web package: `pnpm web test:api` · `pnpm web test:ui` · `pnpm web test:config` ·
`pnpm test:coverage`. `REQUIRE_PROVISIONED=1 pnpm --filter @rocketflare/web test:config` is what CI runs
before a deploy.

## CLI tests (`apps/cli/tests`)

Plain vitest, Node, no database. Test commands in-process through their exported functions with a
`CommandContext` carrying a fake `fetch`, a no-op `open`, a memory output and a temp `ROCKETFLARE_CONFIG_DIR`;
never touch the real `~/.rocketflare`. Assert `CliError.exitCode` and `--json` output shape (parsed with the
`@rocketflare/shared` schema), never chalk-coloured text (`.claude/rules/cli.md`).

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
helpers, the cross-tenant allow-list scan, and `tests/dashboards/**` — the dashboard-template structure test, D19). `pnpm test` is two `vitest run` invocations (`test:shared`, `test:isolated`) because
vitest 3 resolves `isolate` per run, not per project.

## Tests run under Node, against the real Hono app

- `app.request(req, env, ctx)` with `env = createTestEnv(overrides)` from `apps/web/tests/mocks/bindings.ts`:
  `DATABASE_URL` from `apps/web/.env.test`, `MemoryKV` as `RATE_LIMIT_KV`, a `RecordingQueue` as
  `JOBS_QUEUE`, a `MemoryR2Bucket` as `FILES`, a `RecordingDurableObjectNamespace` as
  `NOTIFICATIONS_HUB`, a `RecordingAi` as `AI` (deterministic 1024-dim vectors; `respond` overridable),
  a `RecordingWorkflow` as `AGENT_RUN_WORKFLOW` (records `create({ id, params })` and `sendEvent`,
  `setStatus(id, …)` drives `instance.status()`, `terminated[]` records a forced cancel, `get()` of
  an unknown id throws `instance.not_found`, and `failSendEvent` simulates the instance a park
  outlived — retention expired, or `wrangler dev` restarted), a `HYPERDRIVE`
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
  `WorkflowEntrypoint`, plus `createFakeWorkflowStep(options)` → `{ step, calls, waits, names }` —
  runs each `step.do` callback inline and records `{ name, config? }`; `waitForEvent` is a RECORDER,
  not a throw, with an `events[]` payload queue, an `onWait` hook (the test's stand-in for a person
  clicking Approve, which must flip the row BEFORE the wait resolves) and a `FakeWorkflowTimeoutError`
  for the expiry path. `names` is every step name in order, because the one property no fake can
  check is that they are DISTINCT per round) so worker modules import under Node
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
  assert on `calls` (`claim`, `execute#0` with its `retries`/`timeout` config, then `resume#0` /
  `expire#0` / `execute#1` for a parked run, `finish`) and on the `agent_runs` / `agent_run_events`
  rows. **Assert the step NAMES are distinct** — the platform replays a repeated name's recorded
  result, which reads as "the agent ignored my approval", and only `names` can catch it. Test the claim-row gate: `claimRun` on a settled row returns
  `null` and `claimStep` returns `false`; a cancel while `queued` never reaches `execute`
- AI seam: `vi.mock('@/api/services/ai/resolve', async importOriginal => ({ ...(await importOriginal()),
  resolveChat: vi.fn(async () => ({ client: new FakeChatClient(script), provider, model, source,
  maxOutputTokens })) }))` in a `// @vitest-isolate` file (`chat.test.ts`, `agent-run-workflow.test.ts`).
  `FakeChatClient(script)` (`tests/helpers/ai.ts`) answers turns of `{ text, toolUses, usage, error }`,
  streams text in word-sized deltas and records every `calls[i]` (`ChatParams`) so a test can assert the
  system prompt, tools and `toolChoice` the route sent; `aguiFrames(res)` parses an AG-UI stream body
  back into typed events, `splitSseFrames` returns `{ event, id, data, raw }` per frame (so a test can assert there is NO
  `event:` line, that `id:` lands only on the last frame of a row's group, and that a binary
  transport wrote no comment frames), and `aguiTypes` / `customEvents` / `customEvent` let a test assert the SEQUENCE
  rather than a dozen literals. Adapters (`ai-client.test.ts`) take an injected `fetch` — `sseResponse(chunks)`
  builds a fake `text/event-stream` `Response` — so no test reaches a provider. Connection-test and
  resolver branches use `createTestEnv({ ANTHROPIC_API_KEY, EMBEDDINGS_API_KEY })` overrides
- **Human-in-the-loop (issue #17)** spreads over five files and each owns one seam:
  `tests/config/agent-interrupts.test.ts` (the pure contracts — payload schemas, `INTERRUPT_REJECTION`,
  and the golden assertion that `AGENT_RESUME_EVENT` matches `/^[A-Za-z0-9_-]{1,100}$/`, because
  Cloudflare rejects a `.` with `workflow.invalid_event_type` and no fake would ever catch it);
  `agent-interrupts.test.ts` (the service: create-or-read on `(run_id, key)`, compare-and-set,
  expiry); `agent-interrupt-routes.test.ts` (403 under `approvers: 'admin'`, 409 on a double answer,
  404 across tenants, `editedInput` without `allowEdits` → 400); `agent-tool-loop-interrupt.test.ts`
  (**the gate raises BEFORE the handler runs — assert the spy was not called**; a whole turn parks
  when one of three calls is gated; an approved tool executes exactly once across a step retry);
  and `agent-run-stream.test.ts`, which injects `{ now, sleep }` (`RunStreamDeps`) so the suite is
  never timer-bound, and asserts a body error emits **no `RUN_ERROR`** — the deliberate inversion of
  the chat rule
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
Polling hooks (`agents-page`, `run-page`, `documents-page`): test the pure decision
(`runPollInterval(status)` over `runOwesAnswer`, so a parked run polls NEVER), not `refetchInterval`
with fake timers; `run-page` mounts inside `WebSocketProvider` with the `FakeSocket` to prove an
`entity.changed { entity: 'agent-run' }` nudge refetches — and that it does NOT wipe
`['agent-run-agui']`, which the stream owns. `run-stream` covers the read-stream client. Streaming (`chat-page.test.tsx`, `sse.test.ts`): `tests/ui/helpers/sse.ts` builds fake
`text/event-stream` `Response`s in the server's AG-UI framing — `data:` only, no `event:` line —
(`aguiRun({ text, tools, unterminated })` for a whole turn, `sseResponse(frames)`,
`streamResponse` for arbitrary chunk boundaries, `hangingSseResponse` for the Stop button); assert with `waitFor`, not `findBy` — bubbles
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

## Plugin tests (D31)

**A plugin tests its behaviour; the host tests that it is a well-formed plugin.** That division is
the whole rule, and it is why neither half duplicates the other.

- **A plugin's tests live inside it** — `src/plugins/<id>/tests/{api,ui,config}` — so installing or
  removing one moves its tests with it and never touches `tests/`. `vitest.config.ts` discovers all
  three: the `ui` and `config` projects by glob, and the api ones through the same `apiTestFiles()`
  walk the kit's use, so **the `// @vitest-isolate` marker decides which api project a plugin file
  lands in exactly as it does for a kit file** (first line, exact match, reason on line 2)
- **A plugin's api test MUST carry a tenant-isolation case.** Its tables are tenant-scoped like any
  other and the kit's own suites cannot see them:
  `src/plugins/example-feature/tests/api/example-feature.test.ts` is the template — tenant B can
  neither list, read nor delete tenant A's notes — beside the 404 feature gate, CRUD, ownership,
  the hooks, the enqueue and the tool
- **The host's structural suite is `tests/config/plugins.test.ts`**: ids are namespaces and never
  contain the kit's name, query-key roots carry `<id>:`, nothing reaches INTO a plugin except
  through its four published entries, and a plugin's `ui.ts` imports only from the allowlist and
  reaches its pages only through `lazy(() => import(...))`. Every check is a pure function over
  strings, exercised with FIXTURES as well as over whatever is installed — which is what keeps it
  meaningful in a kit with no plugins. The `expectTypeOf` block at the end is checked by
  `pnpm typecheck`, not at run time
- `tests/config/shared-imports.test.ts` carries the leaf rule: `packages/shared/src/plugins/**`
  never imports one of the five composers (`ai/agents.ts`, `jobs.ts`, `permissions.ts`,
  `features.ts`, `realtime.ts`) **at runtime** — a whole-declaration `import type` is fine,
  `import { type X } from` is not — because those five read the plugin barrel and two zod modules
  in a cycle crash at module evaluation rather than failing to compile. All three spellings are
  checked. `rls-coverage.test.ts` and `unscoped-allowlist.test.ts` union in each plugin's own
  entries, so a plugin table still has to prove its policy
- **A kit test must not borrow a plugin's keys.** `tests/config/features.test.ts` and
  `tests/api/feature-flags.test.ts` register their own fixture flag now: the kit ships none,
  `feature_flags.key` is platform state with `tenant_feature_overrides` cascading off it, and two
  files resetting one key delete each other's rows across tenants. The API one is
  `// @vitest-isolate` because it mutates the shared registry. For the same reason an assertion that
  pinned the exact agent-tool list is a PREFIX assertion — a plugin's tools are appended after the
  kit's three

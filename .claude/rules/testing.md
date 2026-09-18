---
paths:
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
helpers, and every installed plugin's own `src/plugins/*/tests/config/**`). `pnpm test` is two `vitest run` invocations (`test:shared`, `test:isolated`) because
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
  A PLUGIN's cron task is tested the same way and the test belongs to the plugin (the analytics
  plugin's `scheduled-facts.test.ts` asserts `SCHEDULED_TASKS` registers `analytics.refreshFactTables`
  under `'15 * * * *'`, then dispatches it and reads the fact rows) — which is the one thing that
  proves the host's toml and the plugin's task met, because a task under an expression no toml
  declares never runs
- **A PLUGIN's tests live inside it and run in the host's projects** (D31):
  `src/plugins/<id>/tests/{api,ui,config}` are in `vitest.config.ts`'s `include` globs, so they use
  the same `createTestEnv`, the same `setupTestDatabase` and the same `request()` helpers, reached
  by a relative path out of the plugin. **The rule is: a plugin tests its BEHAVIOUR, the host tests
  that it is a well-formed plugin** (`tests/config/plugins.test.ts` — ids, namespaced query-key
  roots, no deep import past the four entries, a `ui.ts` with no eager page). Two of the analytics
  plugin's are worth copying:
  - **Cube isolation (MANDATORY)**: seed two tenants with different members and `activity_events`,
    then for EVERY cube in `allCubes()` run the same `POST /cubejs-api/v1/load` as tenant A and as
    tenant B and assert each sees exactly its own rows — and that B's ids never appear anywhere in
    A's payload. The `cases` table is compared to the whole registry, **contributed cubes included**,
    so adding a cube without a case fails the suite. drizzle-cube adds no second line of defence, so
    this file is the only enforcement of tenant scoping in the cube layer.
  - **A visibility matrix per restrictable resource**: the kit's `access-visibility.test.ts` walks a
    restricted DOCUMENT past every read path; the plugin's `dashboard-visibility.test.ts` does the
    same for its own rows, including the two shapes that matter most — an EMPTY grant list is
    private rather than public, and a hidden row answers the SAME 404 as a missing one.
- Producers: assert on `stubs(env).queue.messages` (RecordingQueue) — `body.type`, `body.payload` —
  and that the route did NOT do the work itself (no `[email:dev]` line, no provider fetch)
- Uploads: `new FormData()` + `form.append('file', new File([bytes], 'a.png', { type: 'image/png' }))`
  as the request body (no `Content-Type` header — the runtime sets the boundary); assert the row, the
  object in `stubs(env).files.objects`, and the 413/415 envelopes (`files.test.ts`,
  `document-upload.test.ts`)

## What every API test file includes

- A tenant-isolation assertion for list/read endpoints (tenant B cannot see tenant A's row); for a
  cube or other query surface a plugin adds, that assertion is a case in the plugin's own isolation test
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
plus whatever a plugin declares) live in the `config` project, as do every installed plugin's own
`tests/config/**` — the analytics plugin's `all-templates.test.ts` is the pattern: a pure structural
check over a registry, with no database, that would otherwise only fail at runtime in somebody's
tenant.

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
- **A plugin reaches the harness through `@testkit`, never a relative climb into `tests/`.** Two
  entries, split by what a test needs: `@testkit/integration` is the harness (`setupTestDatabase`,
  `request` / `json`, `createTestEnv` / `stubs`, the auth factories, `renderWithProviders`) and
  `@testkit/unit` the context builders (`makeRequestCtx`, `makeJobCtx`, `makeCronCtx`,
  `makeWorkflowCtx`, `makeToolCtx`). Both are re-exports, so a plugin and a kit test run the same
  code. The alias is in `tsconfig.json` and `vitest.config.ts` and **deliberately not in
  `vite.config.ts`**, so a `src/` file importing it fails `build:ui` rather than shipping the
  harness into a browser bundle — `tests/config/testkit-alias.test.ts` pins all three halves and
  scans `src/` directly, because a scan says WHICH file is wrong where a failed build says only that
  one is. **`build:api` does not protect the other side**: wrangler resolves tsconfig paths, so a
  stray import there is bundled rather than refused (measured at +866 KB), and the source scan in
  `tests/config/plugins.test.ts` is the only thing standing between it and production
- **The builders refuse a `db` nobody handed out** — they require a handle blessed by
  `setupTestDatabase`, tracked in a `WeakSet` rather than by shape, because `{ execute: vi.fn() }`
  passes a shape check and is exactly the object the rule exists to refuse. Injection is what makes
  it easy to write a test that LOOKS like an isolation proof and proves nothing: a stub answering
  `[]` satisfies "tenant B sees no rows" whatever the query said. So a fake context may test
  branching, guards and response shape; **anything touching data is on real Postgres by
  construction**, and the isolation case drives the real mount through `request(...)` as a second
  tenant. Accepted cost, stated rather than discovered: there is no fast, database-free test of a
  data-touching handler
- **A structural check must read comment-free code, or it validates prose.** The rule is for anyone
  writing one, because the failure mode is invisible — a green check that proves nothing. Three in
  `scripts/lib/plugin-lib.mjs` were silently substring-matching: `workerExports` over raw source,
  satisfied by a class named only in a comment; `onTenantDeleted` through `.includes(...)`, which
  passed on a fixture that plainly broke the rule; `isolationEvidence` through regexes a header
  paragraph or a commented-out `createTestTenant(db)` satisfied. `stripComments` runs first in all
  three now, and each requires a real DECLARATION (`declaresProperty`) rather than a mention
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

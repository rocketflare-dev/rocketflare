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
`apps/web`), nine projects (`apps/web/vitest.config.ts`): `api` + `api-isolated` + `api-fixtures` (Node, **real Postgres** on 5433),
`driver` (D35: `tests/driver/**` — the CONFORMANCE suite for the driver seam, through
`openDatabase`, against the real database, run under both drivers; `tests/driver/CLAUDE.md`),
`ui` + `ui-isolated` (jsdom + Testing Library), `config` (Node, no database: wrangler parity, env schema, pure
helpers, the driver guards `driver-results.test.ts` and `driver-conformance.test.ts`, and every
installed plugin's own `src/plugins/*/tests/config/**`), and `kit-only` (Node, no database:
`tests/kit-only/**`, the KIT's own tests — see below), and `config-isolated` beside `config`. Each
shared-registry project sets `isolate: false` in `vitest.config.ts`, so no command line carries
`--no-isolate`. The full web suite is two `vitest run` invocations (`api`, then the rest), which
measured faster than one.

**`pnpm test` is the one full test run** (`scripts/test.mjs`, the plan in
`scripts/lib/test-plan.mjs`, unit-tested in `tests/kit-only/gate.test.ts`), and the `test` step of
`pnpm gate`. It prints its target first. On a **local** target (the default) it starts the compose
test Postgres and Neon proxy itself, runs every package's tests with the web suite under
`postgres`, then the `driver` project again under `neon` through the proxy. On a **remote** target
(`TEST_DATABASE_BRANCH` set — see below) it runs the whole web suite under `neon` on that branch,
with no Docker, and says the postgres conformance half was skipped. `GATE_SUITE_DRIVER=neon` runs
the local suite under `neon` instead (kit.yml's backstop; a way to chase a seam hole).

**Kit-only tests** (`docs/CONCEPTS.md` §13) live in `apps/web/tests/kit-only/` and nowhere else: a
test belongs there when it is true of the kit repository and of nothing made from it — the porting
notes and the root version being the kit's (`upgrade-notes`), the release and rename machinery
(`release-lib`, `release-root`, `rename-lib`, `rename-safe-identifiers`), the maintainer nudge hooks,
the plugin CI that plugin repositories call from the kit, the manifest's kit-state claims
(`kit-only/kit-manifest.test.ts`), the Launch conformance checker and its parsers (`kit-check`,
`kit-check-parsers`, `launch-kit-schema` — the kit keeps them in step with the meta-kit), and the
kit's own doc guards (`gate-string`) — and the kit's TOOLING: every test whose subject is
`scripts/**` machinery or the rf-security runner (`plugin-*`, `upgrade-*`, `manifest-lib`,
`surface`, `repo-paths`, `bundle*`, `deployer`, `release-version-only`, `gate*`,
`bootstrap-lib`, `prereqs-sh`, the dev-tooling and `provision-*` helpers, `patch-toml`,
`design-docs`, `rf-security/`). A copy runs that tooling but does not write it: it arrives through
`kit:upgrade` already tested by the kit's gate, so re-running its end-to-end suites on every app
commit buys the app nothing. `scripts/rename.mjs` deletes the directory — and every other
`kitOnly` path: the maintainer scripts, their package.json scripts and `.claude/settings.json`
hooks — when a copy is born and unwires `--project kit-only`; the project is registered only while the directory exists;
`kit:upgrade` never ports one; `tests/config/kit-manifest.test.ts` fails a copy that carries one.
A test of anything the APP ships — its config, its composition (plugins well-formed, the MCP
seam, wrangler parity), its code's pure halves — stays in `config`; the copy's gate is where it earns
its keep. Such a test never judges the checkout's own state — its tomls, `launch.kit.json`, version or
provisioning — because a copy's differ by design (renamed, then provisioned by Launch, which
commits real KV ids). Build a fixture (`tests/kit-only/fixtures/`: the toml snapshots feed the
patcher's tests; `tests/kit-only/fixtures/kit-fixture.mjs` makes a whole kit, fresh or provisioned
like Launch's `write_config`, for the kit-only conformance tests), and put the claim about THIS
checkout in `kit-only`.

**The security audit's runner** (`.claude/skills/rf-security/tools/`, `docs/SECURITY-AUDIT.md`) is
tested in `kit-only` by `tests/kit-only/rf-security/`: child-process runs of `audit.mjs` and
`guard-hook.mjs` over a synthetic run in the OS temp directory (`fixture.ts` plays the agents'
part; `RF_SECURITY_RUNS` points the runs root there), never a real run's files. A confirmed audit
finding, once fixed, lands as a permanent regression test in `tests/api/security/`, named for the
behaviour rather than the attack.

## Tests run under Node, against the real Hono app

- `app.request(req, env, ctx)` with `env = createTestEnv(overrides)` from `apps/web/tests/mocks/bindings.ts`:
  `DATABASE_URL` from `apps/web/.env.test`, `MemoryKV` as `RATE_LIMIT_KV`, a `RecordingQueue` as
  `JOBS_QUEUE`, a `MemoryR2Bucket` as `FILES`, a `RecordingDurableObjectNamespace` as
  `NOTIFICATIONS_HUB`, a `RecordingAi` as `AI` (deterministic 1024-dim vectors; `respond` overridable),
  a `RecordingWorkflow` as `AGENT_RUN_WORKFLOW` (records `create({ id, params })` and `sendEvent`,
  `setStatus(id, …)` drives `instance.status()`, `terminated[]` records a forced cancel, `get()` of
  an unknown id throws `instance.not_found`, and `failSendEvent` simulates the instance a park
  outlived — retention expired, or `wrangler dev` restarted), and the database for the driver
  `.env.test` selects — under `postgres` (the default) a `HYPERDRIVE` stub whose `connectionString`
  is the test URL, under `neon` NO `HYPERDRIVE` (a deployed `neon` Worker has none) plus
  `DATABASE_DRIVER` / `NEON_LOCAL_PROXY`; `ctx = createExecutionContext()` collects `waitUntil`
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
  `createTestSession` → cookie value, `createTestApiKey` → plaintext) use `uniqueId()` suffixes —
  slug-safe (`[a-z0-9]+-[a-z0-9]+`), so a factory tenant's slug passes `SLUG_RE` in a request;
  `inject('seed')` gives the run's seeded owner/tenant/API key/session (`TestSeed`)
- No `@cloudflare/vitest-pool-workers` in the default suite (D15). It cannot reach a real Postgres
  through Hyperdrive locally; the value here is integration tests against real Postgres

## Database discipline

- `apps/web/tests/setup.ts` (globalSetup, memoised on `globalThis` because two projects share it): roles →
  migrate → grants → **truncate once** → seed one user/tenant/API key exposed via `provide()`/`inject()`.
  A failure there (no `.env.test` loaded, a migration Postgres refuses) is printed as itself by
  `tests/helpers/startup-error.ts`, not as Vite's `code.charCodeAt is not a function`
- Tests never truncate per file. Create what you need with unique data and let it stay; the schema
  is designed for parallel files. If a test genuinely needs an empty table, it is `// @vitest-isolate`
- A cross-tenant cron task under test (a prune, a sweep) also acts on OTHER files' rows. Assert only
  on your own rows; and where the outcome depends on the caller's stubs (`runSweepLostRuns` asks the
  file's own Workflow stub), hold `itSweeps`/`withSweepLock` (`tests/helpers/sweeps.ts`) from the
  backdate to the last assertion
- `apps/web/tests/helpers/db.ts` `safetyCheck()` refuses to run unless `NODE_ENV=test` and `DATABASE_URL`'s
  HOST is local. Never point tests at Neon — except `pnpm test` on a throwaway gate branch, which
  needs `TEST_DATABASE_BRANCH=gate-<short>-<attempt>` and `TEST_DATABASE_ENDPOINT` = the URL's
  `ep-…` id (rules and reasons: `tests/helpers/db-safety.ts`, unit-tested in
  `tests/config/db-safety.test.ts`). The runner sets `TEST_DATABASE_EPHEMERAL=1` for that target;
  it runs 2 forks, and a test needing TCP or a superuser skips itself with
  `isEphemeralTestRun(process.env)` and a stated reason (`db-roles.test.ts`)
- **Time limits scale with the target, never per test.** `vitest.config.ts` multiplies the test,
  hook and teardown limits by one latency factor (`tests/helpers/latency.ts`): 1 locally under
  `postgres` (vitest's 5 s stays the tripwire for a genuinely slow test), 4 under `neon` through
  the proxy, 12 on a real Neon branch. `TEST_LATENCY_FACTOR` raises it (never lowers it) on a slow
  machine — a coding sandbox running a test by hand; anything but a positive number throws. No test carries a numeric budget of its own: a test that is slow only on a slow link is
  walking to a limit query by query, so it LOWERS that limit — `runStreamBody`'s injectable
  `maxMs`, `AgentRunWorkflow.maxInterruptRounds` — and asserts the behaviour at it. The one
  project-level exception is `config` and `kit-only` (`PROCESS_TEST_TIMEOUT`, 20 s × the factor):
  they drive the kit's tooling end to end through child processes, which slow with CPU load, not
  with a database link
- Per-file `apps/web/tests/api-setup.ts` closes clients after each file (connection budget: forks × pools)
  and installs the **network guard** (`tests/helpers/network-guard.ts`): an api test never reaches
  the internet — a request to anything but loopback / `localhost` / `*.localtest.me` rejects AT ONCE
  with `OutboundNetworkError` naming the URL. A test that needs a provider's answer runs a local
  `node:http` server on 127.0.0.1 (`security/ai-config-stored-credential.test.ts`) or injects
  `fetch`. A row on a vendor's DEFAULT endpoint is a real call: give it a local `baseUrl`. A test
  that takes seconds is waiting on something — a timeout, a retry backoff, a lock — not slow
- **Both drivers (D35), one seam.** `.env.test` sets `DATABASE_DRIVER=postgres`, so the narrow
  scripts and the suite run postgres.js; `pnpm test` then runs the `driver` project under `neon`
  through the proxy on :4433 (compose profile `neon`). App code does not branch on the driver, so
  the conformance pass is what proves the deployed path (`apps/web/src/db/CLAUDE.md`). Fixture
  handles (`setupTestDatabase` → `getScriptDatabase(url, process.env)`) follow the same var and
  use the WebSocket pool under `neon`; the request path is neon-http, as deployed. A raw result is
  read with `rows()` / `affected()` in tests too

## The `// @vitest-isolate` marker

`api` shares one module registry per worker; `api-isolated` gives each file a fresh one. A file
that evaluates a module under a fake (`vi.mock`, `vi.doMock`) or drops the registry
(`vi.resetModules`) must carry the marker on its FIRST line, **exactly**, with nothing after it;
the reason goes on line 2:

```ts
// @vitest-isolate
// Mocks the plugin barrels, so this file needs its own module registry.
```

A file that runs the fixture agents (`tests/helpers/fixture-agents.ts`) carries
`// @vitest-fixture-agents` on its first line instead, and mocks nothing: it runs in
`api-fixtures`, a shared registry whose setup (`tests/api-fixtures-setup.ts`) installs the fixture
plugin into the real barrels once per worker, before the app is first imported — the agent-key
enum is `z.enum(AGENT_KEYS)`, frozen at import, so the fixture must be there first.

Spies and stubs need no marker. Vitest restores every `vi.spyOn` spy (on `globalThis.fetch`
included) after each file even in a shared registry, and the per-file setups (`tests/api-setup.ts`,
`tests/ui/setup.ts`, `tests/config/setup.ts`) run `vi.unstubAllGlobals()` and `vi.unstubAllEnvs()`.
Prefer a seam to a module mock — in ui tests too: `overrideHardNavigateForTests` (`@/ui/lib/navigation`, restored by `tests/ui/setup.ts`) records full-page navigations, and `SettingsLayout` takes a `plugins` prop for fixture tabs. `overrideResolveChatForTests` (a fake chat client) is reset by
`api-setup.ts` after each file, so a file using it shares the registry.

`isMarkedIsolated` (`apps/web/tests/helpers/isolation.ts`) compares the trimmed first line to
`// @vitest-isolate` — `// @vitest-isolate — mocks a module` does NOT match, and `vitest.config.ts`
then places the file in the shared `api` project. Forgetting it does not fail in your file; it hands
the fake to whatever runs next in that worker. `apps/web/tests/config/isolation-contract.test.ts`
walks the same directories as `vitest.config.ts` (`testDirs`: `tests/api` and every installed
plugin's `src/plugins/<id>/tests/api`) and catches a missing or malformed marker when its heuristic
(`vi.mock|doMock|resetModules`) matches the file. What it cannot see is module-level state a test
mutates: a registry entry added (`FEATURE_FLAGS`, `AGENTS`), a fake factory left set. Restore it in
`afterAll` (`feature-flags.test.ts`, `seed-features.test.ts`), or mark the file.

**`ui` is split the same way, but by the heuristic itself.** `ui` shares a registry
(`isolate: false` in its project config); a ui file goes to `ui-isolated` when it carries the
marker OR the heuristic matches it (`uiNeedsIsolation`). No marker is needed, because a plugin's ui
tests live in the plugin's repository and a host must not break the day a plugin ships an unmarked
one. Under the shared registry the app's module-level state outlives a file, so
`tests/ui/setup.ts` resets the singletons after each test (`queryClient`, the toast and websocket
stores) and unstubs globals after each file. A new module-level store gets a reset line there.
`config` and `config-isolated` split the same way. The shared `config` project also loads the
server barrel first (`tests/config/shared-setup.ts`): a file importing a plugin module directly
would otherwise enter the plugin import cycle from the plugin's side and leave a barrel holding
`undefined` cached for every later file.

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
  101 upgrade cannot run under Node (`notifications-hub.test.ts`, which stubs
  `WebSocketRequestResponsePair` with `vi.stubGlobal`). Route tests for `/ws` stop at the forwarded request
- Nudges: `stubs(env).hub.broadcasts` after `waitOnExecutionContext(ctx)` — assert the tenant id,
  the method and the event `type`; `realtime-nudges.test.ts` covers the kit's emitters
- Workflow (`agent-run-workflow.test.ts`, a fake chat client through `overrideResolveChatForTests`):
  the step bodies are plain exported functions in `services/agents/runtime.ts` — `claimStep(db, env,
  logger, params)`, `executeRun(db, cfg, env, logger, params)`, `finishStep(db, env, logger, params,
  outcome?)` — call them directly against Postgres, or instantiate `new AgentRunWorkflow(ctx, env)`
  with `createTestEnv()` and drive `run({ payload: { runId, tenantId } }, createFakeWorkflowStep().step)`;
  assert on `calls` (`claim`, `execute#0` with its `retries`/`timeout` config, then `resume#0` /
  `expire#0` / `execute#1` for a parked run, `finish`) and on the `agent_runs` / `agent_run_events`
  rows. **Assert the step NAMES are distinct** — the platform replays a repeated name's recorded
  result, which reads as "the agent ignored my approval", and only `names` can catch it. Test the claim-row gate: `claimRun` on a settled row returns
  `null` and `claimStep` returns `false`; a cancel while `queued` never reaches `execute`
- A route that resolves chat through the REAL seam (a plugin's `streamChat`): `scriptPlatformChat(env,
  turns)` (`tests/helpers/ai.ts`, re-exported by `@testkit/integration`) scripts the `AI` binding
  stub's chat answers — `{ text?, toolCalls?: [{ name, input }], usage? }` per turn — and returns
  the recorded calls; `createTestEnv({ AI: undefined })` is the 503 (`plugin-stream-chat.test.ts`)
- AI seam: `overrideResolveChatForTests(async () => ({ client: new FakeChatClient(script), provider,
  model, source, billedToPlatform: false, maxOutputTokens }))` at the top of the file, and
  `overrideResolveDecisionsForTests` for `ctx.decide` (`chat.test.ts`, `agent-triage-research.test.ts`);
  `tests/api-setup.ts` resets both after each file, so the file shares the `api` registry. Record
  calls inside the override if the test asserts on them — never `vi.mock` the module.
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
- Tracing (D32): `tests/config/observability.test.ts` needs no database — `createTracer({ sinks:
  [collect] })` hands a test every recorded span, `tracerFor(cfg, { fetch })` takes an injected
  `fetch` for the OTLP POST, and the OTLP/JSON request is compared to a FIXTURE (the protobuf case
  walks the bytes back with a small decoder). Nesting is asserted through the real `runToolLoop`, so
  the tool span comes from the kit's tool runner, not the test. `tests/api/traces.test.ts` writes
  spans through `databaseSpanStore(db)` and reads them back through `/api/traces` (tenant B's id is a
  404). The integration assertions live beside the paths they cover: `agent-run-workflow.test.ts`
  (one trace per run, `execute#0` under the derived root) and `chat-tools.test.ts` (chat → tool →
  retrieval → embeddings, `messages.trace_id`). `JobContext.tracer` is OPTIONAL, so a hand-built job
  context needs none
- Cron: call `scheduled({ cron: '0 4 * * *' }, env, ctx)` and assert the task ran (`pruneExpired` then `pruneAiSpans`); unknown cron → no-op.
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
- Uploads: `directUpload(env, cookie, target, { bytes, name, type }, fields?)`
  (`tests/helpers/uploads.ts`) runs presign → the Worker's own PUT URL (no R2 keys in tests) → confirm and answers
  the confirm (or the refusal before it); `createUploadRequest` / `putUpload` / `confirmUploadRequest`
  are the steps alone. Assert the row, the object in `stubs(env).files.objects`, and the 413/415
  envelopes (`files.test.ts`, `document-upload.test.ts`; the shared flow — mismatch, expiry,
  cross-tenant 404, prune, the key rule, write-once — is `uploads.test.ts`; a test plugin target
  declares its `permission`). A UI test stubs the three calls with
  `uploadRoutes(confirmAnswer)` and reads them back with `uploadCalls` (`tests/ui/helpers/uploads.ts`)

## What every API test file includes

- A tenant-isolation assertion for list/read endpoints (tenant B cannot see tenant A's row); for a
  cube or other query surface a plugin adds, that assertion is a case in the plugin's own isolation test
- An unauthenticated 401 and a wrong-role 403 for a protected route
- The error envelope shape `{ error, statusCode, code? }` on at least one failure path

## UI tests

`apps/web/tests/ui/setup.ts` (jest-dom). `renderWithProviders()` gives QueryClient + Auth + Ability + Router.
The `ui` project resolves with Vite's `defaultClientConditions`, as the browser bundle does: without them `react-router` loads as CommonJS and an ESM importer (`react-router-dom`, which plugins still use) gets a second copy with its own context — `router-instance.test.tsx` holds it.
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

## Evals are not tests (D33)

Quality of real model output is measured by `pnpm eval` in `apps/evals` (vitest-evals on vitest 4,
`docs/EVALS.md`), never by these suites: a test asserts behaviour with a `FakeChatClient` and must
be deterministic, and an eval scores a real model and is allowed to vary. The eval KIT's own pure
parts (scorers, transcripts, datasets, the compare) are unit-tested in `apps/evals/tests` and do
run in `pnpm test`. `tests/api/feedback.test.ts` covers the thumbs and the export (tenant-scoped,
admin+) and that `withEvalScope` tags spans.

## Commands

`pnpm test` (every package; it starts the test database itself — see above), or `pnpm gate` for the
whole pre-commit gate. The inner loop is `pnpm test <suite…> [file…]`: `api`, `ui`, `config`,
`driver` and (the kit only) `kit-only`. Each suite is its shared and isolated projects together, run
under `postgres` with the database expected up (`pnpm test:db:up`, or any earlier `pnpm test`),
and a file path or a name filter narrows it (`pnpm test api apps/web/tests/api/health.test.ts`).
`pnpm test web` is the full web plan without the other packages. The `apps/web` `test:*` scripts
(`pnpm web test:api` and the rest) are one-line aliases for these. The project lists live in
`scripts/lib/test-plan.mjs` (`SUITES`), never in a `package.json`, so a new project changes no
script. `pnpm test:coverage`. `REQUIRE_PROVISIONED=1 pnpm --filter @rocketflare/web test:config` is what CI runs
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
  three: the `config` project by glob, the ui ones through `uiTestFiles()`, and the api ones through the same `apiTestFiles()`
  walk the kit's use, so **the `// @vitest-isolate` marker decides which api project a plugin file
  lands in exactly as it does for a kit file** (first line, exact match, reason on line 2)
- **A plugin reaches the harness through `@testkit`, never a relative climb into `tests/`.** Two
  entries, split by what a test needs: `@testkit/integration` is the harness (`setupTestDatabase`,
  `request` / `json`, `createTestEnv` / `stubs`, the auth factories, `renderWithProviders`) and
  `@testkit/unit` the context builders (`makeRequestCtx`, `makeJobCtx`, `makeCronCtx`,
  `makeEmailCtx`, `makeWorkflowCtx`, `makeToolCtx`). The three background builders record every
  `ctx.startAgentRun` call in `startedRuns` (`{ input, result?, error? }`), run the REAL starter
  by default (a row on the test database, an instance on `stubs(env).workflow`) and take a
  `startAgentRun` option to answer without one. Both are re-exports, so a plugin and a kit test run the same
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
  paragraph or a commented-out `createTestTenant(db)` satisfied. All three parse
  with the TypeScript AST now (`typescript6`, never `typescript`), so neither a comment nor a
  string satisfies them, and each requires a real DECLARATION (`declaresProperty`) rather than a
  mention. The newer regex checks still run `stripComments` first; a new check should parse
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
  files resetting one key delete each other's rows across tenants. The API one adds the key in
  `beforeAll` and removes it in `afterAll`, so it can share the registry. For the same reason an
  assertion that
  pinned the exact agent-tool list is a PREFIX assertion — a plugin's tools are appended after the
  kit's three
- **A core test must not borrow an EXAMPLE agent either** (`summarize-text`, `research-topic`,
  `triage-research` — `kind: "example"` surfaces an app deletes). It uses the fixture agents in
  `tests/helpers/fixture-agents.ts` (`FIXTURE_AGENT` takes `{ text }`, `FIXTURE_AGENT_B`
  `{ topic }`), registered through the plugin seam: an api file starts with
  `// @vitest-fixture-agents` and runs in `api-fixtures`, whose setup puts them in the barrels; a
  UI test mocks the shared barrel (`withFixtureShared`), and a test storing a key as an opaque
  string needs neither. The core route and runtime tests (`agent-run-routes`, `agent-run-runtime`)
  run on the fixture agent; the example's own files test only what is the example's. A test of an example's own behaviour is listed in that surface's
  `paths`; `tests/kit-only/example-surfaces.test.ts` fails a test outside the surface that names
  the key or imports one of its files. `tests/api-setup.ts` imports `@/db/client` inside its hook
  for this reason: a static import there evaluates the barrels before the test's `vi.mock` exists
- **A fixture server plugin without a mock.** `withServerPlugins(fixtures, { replace? })`
  (`tests/helpers/server-plugins.ts`) splices fixtures into the real `serverPlugins` for one file
  and restores it after, so the file shares the `api` registry (`plugin-tools`, `mcp-plugin-tools`,
  `plugin-tenant-status-hook`, `security/chat-approval-gates`). Only consumers that read the barrel
  at CALL time see a fixture — the tool builder, the MCP listing, the tenant hooks; one read at
  module load (mounts, `API_PREFIXES`, the agent and prompt registries) still needs the mock

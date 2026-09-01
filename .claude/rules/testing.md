---
globs:
  - tests/**
  - vitest.config.ts
  - .env.test
  - docker-compose.test.yml
---

# Testing Patterns

Vitest, four projects (`vitest.config.ts`): `api` + `api-isolated` (Node, **real Postgres** on 5433),
`ui` (jsdom + Testing Library), `config` (Node, no database: wrangler parity, env schema, pure
helpers). `pnpm test` is two `vitest run` invocations (`test:shared`, `test:isolated`) because
vitest 3 resolves `isolate` per run, not per project.

## Tests run under Node, against the real Hono app

- `app.request(req, env, ctx)` with `env = createTestEnv(overrides)` from `tests/mocks/bindings.ts`:
  `DATABASE_URL` from `.env.test`, `MemoryKV` as `RATE_LIMIT_KV`, a `RecordingQueue` as
  `JOBS_QUEUE` (`.messages`), stubs for later bindings, a `HYPERDRIVE` whose `connectionString` is
  the test URL; `ctx = createExecutionContext()` collects `waitUntil` promises so a test can
  `await waitOnExecutionContext(ctx)` before asserting side effects
- `cloudflare:workers` is aliased to `tests/mocks/cloudflare-workers.ts` (stub `DurableObject`,
  `WorkflowEntrypoint`) so worker modules import under Node
- `tests/helpers/request.ts` `request()` / `json()` drive the app through every middleware with a
  per-file random client IP (rate-limit isolation); `tests/helpers/auth.ts` factories (Phase 1:
  `createTestUser`, `createTestTenantWithUser`, `createTestSession`, `createTestApiKey`) use
  `uniqueId()` suffixes
- No `@cloudflare/vitest-pool-workers` in the default suite (D15). It cannot reach a real Postgres
  through Hyperdrive locally; the value here is integration tests against real Postgres

## Database discipline

- `tests/setup.ts` (globalSetup, memoised on `globalThis` because two projects share it): roles →
  migrate → grants → **truncate once** → seed one user/tenant/API key exposed via `provide()`/`inject()`
- Tests never truncate per file. Create what you need with unique data and let it stay; the schema
  is designed for parallel files. If a test genuinely needs an empty table, it is `// @vitest-isolate`
- `tests/helpers/db.ts` `safetyCheck()` refuses to run unless `NODE_ENV=test` and `DATABASE_URL`
  is `localhost`. Never point tests at Neon
- Per-file `tests/api-setup.ts` closes clients after each file (connection budget: forks × pools)

## The `// @vitest-isolate` marker

`api` shares one module registry per worker; `api-isolated` gives each file a fresh one. If a
file uses `vi.mock`, `vi.stubGlobal`, `vi.spyOn(globalThis…)` or otherwise needs a clean process,
its FIRST line must be:

```ts
// @vitest-isolate — mocks a module, so this file needs its own module registry.
```

Forgetting it does not fail in your file; it hands the fake to whatever runs next in that worker.
`tests/api/isolation-contract.test.ts` scans for the constructs and fails with the line to paste.

## Testing background work — plain functions, no platform

- Queue consumer: call `processJobsBatch(batch, env)` with a hand-built `MessageBatch` (`messages:
  [{ body, attempts, ack(), retry() }]`); assert on DB rows and `ack`/`retry` calls
- Workflow: `AgentRunWorkflow` logic lives in exported step functions (`runTurn`, `finalize`);
  test them directly with `{ db, env }`. A `StepStub` records `step.do(name)` calls and runs the
  callback inline. Test the claim-row gate: a second call with the row already `running` is a no-op
- Cron: call `scheduled({ cron: '0 4 * * *' }, env, ctx)` and assert the task ran; unknown cron → no-op
- Producers: assert on `env.JOBS_QUEUE.messages` (RecordingQueue), and that the route did NOT do the work itself

## What every API test file includes

- A tenant-isolation assertion for list/read endpoints (tenant B cannot see tenant A's row)
- An unauthenticated 401 and a wrong-role 403 for a protected route
- The error envelope shape `{ error, statusCode, code? }` on at least one failure path

## UI tests

`tests/ui/setup.ts` (jest-dom). `renderWithProviders()` gives QueryClient + Auth + Ability + Router.
Shallow component tests; mock `fetch` where needed, no MSW. `contrast.test.ts` gates the design tokens.

## Commands

`pnpm test:db:up` once, then `pnpm test` · `pnpm test:api` · `pnpm test:ui` · `pnpm test:config` ·
`pnpm test:coverage`. `REQUIRE_PROVISIONED=1 pnpm test:config` is what CI runs before a deploy.

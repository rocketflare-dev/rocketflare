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
helpers). `pnpm test` is two `vitest run` invocations (`test:shared`, `test:isolated`) because
vitest 3 resolves `isolate` per run, not per project.

## Tests run under Node, against the real Hono app

- `app.request(req, env, ctx)` with `env = createTestEnv(overrides)` from `apps/web/tests/mocks/bindings.ts`:
  `DATABASE_URL` from `apps/web/.env.test`, `MemoryKV` as `RATE_LIMIT_KV`, a `RecordingQueue` as
  `JOBS_QUEUE` (`.messages`), stubs for later bindings, a `HYPERDRIVE` whose `connectionString` is
  the test URL; `ctx = createExecutionContext()` collects `waitUntil` promises so a test can
  `await waitOnExecutionContext(ctx)` before asserting side effects
- `cloudflare:workers` is aliased to `apps/web/tests/mocks/cloudflare-workers.ts` (stub `DurableObject`,
  `WorkflowEntrypoint`) so worker modules import under Node
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
its FIRST line must be:

```ts
// @vitest-isolate — mocks a module, so this file needs its own module registry.
```

Forgetting it does not fail in your file; it hands the fake to whatever runs next in that worker.
`apps/web/tests/api/isolation-contract.test.ts` scans for the constructs and fails with the line to paste.

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

`apps/web/tests/ui/setup.ts` (jest-dom). `renderWithProviders()` gives QueryClient + Auth + Ability + Router.
Shallow component tests; mock `fetch` where needed, no MSW. `contrast.test.ts` gates the design tokens.

## Commands

`pnpm test:db:up` once, then `pnpm test` (root: every package, `pnpm -r test`; web tests load
`apps/web/.env.test` via their own `dotenv` script, so no cwd juggling). Single projects run through
the web package: `pnpm web test:api` · `pnpm web test:ui` · `pnpm web test:config` ·
`pnpm test:coverage`. `REQUIRE_PROVISIONED=1 pnpm --filter @gmgo/web test:config` is what CI runs
before a deploy.

## CLI tests (`apps/cli/tests`)

Plain vitest, Node, no database. Test commands in-process through their exported functions with a
`CommandContext` carrying a fake `fetch`, a no-op `open`, a memory output and a temp `GMGO_CONFIG_DIR`;
never touch the real `~/.gmgo`. Assert `CliError.exitCode` and `--json` output shape (parsed with the
`@gmgo/shared` schema), never chalk-coloured text (`.claude/rules/cli.md`).

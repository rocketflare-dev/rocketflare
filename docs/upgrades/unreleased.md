---
version: unreleased
previous: 0.14.0
date: null
breaking: false
migrations: []
areas: [api, db, config, docs]
touches_surfaces: [feature-agents, feature-knowledge, example-agent-summarize-text]
requires_surfaces: []
manual: true
---

## What changed

The kit now runs on two database drivers, chosen per deployment by `DATABASE_DRIVER`: the Neon serverless driver (a fresh copy's default, no Hyperdrive) or postgres.js through Hyperdrive (any Postgres, and what an existing copy keeps).

- Why, and the rules that stay true: [`docs/CONCEPTS.md` §4 and §10](../CONCEPTS.md) (D35 replaces D2); the design record is `docs/NEON-DRIVER.md`; the operator's table and the switch are `docs/DEPLOY.md` § Database driver.
- `apps/web/src/db/client.ts`: `openDatabase(env)` is the one resolver, replacing eight hand-built `createDatabase(resolveDatabaseUrl({ HYPERDRIVE, … }))` call sites; `Database` is now drizzle's `PgDatabase` base, so a raw `db.execute()` is typed `unknown`.
- New `rows()` / `affected()` (from `@/db/client`, and `@/plugins/api` for plugins) read a raw result from either driver; `tests/config/driver-results.test.ts` fails a cast, index or `.rows`/`.count` read on one, and a driver import, anywhere in `src/`.
- `loadConfig`: `DATABASE_DRIVER` (`neon | postgres`, missing = `postgres`) and `NEON_LOCAL_PROXY`; `neon` without `DATABASE_URL` is a config error. `AppBindings` makes `HYPERDRIVE` optional.
- Scripts go through `apps/web/scripts/lib/sql.ts` (postgres.js or a Neon `Pool`, from `DATABASE_DRIVER` in the environment); `migrate.ts` uses the `neon-serverless` migrator under `neon`.
- The kit's tomls say `DATABASE_DRIVER = "neon"` and carry no `[[hyperdrive]]` block; the parity test wants the block in both tomls or neither, and none in a `neon` file.
- `pnpm provision` takes `--driver neon|postgres`: `cloudflare <env>` rewrites both tomls, `secrets`/`deploy` put the pooled Neon URI as the Worker's `DATABASE_URL` under `neon`, `--rotate` re-puts it.
- Local development stays on `postgres`: the bootstrap writes `DATABASE_DRIVER=postgres` to `.dev.vars` (a Neon `--db-url` gets `neon`; `--driver` overrides). `pnpm dev:db:up --neon|--postgres` switches, starting or stopping a local Neon proxy (`ghcr.io/rocketflare-dev/local-neon-proxy`, our digest-pinned build of a community image with `apps/web/docker/neon-proxy-start.sh` baked in, ~8 ms a query).
- Tests: a new `driver` vitest project (`tests/driver/`) runs in the gate under `postgres`; `pnpm test:neon` and CI's new `test-neon` job run it and the whole api suite under `neon`.
- Bug-shaped traps the driver test pins: raw SQL arrays arrive as `"{a,b}"` from postgres.js (use `json_agg` / `to_jsonb`), raw timestamps are a `Date` or a string by driver.
- `classifyInfrastructureError` (`utils/core/errors.ts`) recognises Neon's unreachable-database shapes (`NeonDbError.sourceError`, the WebSocket `ErrorEvent`), so an outage is a 503 `database_unavailable` under either driver; `tests/driver/unreachable.test.ts` pins it.
- The UI tests register jest-dom on apps/web's OWN vitest (`tests/ui/setup.ts` + `tests/ui/jest-dom-vitest.d.ts`) instead of `@testing-library/jest-dom/vitest`, which augmented whichever vitest pnpm hoisted — vitest 4 from apps/evals as often as not, the "flaky jest-dom matcher types" CI failure. `apps/evals` gains `@neondatabase/serverless` as a devDependency so the workspace resolves one drizzle-orm.
- `.rocketflare.json` `defaultPlugins` pins analytics at `3.4.1` (it read `3.0.0`), which reads `execute()` results in both shapes and type-checks against the driver-neutral `Database`.

## How to apply

1. If the app has the analytics plugin installed, upgrade it to 3.4.1 or later first with `pnpm plugin upgrade analytics --apply`: 3.4.0 reads raw results from both drivers, and 3.4.1 hands drizzle-cube the driver-neutral `Database` so the app still type-checks on this release.
2. Accept the kit's changes to `apps/web/src/db/client.ts`, `apps/web/src/config.ts`, `apps/web/src/api/types.ts`, `apps/web/src/plugins/api/db.ts`, `apps/web/src/plugins/api/index.ts` and the eight call sites that now call `openDatabase` (`middleware/database.ts`, `utils/routes/route-helpers.ts`, `queues/jobs.ts`, `scheduled.ts`, `workflows/agent-run.ts`, `plugins/api/workflow.ts`, `observability/span-store.ts`), then run `node scripts/plugin-api-doc.mjs` and commit `docs/plugin-api.md`.
3. Copy from the kit unchanged: `apps/web/scripts/lib/sql.ts`, `apps/web/docker/neon-proxy-start.sh` and `Dockerfile.neon-proxy` (the source of the published image; nothing mounts them), `apps/web/tests/driver/driver.test.ts`, `apps/web/tests/driver/unreachable.test.ts`, `apps/web/tests/config/driver-results.test.ts` and `apps/web/tests/ui/jest-dom-vitest.d.ts`; accept the kit's `apps/web/src/api/utils/core/errors.ts` and `apps/web/tests/ui/setup.ts`; accept the kit's `apps/web/scripts/migrate.ts`, `db-roles.ts`, `test-db-connection.ts`, `dev-db.mjs`, `provision.ts` and `provision/*`.
4. `apps/web/package.json` is a `manual` file: run `pnpm --filter <your web package> add @neondatabase/serverless@^1.1.0`, add the scripts `test:db:up:neon`, `test:neon` and `test:driver` from the kit's `apps/web/package.json`, add `--project driver` to `test:isolated`, and add `--profile neon` to `test:db:down`.
5. Root `package.json` is a `manual` file: add `"test:neon": "pnpm --filter <your web package> test:neon"`. `apps/evals/package.json` is `manual` too: run `pnpm --filter <your evals package> add -D @neondatabase/serverless@^1.1.0`, so both packages resolve the same drizzle-orm.
6. Merge the `neon-proxy-dev` service into `apps/web/docker-compose.dev.yml` and the `neon-proxy-test` service into `apps/web/docker-compose.test.yml` from the kit, keeping the image digest exactly, and write the app's own database name, user and password into each service's `PG_CONNECTION_STRING` and `PROXY_ROLE_PASSWORD`.
7. Leave `DATABASE_DRIVER = "neon"` out of the app's wrangler tomls and keep the app's `[[hyperdrive]]` block in both, because the tomls are never ported and a missing `DATABASE_DRIVER` already means `postgres`. To make the choice explicit, add `DATABASE_DRIVER = "postgres"` to `[vars]` in BOTH tomls (the parity test compares the keys).
8. `apps/web/.dev.vars.example` and `apps/web/.env.test` are never ported: add `DATABASE_DRIVER=postgres` and a blank `NEON_LOCAL_PROXY=` to `.dev.vars.example` above `DATABASE_URL`, add `DATABASE_DRIVER=postgres` above `DATABASE_URL` in `.env.test`, and add `DATABASE_DRIVER=postgres` to the developer's own `apps/web/.dev.vars` (a re-run of `pnpm bootstrap` writes it when absent).
9. Run `pnpm typecheck` and commit the regenerated `apps/web/worker-configuration.d.ts`; every `db.execute()` result the app's own code indexes or reads now fails to compile.
10. In the app's own code and tests, read each raw `db.execute()` result with `rows<T>(…)` and each unreturned insert/update/delete count with `affected(…)`, both from `@/db/client` (a plugin imports them from `@/plugins/api`); rewrite raw SQL that returns a Postgres array to `json_agg` / `to_jsonb`; then run `pnpm web test:config` until `driver-results.test.ts` passes.
11. In the app's tests, replace `vi.spyOn(dbClient, 'createDatabase')` with `vi.spyOn(dbClient, 'openDatabase')` wherever a test spied on the per-invocation client.
12. `.github/workflows/ci.yml` is a `manual` file: copy the kit's `test-neon` job into it if any environment will deploy on `neon`; a copy that deploys on `postgres` everywhere may leave the job out.
13. Switching a live deployment to `neon` is optional and never part of this upgrade: follow `docs/DEPLOY.md` § Database driver, one environment at a time, keeping the Hyperdrive configs for about a week.

## Conflicts to expect

- `apps/web/src/db/client.ts` → rewritten around `openDatabase` → take the kit's file, then re-apply any option the app added to the postgres.js client inside `createDatabase`.
- `apps/web/scripts/migrate.ts` / `db-roles.ts` → now over `scripts/lib/sql.ts` → take the kit's; a statement the app added to `db-roles.ts` becomes one more `[label, sql]` entry.
- `apps/web/docker-compose.dev.yml` / `docker-compose.test.yml` → a new profile-gated service → keep the app's renamed container, database and credentials everywhere, including the new service's environment.
- `apps/web/tests/mocks/bindings.ts` → `HYPERDRIVE` only under `postgres`, plus `DATABASE_DRIVER` → keep the app's own bindings beside the change.
- `scripts/bootstrap.mjs` / `scripts/lib/bootstrap-lib.mjs` → `--driver` and the step-3 driver write → keep the app's own steps.
- `apps/web/scripts/provision.ts` → driver-aware `cloudflare`, `secrets`, `deploy` and `--rotate` → take the kit's; re-apply a phase the app added.

## Verify

1. `pnpm typecheck` passes and `git diff --exit-code apps/web/worker-configuration.d.ts` is clean.
2. `pnpm web test:config` passes, including `driver-results.test.ts` and `wrangler-parity.test.ts`.
3. `pnpm test` passes, and its output lists the `|driver|` project.
4. `pnpm test:neon` passes (it starts the test proxy on :4433 itself).
5. `grep -n 'DATABASE_DRIVER\|\[\[hyperdrive\]\]' apps/web/wrangler.toml apps/web/wrangler.staging.toml` shows `postgres` or no driver line, and a `[[hyperdrive]]` block in both files.
6. `pnpm db:check` prints `Connected to … (postgres driver)`.
7. `pnpm dev:db:up --neon && pnpm db:check` prints `(neon driver)`, and `pnpm dev:db:up --postgres` switches back.
8. After the next deploy, `/api/ready` answers ok in each environment.

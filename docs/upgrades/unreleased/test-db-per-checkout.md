---
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Each checkout now runs its tests on its own database in the shared test Postgres, named from its path, so two worktrees' runs no longer truncate each other's tables or see each other's plugin tables.

- `scripts/lib/test-db.mjs` (new, with `test-db.d.mts`): the per-checkout name `<.env.test's database>_<8 hex of SHA-256 over the checkout's real path>`, the URL rewrite (local URLs naming `.env.test`'s database only; a remote target and any other database are left alone), the `COMMENT ON DATABASE` label and the prune plan.
- `apps/web/vitest.config.ts` calls `applyCheckoutDatabase(process.env)` before anything connects, so `DATABASE_URL` and `APP_DATABASE_URL` name this checkout's database in every vitest run.
- `apps/web/tests/helpers/db.ts` gains `ensureTestDatabase()`, which `tests/setup.ts` and `apps/evals/global-setup.ts` call first: it creates the database over TCP if missing and labels it with the checkout path; role → migrate → grants follow as before.
- `pnpm test:db:prune [--dry-run]` (`apps/web/scripts/test-db-prune.ts`) lists the labelled databases and drops the ones whose checkout path no longer exists.
- `pnpm eval` uses the same per-checkout database; `pnpm test` prints the database it chose, and no longer creates `.env.test`'s database itself when it reuses another checkout's servers.
- `tests/api/test-database.test.ts` (new) asserts the suite runs on the checkout's own, labelled database.

## How to apply

- Take `scripts/lib/test-db.mjs`, `scripts/lib/test-db.d.mts`, `apps/web/scripts/test-db-prune.ts` and `apps/web/tests/api/test-database.test.ts` as they are.
- In `apps/web/vitest.config.ts`, import `applyCheckoutDatabase` from `../../scripts/lib/test-db.mjs` and call `applyCheckoutDatabase(process.env)` at module level, before the config is defined.
- Take the kit's `ensureTestDatabase()` into `apps/web/tests/helpers/db.ts`, and call `await ensureTestDatabase()` right after `safetyCheck()` in `apps/web/tests/setup.ts` and at the top of `setup()` in `apps/evals/global-setup.ts`.
- In `apps/evals/scripts/eval.mjs`, import `applyCheckoutDatabase` from `../../../scripts/lib/test-db.mjs` and call `applyCheckoutDatabase(env)` after the loop copying `process.env` into `env`.
- Add `"test:db:prune": "tsx scripts/test-db-prune.ts"` to `apps/web/package.json` and `"test:db:prune": "pnpm --filter <scope>/web test:db:prune"` to the root `package.json`.
- Take the kit's `scripts/test.mjs` and `scripts/lib/gate-changed.mjs`, if you have not changed them; otherwise add the `test database:` line after the banner and `'scripts/lib/test-db.*'` to the full-run paths by hand.
- Replace any test of your own that names `.env.test`'s database literally with one that reads `process.env.DATABASE_URL`.

## Conflicts to expect

None.

## Verify

- `pnpm test api` prints `· test database: <app>_test_<8 hex>` and passes, including `tests/api/test-database.test.ts`.
- `pnpm test:db:prune --dry-run` lists that database as `keep … (this checkout)`.
- `pnpm gate` passes.

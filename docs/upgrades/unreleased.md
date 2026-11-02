---
version: unreleased
previous: 0.24.0
date: null
breaking: false
migrations: []
areas: [cli, config, scripts, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

`apps/web` and `apps/cli` test on vitest 5, whose jsdom environment replaces Node 25+'s built-in `localStorage`, so the UI suite passes on Node 26 as well as Node 24.

- `apps/web` (`vitest`, `@vitest/coverage-v8`) and `apps/cli` (`vitest`) move from `^3.2.7` to `^5.0.5`. On Node 25+ a stub `localStorage` global shadowed jsdom's and failed every UI test that touched storage; vitest 5's jsdom environment overrides it (3.x and 4.x have no backport). `apps/evals` stays on vitest 4, which `vitest-evals` requires.
- `apps/web/vitest.config.ts`: `poolOptions.forks.{maxForks,minForks}` becomes top-level `maxWorkers` (vitest 4 removed `poolOptions`; the `minForks` pin worked around a vitest 3 bug fixed in 4), and `coverage.all` is gone (removed in vitest 4; `coverage.include` now reports uncovered files on its own).
- Comments and docs that named vitest 3 now name vitest 5 (`docs/EVALS.md`, `docs/CONCEPTS.md` §9, `.claude/rules/testing.md`, `apps/evals/vitest.config.ts`, `apps/web/tests/ui/{setup.ts,jest-dom-vitest.d.ts}`, `scripts/lib/test-plan.mjs`).

## How to apply

1. Run `pnpm --filter @rocketflare/web add -D vitest@^5.0.5 @vitest/coverage-v8@^5.0.5` and `pnpm --filter @rocketflare/cli add -D vitest@^5.0.5`, substituting your renamed package scope for `@rocketflare`. Leave `apps/evals` on vitest 4.
2. In `apps/web/vitest.config.ts`, replace the `poolOptions: { forks: { maxForks, minForks } }` block with a top-level `maxWorkers: MAX_WORKERS`, and delete `all: true` from `coverage`.
3. Run your own test files on vitest 5 and fix what its behaviour changes break: `clearMocks` defaults to `true` (a mock's call history is cleared before every test), an unawaited `expect(...).resolves`/`.rejects` fails the test, and `-t` matches the `>`-joined full test name. The kit's own suites needed no change.

## Conflicts to expect

- `apps/web/package.json`, `apps/cli/package.json`, `pnpm-lock.yaml` → vitest versions changed → apply step 1 instead of the hunks.
- `apps/web/vitest.config.ts` → pool and coverage options changed → apply step 2 by hand if you edited the file.

## Verify

1. `pnpm gate` passes on Node 24.
2. `pnpm web test:ui` passes on Node 26.
3. `pnpm --filter @rocketflare/web exec vitest --version` prints `vitest/5.`.

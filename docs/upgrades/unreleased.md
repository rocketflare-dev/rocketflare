---
version: unreleased
previous: 0.38.0
date: null
breaking: false
migrations: []
areas: [api, shared, tooling, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

`pnpm lint` now fails on a Biome warning as well as an error, and the 29 warnings and 3 infos that `--diagnostic-level=error` had hidden are fixed.

- Both `lint` scripts (root and `apps/web`) run `biome check . --error-on-warnings`; `GATE_STEPS` displays the same command, and `.claude/rules/code-quality.md` says a warning fails the step.
- Nine `biome-ignore lint/suspicious/noExplicitAny` comments in `apps/web/tests/` are removed: `biome.json` already turns that rule off there.
- Optional chains replace `!x || x.y !== …` (agent loop, runs, ingest, AG-UI, plugin-lib), and statements replace two comma operators.
- `createInvitation` and `resendInvitation` keep the `(db, cfg, logger, …)` service signature with an unused `_logger`; `requireClean` in `scripts/plugin.mjs` drops its unused `host`.
- `RunToolLoopOptions.beforeTurn` returns `Promise<ChatMessage[] | undefined>`, not `void` in a union.
- `globToRegExp` tests its escape set with a regex character class; `chunking.ts` uses `Math.min`; three template literals replace string concatenation; tests drop `!` assertions.
- The gate's test output carries no warnings: the unreadable-API `gatedDecision` test asserts its two `::warning::` lines (and its `runs()` helper now keeps `null`), and the UI setup stubs `window.scrollTo`, which jsdom lacks.

## How to apply

1. In the root `package.json` and `apps/web/package.json`, change the `lint` script from `biome check . --diagnostic-level=error` to `biome check . --error-on-warnings`.
2. In `scripts/lib/gate-lib.mjs`, change the `lint` step's `display` to `biome check . --error-on-warnings`.
3. In `.claude/rules/code-quality.md`, replace "`pnpm lint` (errors only)" with "`pnpm lint` (a warning fails it, as an error does)".
4. Port the kit diff's code edits from the release; every one is local to the line Biome names.
5. Run `pnpm exec biome check .` and fix each warning it still reports in your own code: an app's own code can carry warnings the kit never had.
6. Port `apps/web/tests/config/ci-workflows.test.ts` (the `runs()` helper and the unreadable-API case) and the `window.scrollTo` stub in `apps/web/tests/ui/setup.ts` from the release.

## Conflicts to expect

- `apps/web/src/api/services/invitations.ts` → the unused `logger` became `_logger` → keep yours if your copy uses the logger there.
- Any line your copy changed near a Biome warning → the kit rewrote that line → keep your change and fix the warning by hand.

## Verify

1. `pnpm exec biome check .` reports no warnings and no infos.
2. `pnpm gate` passes, and its lint step prints `biome check . --error-on-warnings`.
3. `pnpm test` prints no `::warning::` line and no `Not implemented: Window's scrollTo()` line.

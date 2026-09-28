---
version: unreleased
previous: 0.15.2
date: null
breaking: false
migrations: []
areas: [api, config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A copy's CI no longer re-runs its gate with default plugins (which failed on every copy with plugins installed), deploys skip the gate for an already-green commit, and the neon test run stops timing out.

- `.github/workflows/ci.yml`: `default-plugins` and `plugins` run only when `github.repository == 'rocketflare-dev/rocketflare'`, like `renamed`; in a copy `pnpm plugin add` stopped at "already installed" (exit 7), so every deploy of a Launch-made app was red.
- `.github/workflows/ci.yml` takes a `deploy` boolean `workflow_call` input; with it set `test-neon` is skipped. Pull request and push runs are unchanged.
- `.github/workflows/deploy.yml`: a new `gated` job asks the Actions API whether `github.sha` has a successful `CI` run from a push or pull request, and `ci` is skipped when it has; a run still in progress does not count ([`docs/DEPLOY.md` CI/CD flow](../DEPLOY.md)).
- `.github/workflows/deploy.yml`: `staging` needs `[guard, gated, ci]` and deploys after a passing `ci`, or a `ci` skipped because `gated` found a green run, never after a failed one.
- `apps/web/src/api/scheduled.ts`: `runPruneAiSpans` is one DELETE across every tenant instead of one per tenant, so the nightly cron costs one round trip, not `tenants / 10`, under the `neon` driver.
- `apps/web/vitest.config.ts`: `testTimeout` is 20 s when `DATABASE_DRIVER=neon` (every query an HTTP request through the local proxy) and stays 5 s for the `postgres` gate.
- `apps/web/tests/config/ci-workflows.test.ts` pins the kit-only guards, the `deploy` input, the `staging` condition, and runs the `gated` step against a stub `gh`.

## How to apply

1. In `.github/workflows/ci.yml`, add `if: github.repository == 'rocketflare-dev/rocketflare'` to the `default-plugins` job, and prefix the `plugins` job's `if:` with `github.repository == 'rocketflare-dev/rocketflare' && `. The literal must read `rocketflare-dev/rocketflare` exactly; a copy renamed at 0.15.0 or earlier may carry a rewritten one (see the 0.15.2 note, step 2).
2. In `.github/workflows/ci.yml`, replace the bare `workflow_call:` trigger with the kit's version declaring `inputs.deploy` (`type: boolean`, `default: false`), and add `if: ${{ !inputs.deploy }}` to the `test-neon` job.
3. Accept the kit's `.github/workflows/deploy.yml` `gated`, `ci` and `staging` jobs unchanged (the `ci` job now `needs: gated` and passes `with: deploy: true`); keep any step the app added inside `staging` below the job's new `needs:` and `if:`.
4. Accept the kit's `apps/web/src/api/scheduled.ts` `runPruneAiSpans` (one `db.delete(aiSpans).where(lt(aiSpans.startedAt, cutoff))`) and drop the now-unused `and`, `eq` and `tenants` imports; add the kit's `'src/api/scheduled.ts'` entry to `CORE_UNSCOPED_ALLOWLIST` in `apps/web/tests/config/unscoped-allowlist.test.ts`, since the single DELETE names no tenant.
5. In `apps/web/vitest.config.ts`, add `testTimeout: process.env.DATABASE_DRIVER === 'neon' ? 20_000 : 5_000,` beside `teardownTimeout`.
6. Accept the kit's `apps/web/tests/config/ci-workflows.test.ts`.

## Conflicts to expect

- `.github/workflows/deploy.yml` → `staging`'s `needs`/`if` rewritten and a `gated` job added → keep the kit's expressions; an app that deletes `test-neon` or renames a job keeps the `staging` clause `needs.ci.result == 'success' || (needs.ci.result == 'skipped' && needs.gated.outputs.gated == 'true')` intact.
- `.github/workflows/ci.yml` → header comment and three job guards changed → keep the app's own jobs, and the kit's guards.

## Verify

1. `pnpm web exec vitest run --project config tests/config/ci-workflows.test.ts` passes.
2. `grep -n "github.repository == 'rocketflare-dev/rocketflare'" .github/workflows/ci.yml` lists `renamed`, `default-plugins` and `plugins`.
3. On GitHub, a push to main shows `Default plugins` and `Gate with default plugins` as skipped, and `Gate`, `Tests under the neon driver` and `Plugins are well formed` as run.
4. Dispatching Deploy → staging on that commit after its CI run is green shows `Already gated?` succeed, `ci` skipped and `Deploy to staging` run.
5. `pnpm web test:neon` passes, including `tests/api/scheduled-prune.test.ts` and `tests/api/rate-limit.test.ts`.

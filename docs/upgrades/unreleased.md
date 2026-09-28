---
version: unreleased
previous: 0.15.3
date: null
breaking: false
migrations: []
areas: [config]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

An app's staging and production deploys check wrangler parity with the parity test alone, so the depth-1 deploy checkout no longer fails the whole config project on tests that read git history.

- `deploy.yml`: both "Wrangler parity (provisioned)" steps run `test:config tests/config/wrangler-parity.test.ts` instead of the whole `config` project.
- `ci-workflows.test.ts` asserts it for both deploy jobs.

## How to apply

1. In `.github/workflows/deploy.yml`, in the `staging` job's "Wrangler parity (provisioned)" step, change `run: pnpm --filter @<slug>/web test:config` to `run: pnpm --filter @<slug>/web test:config tests/config/wrangler-parity.test.ts`.
2. In `.github/workflows/deploy.yml`, make the same change in the `production` job's "Wrangler parity (provisioned)" step.
3. Copy `apps/web/tests/config/ci-workflows.test.ts` from the kit if the copy has it; otherwise skip this step.

## Conflicts to expect

- `.github/workflows/deploy.yml` → the parity step's `run:` line gained a test path → keep any other edits to the step and add the path.

## Verify

1. `grep -c "test:config tests/config/wrangler-parity.test.ts" .github/workflows/deploy.yml` prints `2`.
2. `pnpm web test:config` passes.

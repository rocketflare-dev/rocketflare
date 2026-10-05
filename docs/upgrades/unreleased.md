---
version: unreleased
previous: 0.16.3
date: null
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

deploy.yml's `gated` job also skips the re-gate when the tagged commit is a version-only bump of the root `package.json` over a parent whose `CI` run already passed, checked by the new `release-check.mjs --version-only <parent>`.

- `scripts/release-check.mjs` (+ `release-check.d.mts`): `--version-only <parent>` exits 0 only when HEAD has exactly one parent, that parent, and the diff touches only the root `package.json` top-level `"version"`, byte for byte. A reformat, any other key or file, an empty diff or a merge fails with what else changed.
- `scripts/release-check.mjs`: `--gated <sha>` (`gatedDecision`, `successfulCiRuns`, `versionOnly`): the `gated` job's decision, moved out of inline shell. It runs in a copy too, like `--deployable`.
- `.github/workflows/deploy.yml` `gated`: checks out with `fetch-depth: 2` and runs `node scripts/release-check.mjs --gated "$GITHUB_SHA"`. `guard`, `ci`, `staging` and `production` are unchanged.
- `apps/web/tests/config/release-version-only.test.ts` (new) and `apps/web/tests/config/ci-workflows.test.ts`: the version-only cases, the three `gated` outcomes against a fake API, and the CLI against a stub `gh` and a scratch repository.
- Why: Launch's `release: X.Y.Z` commit changes only the version, and its own CI is still running (or `[skip ci]`) when the tag deploys, so the whole gate ran twice for one tree (`docs/DEPLOY.md`, "A version-only bump rides its parent's run").
- Outside Launch nothing is lost: a person's own bump commit still gets its CI run, and the new rule still requires a completed, successful run on the parent's exact sha.
- `[skip ci]` caveat: GitHub suppresses EVERY `push`-triggered workflow whose head commit carries `[skip ci]`, tag pushes included. A tag pushed on a `[skip ci]` commit therefore never starts deploy.yml. Dispatch deploy.yml on the tag ref instead (`gh workflow run deploy.yml --ref X.Y.Z -f environment=staging`); `gated` applies the same rule there.

## How to apply

1. Apply the patch to `scripts/release-check.mjs`, `scripts/release-check.d.mts` and `.github/workflows/deploy.yml`. In `deploy.yml`, only the `gated` job's `steps:` change: an `actions/checkout@v4` with `fetch-depth: 2`, then the `check` step's `run:` becomes `node scripts/release-check.mjs --gated "$GITHUB_SHA"` (keep `GH_TOKEN: ${{ github.token }}` and `permissions: actions: read`).
2. Add `apps/web/tests/config/release-version-only.test.ts` and port the `ci-workflows.test.ts` hunks: the "deploy.yml gated step" shell tests are replaced by `gatedDecision`, `successfulCiRuns` and a `for real` block.
3. If the copy's releases are cut by Launch with a `[skip ci]` bump commit, deploy staging by dispatching `deploy.yml` on the tag ref (`gh workflow run deploy.yml --ref X.Y.Z -f environment=staging`). A tag push on that commit is ignored by GitHub.

## Conflicts to expect

`.github/workflows/deploy.yml` → the `gated` job's inline `gh api … --jq` shell is gone → take the kit's `steps:` whole; a copy that edited that shell re-applies its change in `gatedDecision`.
`apps/web/tests/config/ci-workflows.test.ts` → the "deploy.yml gated step" describe is replaced → take the kit's version.

## Verify

1. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/release-version-only.test.ts tests/config/ci-workflows.test.ts` passes.
2. On a commit that bumps only the root version, `node scripts/release-check.mjs --version-only HEAD^` exits 0; on any other commit it exits 1 and names what else changed.
3. `grep -n 'fetch-depth: 2' .github/workflows/deploy.yml` finds the `gated` job's checkout.

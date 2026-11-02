---
version: unreleased
previous: 0.24.0
date: null
breaking: false
migrations: []
areas: [ci, config]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

Every GitHub Action the workflows use is on its current major, pinned to a full commit SHA, and every checkout drops its token from the git config.

- `actions/checkout` v4 → v7.0.1, `actions/setup-node` v4 → v7.1.0, `pnpm/action-setup` v4 → v6.1.0, `actions/upload-artifact` v4 → v7.0.2, `actions/download-artifact` v4 → v8.0.2, each written as `owner/repo@<sha> # vX.Y.Z`. None of the majors changes an input the workflows use: artifacts are downloaded by name, uploads stay zipped, and `setup-node` keeps its explicit `cache: pnpm`.
- Every `actions/checkout` sets `persist-credentials: false`, so a later step (an artifact upload) cannot publish the `GITHUB_TOKEN` left in `.git/config`. No step pushes or fetches with that token.
- `apps/web/tests/config/ci-workflows.test.ts` asserts the action and its inputs, not the `@v4` tag.

## How to apply

1. In `.github/workflows/ci.yml`, `deploy.yml` and `evals.yml`, replace each `actions/checkout@v4` with `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`.
2. In the same three files, replace each `actions/setup-node@v4` with `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`.
3. In the same three files, replace each `pnpm/action-setup@v4` with `pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0`.
4. In `.github/workflows/deploy.yml` and `evals.yml`, replace each `actions/upload-artifact@v4` with `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2`.
5. In `.github/workflows/deploy.yml`, replace `actions/download-artifact@v4` with `actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2`.
6. Under every `actions/checkout` step in `.github/workflows/`, add `persist-credentials: false` to its `with:` block (create the block where the step has none), unless one of your own later steps pushes with the checkout's token.
7. If your `apps/web/tests/config/ci-workflows.test.ts` still matches `actions/checkout@v4` or `actions/download-artifact@v4` literally, match `actions\/checkout@\S+` and `actions\/download-artifact@\S+` instead.

## Conflicts to expect

- `.github/workflows/**` → `manual`; the patch is not applied → follow steps 1–6 by hand.
- `apps/web/tests/config/ci-workflows.test.ts` → three version assertions loosened → keep your edits and apply step 7.

## Verify

1. `grep -rnE 'uses: [^@]+@v[0-9]' .github/workflows` prints nothing.
2. `grep -c 'persist-credentials: false' .github/workflows/*.yml` matches the number of `actions/checkout` steps in each file.
3. `pnpm web test:config` passes.

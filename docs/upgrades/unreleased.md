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

CI and deploy stop re-gating an already-gated tree: with `LAUNCH_GATE_APP_ID` set, `ci.yml` reuses Launch's `launch/gate` attestation (gitleaks and `pnpm gate build` only), and a version-only release bump rides its parent's green CI.

- `.github/workflows/ci.yml`: a new first job `verified` (job-level `if: vars.LAUNCH_GATE_APP_ID != ''`, `permissions: contents/checks/pull-requests: read`) runs `node scripts/gate-verified.mjs`; `Gate` gets `needs: verified`, `if: ${{ !cancelled() }}`, a `scope` step that re-reads `HEAD^{tree}`, and runs `pnpm gate build` when reused, otherwise `pnpm gate`.
- Decision rule: on `pull_request` the checked-out MERGE commit's tree must equal a tree Launch attested on the PR head (true only while the branch contains main's tip); on `push` to main the pushed commit's tree, attested on the commit or on the head of a PR from `GET /commits/{sha}/pulls`; any other event, or any API error, is the full gate.
- Trust: only a check run named `launch/gate`, `completed`/`success`, `external_id: tree:<tree>`, whose `app.id` equals `LAUNCH_GATE_APP_ID` (and whose `output.text` JSON `tree`, when present, agrees).
- `scripts/gate-verified.mjs` (new) and `scripts/lib/gate-verified-lib.mjs` + `.d.mts` (new): `planLookup`, `isAttestation`, `findVerified`, `githubApi`.
- `.github/workflows/deploy.yml`: the `ci` job grants `contents`, `checks` and `pull-requests: read`, because a called workflow cannot ask for more than its caller grants.
- `apps/web/tests/config/gate-verified.test.ts` (new) and `apps/web/tests/config/ci-workflows.test.ts`: the rule and the workflow shape.
- Docs: `docs/CONCEPTS.md` §4 "Verified once" and §10, `docs/DEPLOY.md` § CI/CD flow.
- `scripts/release-check.mjs` (+ `release-check.d.mts`): `--version-only <parent>` exits 0 only when HEAD has exactly one parent, that parent, and the diff touches only the root `package.json` top-level `"version"`, byte for byte. A reformat, any other key or file, an empty diff or a merge fails with what else changed.
- `scripts/release-check.mjs`: `--gated <sha>` (`gatedDecision`, `successfulCiRuns`, `versionOnly`): the `gated` job's decision, moved out of inline shell. It runs in a copy too, like `--deployable`.
- `.github/workflows/deploy.yml` `gated`: checks out with `fetch-depth: 2` and runs `node scripts/release-check.mjs --gated "$GITHUB_SHA"`. `guard`, `ci`, `staging` and `production` are unchanged.
- `apps/web/tests/config/release-version-only.test.ts` (new) and `apps/web/tests/config/ci-workflows.test.ts`: the version-only cases, the three `gated` outcomes against a fake API, and the CLI against a stub `gh` and a scratch repository.
- Why: Launch's `release: X.Y.Z` commit changes only the version, and its own CI is still running when the tag deploys, so the whole gate ran twice for one tree (`docs/DEPLOY.md`, "A version-only bump rides its parent's run").
- Outside Launch nothing is lost: a person's own bump commit still gets its CI run, and the new rule still requires a completed, successful run on the parent's exact sha.
- `[skip ci]` caveat: GitHub suppresses EVERY `push`-triggered workflow whose head commit carries `[skip ci]`, tag pushes included. A tag pushed on a `[skip ci]` commit therefore never starts deploy.yml. Dispatch deploy.yml on the tag ref instead (`gh workflow run deploy.yml --ref X.Y.Z -f environment=staging`); `gated` applies the same rule there.

## How to apply

1. Copy `scripts/gate-verified.mjs`, `scripts/lib/gate-verified-lib.mjs` and `scripts/lib/gate-verified-lib.d.mts` from the kit unchanged; they name nothing of the app.
2. In `.github/workflows/ci.yml` (a `manual` file, so `pnpm kit:upgrade` does not write it), add the kit's `verified` job above `gate:`, then in the `gate` job add `needs: verified` and `if: ${{ !cancelled() }}`, the `Decide the gate's scope` step right after `actions/checkout`, `if: steps.scope.outputs.reuse != 'true'` on the pre-pull step, and replace the final `- run: pnpm gate` with the kit's two conditional steps (`pnpm gate build` when `reuse == 'true'`, `pnpm gate` otherwise). A copy whose `ci.yml` has diverged keeps its own steps and adds only those pieces.
3. In `.github/workflows/deploy.yml` (also `manual`), give the `ci` job (the one with `uses: ./.github/workflows/ci.yml`) a `permissions:` block of `contents: read`, `checks: read` and `pull-requests: read`; without the block a tag or staging-dispatch deploy fails to start once `ci.yml` declares the `verified` job.
4. Copy `apps/web/tests/config/gate-verified.test.ts` and port the `ci.yml` / `deploy.yml` assertions in `apps/web/tests/config/ci-workflows.test.ts` from the kit.
5. To opt in (an app shipped by Launch), set the repository variable `LAUNCH_GATE_APP_ID` to Launch's GitHub App id; leave the variable unset to keep the full gate on every run. `Gate` stays the required status check under the same name either way.
6. Apply the patch to `scripts/release-check.mjs`, `scripts/release-check.d.mts` and `.github/workflows/deploy.yml`. In `deploy.yml`, only the `gated` job's `steps:` change: an `actions/checkout@v4` with `fetch-depth: 2`, then the `check` step's `run:` becomes `node scripts/release-check.mjs --gated "$GITHUB_SHA"` (keep `GH_TOKEN: ${{ github.token }}` and `permissions: actions: read`).
7. Add `apps/web/tests/config/release-version-only.test.ts` and port the `ci-workflows.test.ts` hunks: the "deploy.yml gated step" shell tests are replaced by `gatedDecision`, `successfulCiRuns` and a `for real` block.
8. Do not put `[skip ci]` on a release bump commit: GitHub then also skips the tag push's `deploy.yml`. If one already carries it, dispatch `deploy.yml` on the tag ref instead (`gh workflow run deploy.yml --ref X.Y.Z -f environment=staging`); `gated` applies the same rule there.

## Conflicts to expect

- `.github/workflows/ci.yml` → new `verified` job, `Gate` gains `needs`/`if`/scope step → apply by hand per step 2.
- `.github/workflows/deploy.yml` → `ci` job gains `permissions:` → apply by hand per step 3.
- `apps/web/tests/config/ci-workflows.test.ts` → the gate job's `if` is now `!cancelled()` and `pnpm gate build` is allowed → take the kit's version, then re-apply any assertion of your own.
- `.github/workflows/deploy.yml` → the `gated` job's inline `gh api … --jq` shell is gone → take the kit's `steps:` whole; a copy that edited that shell re-applies its change in `gatedDecision`.
- `apps/web/tests/config/ci-workflows.test.ts` → the "deploy.yml gated step" describe is replaced → take the kit's version.

## Verify

1. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/gate-verified.test.ts tests/config/ci-workflows.test.ts` passes.
2. With `LAUNCH_GATE_APP_ID` unset, a pull request's checks show `Verified by Launch?` skipped and `Gate` running `pnpm gate`.
3. `LAUNCH_GATE_APP_ID= GITHUB_EVENT_NAME=pull_request node scripts/gate-verified.mjs` prints `· not verified: LAUNCH_GATE_APP_ID is not set` and exits 0.
4. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/release-version-only.test.ts tests/config/ci-workflows.test.ts` passes.
5. On a commit that bumps only the root version, `node scripts/release-check.mjs --version-only HEAD^` exits 0; on any other commit it exits 1 and names what else changed.
6. `grep -n 'fetch-depth: 2' .github/workflows/deploy.yml` finds the `gated` job's checkout.

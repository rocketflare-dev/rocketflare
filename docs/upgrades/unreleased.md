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

With the repository variable `LAUNCH_GATE_APP_ID` set, `ci.yml` reuses Launch's `launch/gate` attestation of the exact tree under test and runs only gitleaks and `pnpm gate build`; unset, CI is unchanged.

- `.github/workflows/ci.yml`: a new first job `verified` (job-level `if: vars.LAUNCH_GATE_APP_ID != ''`, `permissions: contents/checks/pull-requests: read`) runs `node scripts/gate-verified.mjs`; `Gate` gets `needs: verified`, `if: ${{ !cancelled() }}`, a `scope` step that re-reads `HEAD^{tree}`, and runs `pnpm gate build` when reused, otherwise `pnpm gate`.
- Decision rule: on `pull_request` the checked-out MERGE commit's tree must equal a tree Launch attested on the PR head (true only while the branch contains main's tip); on `push` to main the pushed commit's tree, attested on the commit or on the head of a PR from `GET /commits/{sha}/pulls`; any other event, or any API error, is the full gate.
- Trust: only a check run named `launch/gate`, `completed`/`success`, `external_id: tree:<tree>`, whose `app.id` equals `LAUNCH_GATE_APP_ID` (and whose `output.text` JSON `tree`, when present, agrees).
- `scripts/gate-verified.mjs` (new) and `scripts/lib/gate-verified-lib.mjs` + `.d.mts` (new): `planLookup`, `isAttestation`, `findVerified`, `githubApi`.
- `.github/workflows/deploy.yml`: the `ci` job grants `contents`, `checks` and `pull-requests: read`, because a called workflow cannot ask for more than its caller grants.
- `apps/web/tests/config/gate-verified.test.ts` (new) and `apps/web/tests/config/ci-workflows.test.ts`: the rule and the workflow shape.
- Docs: `docs/CONCEPTS.md` §4 "Verified once" and §10, `docs/DEPLOY.md` § CI/CD flow.

## How to apply

1. Copy `scripts/gate-verified.mjs`, `scripts/lib/gate-verified-lib.mjs` and `scripts/lib/gate-verified-lib.d.mts` from the kit unchanged; they name nothing of the app.
2. In `.github/workflows/ci.yml` (a `manual` file, so `pnpm kit:upgrade` does not write it), add the kit's `verified` job above `gate:`, then in the `gate` job add `needs: verified` and `if: ${{ !cancelled() }}`, the `Decide the gate's scope` step right after `actions/checkout`, `if: steps.scope.outputs.reuse != 'true'` on the pre-pull step, and replace the final `- run: pnpm gate` with the kit's two conditional steps (`pnpm gate build` when `reuse == 'true'`, `pnpm gate` otherwise). A copy whose `ci.yml` has diverged keeps its own steps and adds only those pieces.
3. In `.github/workflows/deploy.yml` (also `manual`), give the `ci` job (the one with `uses: ./.github/workflows/ci.yml`) a `permissions:` block of `contents: read`, `checks: read` and `pull-requests: read`; without the block a tag or staging-dispatch deploy fails to start once `ci.yml` declares the `verified` job.
4. Copy `apps/web/tests/config/gate-verified.test.ts` and port the `ci.yml` / `deploy.yml` assertions in `apps/web/tests/config/ci-workflows.test.ts` from the kit.
5. To opt in (an app shipped by Launch), set the repository variable `LAUNCH_GATE_APP_ID` to Launch's GitHub App id; leave the variable unset to keep the full gate on every run. `Gate` stays the required status check under the same name either way.

## Conflicts to expect

- `.github/workflows/ci.yml` → new `verified` job, `Gate` gains `needs`/`if`/scope step → apply by hand per step 2.
- `.github/workflows/deploy.yml` → `ci` job gains `permissions:` → apply by hand per step 3.
- `apps/web/tests/config/ci-workflows.test.ts` → the gate job's `if` is now `!cancelled()` and `pnpm gate build` is allowed → take the kit's version, then re-apply any assertion of your own.

## Verify

1. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/gate-verified.test.ts tests/config/ci-workflows.test.ts` passes.
2. With `LAUNCH_GATE_APP_ID` unset, a pull request's checks show `Verified by Launch?` skipped and `Gate` running `pnpm gate`.
3. `LAUNCH_GATE_APP_ID= GITHUB_EVENT_NAME=pull_request node scripts/gate-verified.mjs` prints `· not verified: LAUNCH_GATE_APP_ID is not set` and exits 0.

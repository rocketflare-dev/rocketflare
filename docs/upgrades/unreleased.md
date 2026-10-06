---
version: unreleased
previous: 0.17.1
date: null
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

CI waits for one runner, not two: the Launch attestation lookup becomes `Gate`'s first step. A failed bundle attach no longer turns a live staging deploy red, old bundle drafts are pruned, and `plugin upgrade` removes only packages a plugin added.

- `.github/workflows/ci.yml`: the `verified` job is gone. Its lookup is now `Gate`'s first step, "Verified by Launch?" (`id: verified`, `if: vars.LAUNCH_GATE_APP_ID != ''`, `node scripts/gate-verified.mjs`).
- `Gate` loses `needs:` and its job-level `if:`, and gains `permissions: contents/checks/pull-requests: read`. The `scope` step, which re-read the tree across jobs, is dropped. The conditions read `steps.verified.outputs.verified`; the decision rule (`scripts/lib/gate-verified-lib.mjs`) is unchanged.
- The required check is still named `Gate`. There is no longer a "Verified by Launch?" check run to wait for.
- `.github/workflows/deploy.yml` `release-bundle`: download and attach are `continue-on-error`. If the attach does not succeed, a `::warning title=Build once::` and a step-summary line replace the red run. The job no longer fails after staging is live.
- `release-bundle` gains a `node scripts/bundle.mjs prune` step (`BUNDLE_KEEP_DRAFTS: ${{ vars.BUNDLE_KEEP_DRAFTS }}`), which is also non-fatal.
- `scripts/bundle.mjs prune` (new) plus `scripts/lib/bundle-lib.mjs` `pruneDraftsPlan`, `isBundleDraft` and `DEFAULT_KEEP_DRAFTS` (5). It deletes bundle drafts older than the newest N, for tags at or below the one deployed. It only deletes a draft whose single asset is its own `launch-bundle-<tag>.tgz`. `0` turns pruning off.
- `scripts/lib/plugin-lib.mjs`: `dependencyDelta` gains `addedByPlugins` and removes a dropped dependency only when some plugin's record says a plugin added it. Also new: `newlyAddedDependencies`, `nextAddedDependencies`, `addedByPlugins`, and an `addedDependencies` option on `buildPluginSurface`.
- `scripts/plugin.mjs`: `add --apply` records `addedDependencies` on the surface: the packages the host did not declare at all. `upgrade --apply` updates the record, even when rejects remain.
- A surface with no record, meaning a plugin installed by 0.17.1 or earlier, keeps every dropped package and prints a reason.
- Why: a kit-declared package at exactly the plugin's old range was removed (`docs/CONCEPTS.md` §16).
- `scripts/plugin.mjs` `upgrade` in the kit repository itself (no `app`): files are patched untranslated. The old `deriveNames('rocketflare')` stand-in threw "the kit's own name", so nothing was patched. `translateBlock(block, null)` (`scripts/lib/upgrade-lib.mjs`) now translates nothing.
- Docs: `SETUP.md` 3.7 says to publish the draft on the deployer path (`gh release edit X.Y.Z --draft=false`), never `gh release create`. Also updated: `docs/DEPLOYER.md` → Build once, `docs/DEPLOY.md` § CI/CD flow, `docs/CONCEPTS.md` §4, §10 and §16, and `.claude/skills/rf-plugin/`.
- Tests: `ci-workflows.test.ts`, `bundle-lib.test.ts`, `bundle.test.ts`, `plugin-lib.test.ts`, `plugin-skills.test.ts`, `upgrade-lib.test.ts`.

## How to apply

1. Take `scripts/bundle.mjs`, `scripts/plugin.mjs`, and the `.mjs` and `.d.mts` files for `bundle-lib`, `plugin-lib`, `upgrade-lib` and `gate-verified-lib` under `scripts/lib/` from the kit diff. Take `scripts/gate-verified.mjs` too (comment only).
2. Hand-edit `.github/workflows/ci.yml` (it is `manual`):
   - Delete the `verified:` job.
   - In `gate:`, remove `needs: verified` and `if: ${{ !cancelled() }}`, and add `permissions:` with `contents: read`, `checks: read` and `pull-requests: read`.
   - Right after `actions/checkout@v4`, insert the step named `Verified by Launch?` from the kit's file.
   - Delete the `Decide the gate's scope` step, and replace every `steps.scope.outputs.reuse` with `steps.verified.outputs.verified`.
3. Hand-edit `.github/workflows/deploy.yml` `release-bundle`:
   - Give the download step `id: download` and `continue-on-error: true`.
   - Give the attach step `id: attach`, `if: steps.download.outcome == 'success'` and `continue-on-error: true`.
   - Add the kit's three steps after it: the warning, `Prune unpromoted bundle drafts`, and `Old drafts were not pruned`.
   - Change the `ci` job's comment to name `ci.yml`'s `Gate` job.
4. Leave a branch-protection rule that requires `Gate` as it is. Remove any rule that required "Verified by Launch?", which no longer reports.
5. Optionally set the repository variable `BUNDLE_KEEP_DRAFTS` (default 5; `0` keeps every draft).
6. When cutting a release by hand on the deployer path, publish the draft: `gh release edit X.Y.Z --draft=false`.

## Conflicts to expect

- `.github/workflows/ci.yml` → `verified` job folded into `Gate` → hand-port it with How to apply step 2, keeping your own extra steps after the lookup.
- `.github/workflows/deploy.yml` → `release-bundle` steps → hand-port them with How to apply step 3.

## Verify

1. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/ci-workflows.test.ts tests/config/gate-verified.test.ts` passes.
2. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/bundle-lib.test.ts tests/config/bundle.test.ts` passes.
3. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/plugin-lib.test.ts tests/config/plugin-skills.test.ts tests/config/upgrade-lib.test.ts` passes.
4. `.github/workflows/ci.yml` has exactly one job, `gate:`, whose first step after the checkout is `Verified by Launch?`.
5. On a pull request in a repository with `LAUNCH_GATE_APP_ID` set, the run shows one job, `Gate`.

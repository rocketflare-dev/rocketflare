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

On the external-deployer path, `deploy.yml` now builds a tag once on staging, attaches the bundle to a draft GitHub Release, and production deploys those verified bytes instead of rebuilding.

- `scripts/bundle.mjs` (new; pure half `scripts/lib/bundle-lib.mjs` + `bundle-lib.d.mts`): `pack`, `verify`, `attach` and `fetch` for `launch-bundle-<tag>.tgz` (worker outdir minus maps and README, `dist/ui`, a manifest with tag, commit, tree and per-file sha256 plus `bundleSha256`).
- `.github/workflows/deploy.yml`, deployer path only: `staging` packs after the dry run and keeps the bundle as an artifact after `activate`; a new `release-bundle` job (`contents: write`, installs nothing) attaches it to a DRAFT release for the tag; `production` fetches and verifies the published release's bundle and skips `build:ui` and the dry run when it has one.
- A release with no bundle (an older tag) builds as before; a bundle that fails verification fails the job. The plain `wrangler deploy` path (no `DEPLOYER_URL`) is unchanged, and so is a copy deployed outside Launch.
- Tests: `apps/web/tests/config/bundle-lib.test.ts`, `apps/web/tests/config/bundle.test.ts`, and a `deploy.yml build once` block in `apps/web/tests/config/ci-workflows.test.ts`.
- Docs: `docs/DEPLOYER.md` → Build once (the asset format, verification, why a draft and not a prerelease, what a promoter must do), `docs/DEPLOY.md`, `docs/CONCEPTS.md` §10.

## How to apply

1. Copy `scripts/bundle.mjs`, `scripts/lib/bundle-lib.mjs` and `scripts/lib/bundle-lib.d.mts` from the kit unchanged; `scripts/bundle.mjs` imports `readToml` from the copy's existing `scripts/deployer.mjs`.
2. In the copy's `.github/workflows/deploy.yml`, port the `staging` steps `Pack the build for production (build once)` and `Keep the bundle for the release`, the new `release-bundle` job, and the `production` step `Use the staging bundle when the release carries one` plus the new `if:` conditions on the `production` steps `Build UI` and `Build the Worker (dry run, no credentials)`. Keep the `@<slug>/web` filter names the copy already uses.
3. A copy that promotes by hand, on the deployer path: publish the draft release `deploy.yml` created for the tag (Releases → the draft → Publish) instead of creating a new release; a new release still deploys, but from a rebuild.
4. A copy without `DEPLOYER_URL` has nothing to change in behaviour: every new step is skipped on the plain `wrangler deploy` path.

## Conflicts to expect

- `.github/workflows/deploy.yml` → steps added to `staging` and `production`, a new `release-bundle` job → keep the copy's own job edits and add the kit's steps beside them.
- `apps/web/tests/config/ci-workflows.test.ts` → a `deploy.yml build once` block appended at the end → append it after the copy's own blocks.

## Verify

1. `pnpm --filter @<slug>/web exec vitest run --project config tests/config/bundle-lib.test.ts tests/config/bundle.test.ts tests/config/ci-workflows.test.ts` passes.
2. With `pnpm --filter @<slug>/web build:ui` and `pnpm --filter @<slug>/web exec wrangler deploy --dry-run --outdir dist/deploy -c wrangler.staging.toml` run, `TOML=apps/web/wrangler.staging.toml BUNDLE_TAG=0.0.0 node scripts/bundle.mjs pack` prints a `bundleSha256`.
3. `TOML=apps/web/wrangler.toml BUNDLE_TAG=0.0.0 node scripts/bundle.mjs verify apps/web/dist/launch-bundle-0.0.0.tgz` exits 0.

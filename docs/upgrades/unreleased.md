---
version: unreleased
previous: 0.24.0
date: null
breaking: false
migrations: []
areas: [cli, ci, config]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

The CLI login callback closes every connection; every GitHub Action is on its current major and pinned by SHA; every checkout drops its token; every job has a timeout and least-privilege `permissions`; and gitleaks is checksum-verified.

- `apps/cli/src/auth.ts`: the callback server's 404 now sends `Connection: close` like its other responses. A kept-alive socket stayed in `fetch`'s pool after `close()`, so the next server on the same port got `ECONNRESET` (deterministic on Node 26's undici 8, a race on Node 24).
- `actions/checkout` v4 → v7.0.1, `actions/setup-node` v4 → v7.1.0, `pnpm/action-setup` v4 → v6.1.0, `actions/upload-artifact` v4 → v7.0.2, `actions/download-artifact` v4 → v8.0.2, each written as `owner/repo@<sha> # vX.Y.Z`. None of the majors changes an input the workflows use: artifacts are downloaded by name, uploads stay zipped, and `setup-node` keeps its explicit `cache: pnpm`.
- Every `actions/checkout` sets `persist-credentials: false`, so a later step (an artifact upload) cannot publish the `GITHUB_TOKEN` left in `.git/config`. No step pushes or fetches with that token.
- `apps/web/tests/config/ci-workflows.test.ts` asserts the action and its inputs, not the `@v4` tag.
- Every job sets `timeout-minutes` (about 3–5× its slowest observed run: `ci.yml`'s Gate 15; `deploy.yml` 5 for `guard`/`gated`, 20 for `staging`/`production`, 10 for `release-bundle`), so a hung job stops in minutes rather than after GitHub's 6-hour default.
- `evals.yml` (and the kit's own `kit.yml` and `notify-plugins.yml`) set `permissions: contents: read`; none of them writes with `GITHUB_TOKEN`.
- `deploy.yml`'s `staging` and `production` jobs drop `cache: pnpm`: they run on tags and releases and ship what they build, so a poisoned cache entry would reach a deployed bundle. CI keeps its cache.
- `deploy.yml`'s production "Resolve release version" step reads `github.event.release.tag_name` through `env:` instead of splicing it into the script.
- `ci.yml`'s gitleaks step runs under `shell: bash` (pipefail), downloads with `curl -f` and checks the tarball's SHA-256 before extracting it.
- `evals.yml` quotes the suite filter (`${SUITE:+"$SUITE"}`).

## How to apply

1. In `apps/cli/src/auth.ts` `handleCallback`, add `Connection: 'close'` to the headers of the 404 `res.writeHead(...)` call.
2. In `apps/cli/tests/login.test.ts`, in the test "rejects on ?error= and on missing key/tenant_id, 404s other paths", assert that the `/other` response's `connection` header is `close`.
3. In `.github/workflows/ci.yml`, `deploy.yml` and `evals.yml`, replace each `actions/checkout@v4` with `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`.
4. In the same three files, replace each `actions/setup-node@v4` with `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`.
5. In the same three files, replace each `pnpm/action-setup@v4` with `pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0`.
6. In `.github/workflows/deploy.yml` and `evals.yml`, replace each `actions/upload-artifact@v4` with `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2`.
7. In `.github/workflows/deploy.yml`, replace `actions/download-artifact@v4` with `actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2`.
8. Under every `actions/checkout` step in `.github/workflows/`, add `persist-credentials: false` to its `with:` block (create the block where the step has none), unless one of your own later steps pushes with the checkout's token.
9. In `.github/workflows/ci.yml`, `deploy.yml` and `evals.yml`, add `timeout-minutes:` under each job's `runs-on:` — the kit uses 15 for `ci.yml`'s `gate`, 5 for `deploy.yml`'s `guard` and `gated`, 20 for `staging` and `production`, 10 for `release-bundle`; size your own jobs from their run history.
10. In `.github/workflows/evals.yml`, add a top-level `permissions:` block with `contents: read`, and change `pnpm eval $SUITE` to `pnpm eval ${SUITE:+"$SUITE"}`.
11. In `.github/workflows/deploy.yml`, delete `cache: pnpm` from the `actions/setup-node` step of the `staging` job and of the `production` job.
12. In `.github/workflows/deploy.yml`'s `production` job, give the "Resolve release version" step `env: { EVENT_NAME: ${{ github.event_name }}, RELEASE_TAG: ${{ github.event.release.tag_name }} }` and use `"$EVENT_NAME"` and `"$RELEASE_TAG"` in its script instead of the two `${{ }}` expressions.
13. In `.github/workflows/ci.yml`, replace the gitleaks step's `curl … | tar` with: `shell: bash`, `env: GITLEAKS_SHA256: 9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c`, a `curl -sSfL -o "$RUNNER_TEMP/gitleaks.tar.gz"` download, `echo "$GITLEAKS_SHA256  $RUNNER_TEMP/gitleaks.tar.gz" | sha256sum --check --strict`, then `tar -xzf` of that file. Keep the word `gitleaks` on every script line: `ci-workflows.test.ts` recognises the scan's commands by it.
14. If your `apps/web/tests/config/ci-workflows.test.ts` still matches `actions/checkout@v4` or `actions/download-artifact@v4` literally, match `actions\/checkout@\S+` and `actions\/download-artifact@\S+` instead.

## Conflicts to expect

- `.github/workflows/**` → `manual`; the patch is not applied → follow steps 3–13 by hand.
- `apps/web/tests/config/ci-workflows.test.ts` → three version assertions loosened → keep your edits and apply step 14.

## Verify

1. `pnpm --filter @rocketflare/cli test` passes.
2. `grep -rnE 'uses: [^@]+@v[0-9]' .github/workflows` prints nothing.
3. `grep -c 'persist-credentials: false' .github/workflows/*.yml` matches the number of `actions/checkout` steps in each file.
4. `pnpm web test:config` passes.
5. `rg -c 'timeout-minutes' .github/workflows/ci.yml .github/workflows/deploy.yml .github/workflows/evals.yml` counts one per job.
6. `rg -n 'cache: pnpm' .github/workflows/deploy.yml` prints nothing.

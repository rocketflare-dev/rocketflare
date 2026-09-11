---
version: unreleased
previous: 0.1.0
date: null
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The deploy workflow now asks whether there is anything to deploy before it tries. The kit's own
repository keeps `<PLACEHOLDER>` ids in both wrangler tomls on purpose — that is what stops a copy
deploying before it is provisioned — so every tag the kit cut went red at the parity check. A
permanently red deploy is one nobody reads, and a real failure would hide in it.

A `guard` job runs `node scripts/release-check.mjs --deployable` and the two deploy jobs are
conditional on it. **Nothing changes for an app:** a copy has an `app` block in
`.rocketflare.json`, so it always deploys, and still fails loudly at the parity check if it was
never provisioned. Only the kit itself, still carrying placeholders, is skipped — with a notice
saying why.

The decision is `isDeployable` in `scripts/lib/upgrade-lib.mjs`, unit-tested, because the expensive
mistake here is a false skip: somebody's production release quietly not happening. Every ambiguous
case deploys.

## How to apply

Accept the patch. `.github/workflows/**` is `manual`, so read the diff before taking it — if you
have changed your deploy workflow, port the `guard` job and the two `if:` conditions by hand rather
than overwriting yours.

## Conflicts to expect

`.github/workflows/deploy.yml` if you have edited it, which most apps do.

## Verify

```
node scripts/release-check.mjs --deployable    # in an app: deployable=true
pnpm lint && pnpm typecheck && pnpm test
```

---
version: unreleased
previous: 0.6.0
date: null
breaking: false
migrations: []
areas: [config, scripts]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

**0.6.0's gate was red for anyone with a default plugin installed, and this is the fix.** The
wrangler parity test demanded that every installed plugin's declared crons and `run_worker_first`
prefixes already be in both tomls. But `pnpm plugin add` deliberately never writes a toml (D31,
decision 12) — `pnpm provision cloudflare <env>` does. So a checkout that had installed a plugin and
not yet provisioned failed a rule nothing in that state could satisfy. The kit's own CI is exactly
that checkout: `ci.yml` runs the gate a second time with every `defaultPlugins` entry installed, and
it has no Cloudflare credentials to provision with. `analytics` is the first plugin to declare any
platform resource, so 0.6.0 is the release where the contradiction first had something to bite.

Two changes, both narrowing when a rule applies rather than deleting it:

- `pluginParityIssues` now gates the cron and `run_worker_first` checks on `requireProvisioned`,
  exactly as it already gated a `<PLACEHOLDER>` KV id. `pnpm test` stays green on an installed but
  unprovisioned plugin; `deploy.yml` runs the same test with `REQUIRE_PROVISIONED=1`, so an app that
  installed a plugin and never provisioned is still stopped before it can deploy — which is the
  moment a missing cron or route prefix would actually cost anything.
- The `[assets] routes every Worker-owned prefix to the Worker FIRST` assertion keeps its equality,
  but over the prefixes the KIT owns. `WORKER_FIRST_PATTERNS` is built from the server barrel, so an
  installed plugin inflates the expected list while the toml stays bare; both sides now have the
  plugin's patterns subtracted. A kit prefix silently missing from `run_worker_first` still fails,
  which is the whole reason that assertion is an equality and not a subset check.

## How to apply

Mechanical: take both files. There is no schema change and no configuration to touch.

The only behaviour worth knowing is the one above: if you relied on a plain `pnpm test` to tell you
that a plugin's cron or route prefixes were missing from your tomls, that now reports under
`REQUIRE_PROVISIONED=1` instead — which `deploy.yml` already sets before it deploys. Run
`pnpm provision cloudflare <env>` after installing a plugin, as the install plan has always said.

## Conflicts to expect

- `apps/web/scripts/provision/plugin-resources.ts` — the two loops at the end of
  `pluginParityIssues` are now inside `if (opts.requireProvisioned)`, and the docstring says why.
- `apps/web/tests/config/wrangler-parity.test.ts` — `installed` and a new `PLUGIN_WORKER_FIRST` set
  move to module scope (two describes need them), the `run_worker_first` equality subtracts plugin
  patterns from both sides, and the fixture test that asserted 14 issues is now a pair: 8 without
  `requireProvisioned` and 14 with it.

## Verify

- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.
- With a default plugin installed (`pnpm plugin add <repo>@<ref> --apply`, then `pnpm db:generate`
  and `pnpm db:migrate`), `pnpm test` is green without provisioning — this is what CI does, and what
  0.6.0 failed.
- `REQUIRE_PROVISIONED=1 pnpm --filter @rocketflare/web test:config` still FAILS on that same
  checkout, naming the missing cron and prefixes, until `pnpm provision cloudflare <env>` has run.

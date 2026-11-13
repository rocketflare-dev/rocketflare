---
version: unreleased
previous: 0.35.0
date: null
breaking: false
migrations: []
areas: [config, api, cli, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Provisioning a copy with a public-site plugin now reaches a working production site unaided: zone routes instead of 403-prone custom domains, production-only runs, real deploys, and a public-site cache keyed on the deployment.

- `pnpm provision deploy <env>` and the root `deploy` scripts call `pnpm run deploy` — a bare `pnpm deploy` is pnpm's own command and deployed nothing.
- `cloudflare <env>` no longer fails "already has id" on the second environment: a placeholder never replaces a real plugin binding id.
- `cf-provision.sh` treats an R2 "bucket already exists" as found, so a partial run re-runs cleanly.
- `preflight` names a missing or non-GitHub `origin` first, with the `gh repo create` command.
- `--envs production|staging|both` on `all` and `urls`: a production-only app provisions no staging.
- The Neon region is asked for (no silent `aws-us-east-1`), with the regions named.
- `urls` writes a public-site plugin's hosts var (`--production-site-hosts` / `--staging-site-hosts`, else a question) and warns when an environment has none.
- With site hosts, `urls` writes the app and every site host as zone routes and creates each host's proxied `AAAA 100::` record — several custom domains on one Worker answer a reused browser connection with a bare 403 (`docs/DEPLOY.md` § Zone, DNS and multiple hosts).
- `preflight` lists installed plugins' secrets and appends unset ones blank to `.provision.env`; `secrets <env>` warns per unset plugin secret the Worker lacks.
- New offline phase `pnpm provision declarations`; `pnpm plugin add|upgrade --apply` runs it, so a plugin's KV / R2 blocks (placeholder ids) exist for `pnpm dev` at once.
- Public-site cache key is now `<host>/<deployment>/<generation>/<path>` (`DEPLOYMENT_ID`, which the deploy scripts and `deploy.yml` pass per deploy; a boot id under `wrangler dev`), so a deploy or a dev reload never serves pages from older code.
- `publicSites.cache.generationMaxAgeSeconds` (opt-in) lets an isolate reuse the publish generation briefly, serving it stale once while it refreshes (`docs/CONCEPTS.md` §16).
- Both tomls turn on `invocation_logs`.
- `pnpm test` refuses Node < 26 by name, and reuses another checkout's test servers on :5433 / :4433, creating this checkout's database there.
- The CLI resolves paths from the directory `pnpm cli` was typed in, and warns when `<APP>_API_KEY` / `<APP>_URL` from the environment override a different saved login.

## How to apply

1. Port `apps/web/scripts/provision.ts`, `apps/web/scripts/provision/patch-toml.ts`, `apps/web/scripts/provision/cloudflare-dns.ts` and `apps/web/scripts/cf-provision.sh` from the release (yours are the kit's unless you edited them; then re-apply the hunks).
2. In the root `package.json`, change the `deploy` and `deploy:staging` scripts to `pnpm --filter @<scope>/web run deploy` and `… run deploy:staging`.
3. In both `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`, set `invocation_logs = true` under `[observability.logs]`; in `apps/web/package.json` append `--var DEPLOYMENT_ID:$(date -u +%Y%m%d%H%M%S)` to the `deploy` and `deploy:staging` scripts; in `.github/workflows/deploy.yml` append `--var "DEPLOYMENT_ID:${{ github.run_id }}-${{ github.run_attempt }}"` to both real `wrangler deploy` lines; port `DEPLOYMENT_ID` in `apps/web/src/config.ts`.
4. Port `apps/web/src/api/middleware/public-sites.ts`, `apps/web/src/plugins/types.ts` (the `generationMaxAgeSeconds` field) and `apps/web/tests/api/public-sites.test.ts` from the release.
5. Port `scripts/test.mjs` and `scripts/plugin.mjs` from the release (`writeDeclarations`, called after `add` and `upgrade` apply).
6. Port `apps/cli/src/config.ts` (`envOverridesLogin`), `apps/cli/src/context.ts` (the warning) and the `INIT_CWD` block at the top of `apps/cli/src/cli.ts`.
7. Port the `version_metadata` entry in `apps/web/tests/config/wrangler-parity.test.ts` and the new cases in `apps/web/tests/config/patch-toml.test.ts`.
8. A DEPLOYED copy whose app and site hosts are both Workers custom domains: delete those custom domains (dashboard → Workers → the Worker → Settings → Domains & Routes), run `pnpm provision urls --envs production`, then `pnpm provision deploy production`.

## Conflicts to expect

- `apps/web/wrangler*.toml` → `invocation_logs = true` → set it identically in each file (the parity test compares them).
- `apps/web/scripts/provision.ts` → many hunks (flags, `collectAnswers`, `urlsPhase`, `secretsPhase`, `allPhase`) → take the release's file and re-apply your own edits.
- `apps/web/tests/api/public-sites.test.ts` → the cache-key test now matches `<host>/<deployment>/<generation>/<path>` → keep the release's assertion.

## Verify

1. `pnpm gate` passes.
2. `pnpm provision --help` lists `declarations`, `--envs` and `--production-site-hosts`.
3. After `pnpm provision deploy production`, a page fetched twice shows `cf-cache-status: HIT` the second time, and again a miss after the next deploy.
4. On a copy with site hosts: after `pnpm provision urls`, `routes` in `apps/web/wrangler.toml` has only `zone_name` entries, and `curl -sI https://<site host>/ --connect-to <site host>:443:<app host>:443` returns 200, not 403.

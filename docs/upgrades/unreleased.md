---
version: unreleased
previous: 0.15.0
date: null
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The rename now leaves every `rocketflare-dev/<repo>` reference upstream (neon-proxy image, plugin repos, reusable plugin CI), and the test database's Compose project is named per app, so copies stop replacing each other's test Postgres.

- `scripts/lib/rename-lib.mjs`: `KIT.preservedPattern` protects the `rocketflare-dev` org and any `rocketflare-dev/<repo>`, replacing the single `github.com/rocketflare-dev/rocketflare` literal; container names such as `rocketflare-dev-postgres` still move. `pnpm kit:upgrade` translates diffs with the same function, so later releases keep the references too (#37).
- `apps/web/tests/config/rename-lib.test.ts` renames every tracked file in memory and fails on any `<slug>-dev/` or `ghcr.io/<slug>` left behind.
- `apps/web/tests/config/update-check-lib.test.ts` passes in a renamed copy: it expects the real manifest to be skipped only when its `app` is `null`.
- `apps/web/docker-compose.test.yml` sets `name: rocketflare-test` (renamed with the slug), where the project used to be `web` in every copy (#38). The test port stays 5433 ([`docs/CONCEPTS.md` §4 known gaps](../CONCEPTS.md)).

## How to apply

1. Accept the kit's `scripts/lib/rename-lib.mjs`, `scripts/lib/rename-lib.d.mts`, `scripts/rename.mjs` and `apps/web/tests/config/rename-lib.test.ts` unchanged; all four are on the rename's exclusion list and keep the kit's own name.
2. If the app was renamed at 0.15.0 or earlier, find the org references that rename rewrote with `git grep -nE '<slug>-dev/|ghcr\.io/<slug>-dev'` (use the app's slug) and change each one back to `rocketflare-dev/<the kit's repo name>`: `ghcr.io/rocketflare-dev/local-neon-proxy` in `apps/web/docker-compose.dev.yml`, `apps/web/docker-compose.test.yml`, `apps/web/docker/Dockerfile.neon-proxy`, `.claude/rules/database.md` and `docs/NEON-DRIVER.md`; `rocketflare-dev/rocketflare-plugins` in `.github/workflows/notify-plugins.yml`; `rocketflare-dev/rocketflare/.github/workflows/plugin-ci.yml` in `.github/workflows/plugin-ci.yml` and `docs/DEPLOY.md`; `rocketflare-dev/rocketflare-plugin-analytics` in `docs/CONCEPTS.md`.
3. In `apps/web/tests/config/update-check-lib.test.ts`, accept the kit's version of the test that reads the real `.rocketflare.json`, and the `/no \.rocketflare\.json/` matcher.
4. Add `name: <slug>-test` above `services:` in `apps/web/docker-compose.test.yml`, using the app's slug.
5. Remove the test container that belonged to the old `web` project once, or the next `pnpm test:db:up` stops on a container-name conflict: `docker rm -f <slug>-test-postgres <slug>-test-neon-proxy`, then `pnpm test:db:up`. Its data is throwaway; the tests migrate a fresh database.

## Conflicts to expect

- `apps/web/docker-compose.test.yml` → a top-level `name:` added above `services:` → keep it, with the app's slug.

## Verify

1. `git grep -nE '<slug>-dev/|ghcr\.io/<slug>-dev'` (with the app's slug) prints nothing.
2. `docker compose -f apps/web/docker-compose.test.yml config --format json | jq -r .name` prints `<slug>-test`.
3. `pnpm test:db:up && pnpm web exec vitest run --project config tests/config/rename-lib.test.ts tests/config/update-check-lib.test.ts` passes.

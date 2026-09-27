---
version: unreleased
previous: 0.13.0
date: null
breaking: false
migrations: []
areas: [api, db, config, docs]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

The kit's commit-time nudges now actually reach Claude: they answer as JSON `additionalContext`, and a new hook reminds maintainers to update rocketflare.dev on any commit that changes the root version.

- `scripts/changelog-nudge.mjs` printed plain text, which a `PreToolUse` hook sends only to the debug log, so the "no porting note" nudge was never seen. It now writes `hookSpecificOutput.additionalContext` plus a `systemMessage`.
- New `scripts/release-site-nudge.mjs` (+ `scripts/lib/nudge-lib.mjs`): on a `git commit` that changes the root `package.json` version in the kit or the plugins monorepo, it hands Claude the rocketflare-www steps. It is silent in a copy of the kit.
- `.claude/settings.json` registers the new hook beside `changelog-nudge.mjs`.
- For a plugins release the reminder also says to run `npm run sync:plugins` in rocketflare-www, which refreshes the per-plugin pages from each plugin's README.
- `tests/config/nudge-hooks.test.ts` covers the output shape and runs the hook in throwaway repositories.
- With `DEPLOYER_URL` unset the staging and production jobs run the same steps as before; the only difference is `permissions: id-token: write` on both jobs.

`pnpm db:migrate` (and `db:migrate:ci`, so every deploy) no longer fails on Neon with `permission denied to alter role`.

- `apps/web/scripts/db-roles.ts` ran `ALTER ROLE rocketflare_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`. Only a superuser may name `SUPERUSER`, `BYPASSRLS` or `REPLICATION`, even to turn them off, and Neon's owner role is not one. It now runs `ALTER ROLE … NOCREATEDB NOCREATEROLE` always, and the other three only inside a `DO` block when `current_setting('is_superuser') = 'on'`. `CREATE ROLE … NOLOGIN` already defaults them off, and the post-check that `rolsuper` and `rolbypassrls` are false is unchanged.
- New `apps/web/tests/api/db-roles.test.ts` runs the role phase as a throwaway non-superuser owner with `CREATEDB CREATEROLE`, the shape of Neon's `neondb_owner`.
- `docs/DEPLOY.md` (Neon section) and `docs/RLS.md` explain the rule.

Dev ports are configurable for a machine where :3000/:3001 are taken (a Cloudflare Sandbox holds :3000): `DEV_UI_PORT` / `DEV_API_PORT` / `DEV_ALLOWED_HOSTS`, from the shell or `apps/web/.dev.vars`. Unset, everything stays on 3000/3001.

- New `scripts/lib/dev-ports.mjs` (+ `.d.mts`) is the one reader: `devPorts()` → `{ ui, api }` (shell, then `.dev.vars`, then 3000/3001; a non-port or two equal ports throws) and `devAllowedHosts()`.
- Its consumers: `apps/web/vite.config.ts` (port, `/api` `/auth` `/ws` proxy targets, `allowedHosts` merged with the cfld tunnel host), `apps/web/scripts/dev-server.mjs` (ports it sweeps, `wrangler dev --port`, ready line), `scripts/bootstrap.mjs` (health/login URLs), `apps/web/scripts/seed.ts` (default `APP_URL`, the dev-login curl). `apps/web` `dev:api` runs `wrangler dev --port ${DEV_API_PORT:-3001}`.
- CORS/CSRF (`middleware/cors.ts` `allowedOrigins(cfg, requestUrl?)`, called by `csrf.ts` too): outside production it now also allows the loopback twin (localhost ↔ 127.0.0.1) of `APP_URL` and of the request's own loopback origin, so only `APP_URL` has to follow a custom UI port. Production is unchanged: `APP_URL` alone.

`pnpm bootstrap --db-url <url>` (also `--db-url=<url>`) bootstraps against an existing Postgres, such as a Neon branch in a sandbox with no Docker. It skips the Docker checks, upserts `DATABASE_URL` in `apps/web/.dev.vars`, polls `db:check` instead of starting a container, and seeds with `SEED_ALLOW_REMOTE=1`. It is still ten steps, and without the flag nothing changes. See [`docs/CONCEPTS.md` §4](../CONCEPTS.md).

- `bootstrap.mjs`'s argument parser moved to `scripts/lib/bootstrap-lib.mjs` as `parseBootstrapArgs`, beside `bootstrapStepPlan`, `isLocalDatabaseUrl`, `isPostgresUrl` and `databaseUrlTarget`. `bootstrap.sh` skips its `docker` check when `--db-url` is given.
- `pnpm preflight` skips the Docker lines when `DATABASE_URL` points off this machine. `dev-db.mjs` passes an off-box URL through unchanged (`up` reports nothing to start; `status` never prints that URL). `seed.ts` always prints `seeding <host>/<db>`, without credentials.

`deploy.yml` can deploy through an external deployer (off by default): with the repository variable `DEPLOYER_URL` set, CI holds no Cloudflare token and no database credential and authenticates with a GitHub OIDC token instead. Why: `docs/CONCEPTS.md` §10.

- New `scripts/deployer.mjs` (`start | upload | activate | finish`) is the client; `docs/DEPLOYER.md` is the versioned v1 contract any deployer implements; `tests/config/deployer.test.ts` drives the script against a fake deployer.

## How to apply

1. Copy `scripts/changelog-nudge.mjs`, `scripts/release-site-nudge.mjs`, `scripts/lib/nudge-lib.mjs` and `scripts/lib/nudge-lib.d.mts` from the kit, and the test `apps/web/tests/config/nudge-hooks.test.ts`.
2. `.claude/settings.json` is a `manual` file, so add the second `PreToolUse` Bash hook entry by hand: `node "$CLAUDE_PROJECT_DIR/scripts/release-site-nudge.mjs"`, timeout 10. It is silent in an app, so this step is optional for a copy.
3. Copy `apps/web/scripts/db-roles.ts` and `apps/web/tests/api/db-roles.test.ts` from the kit verbatim. If your copy renamed the app role, the script still reads it from `APP_ROLE` in `src/db/schema/rls.ts`, so nothing needs translating. Nothing to migrate. On Neon, the next `pnpm db:migrate` or deploy now gets past the role phase.
4. Copy verbatim from the kit: `scripts/lib/dev-ports.mjs`, `scripts/lib/dev-ports.d.mts` and `apps/web/tests/config/dev-ports.test.ts`.
5. Merge the kit's diff into `apps/web/vite.config.ts`, keeping the app's own proxy prefixes and aliases: import `devPorts` / `devAllowedHosts` from `../../scripts/lib/dev-ports.mjs`, use `ports.ui` for `server.port` and `ports.api` in the `API` constant and the `/ws` proxy target, and set `allowedHosts` to `DEV_ALLOWED_HOSTS` plus the tunnel host (HMR over wss stays tunnel-only).
6. Merge the kit's diff into `apps/web/scripts/dev-server.mjs` (`PORTS`, the ready line, `wrangler dev --port`), `scripts/bootstrap.mjs` (`API_URL` / `UI_URL` and the step-8 hint) and `apps/web/scripts/seed.ts` (the default `APP_URL` and the `apiUrl()` dev-login line replacing `.replace(':3000', ':3001')`).
7. Merge the kit's diff into `apps/web/src/api/middleware/cors.ts` (`loopbackOrigins`, the `requestUrl` parameter of `allowedOrigins`) and pass `c.req.url` as that parameter in `apps/web/src/api/middleware/csrf.ts`; the two new cases in `apps/web/tests/api/health.test.ts` cover it.
8. `apps/web/package.json` is a `manual` file: change the `dev:api` script's `--port 3001` to `--port ${DEV_API_PORT:-3001}`.
9. `apps/web/.dev.vars.example` is never ported, so add by hand, below `APP_URL`, commented `# DEV_UI_PORT=3000`, `# DEV_API_PORT=3001` and `# DEV_ALLOWED_HOSTS=` lines and a note that `APP_URL` must follow `DEV_UI_PORT`.
10. For `--db-url`, take the kit's `scripts/bootstrap.sh`, `scripts/bootstrap.mjs`, `scripts/lib/bootstrap-lib.mjs`, `scripts/lib/bootstrap-lib.d.mts`, `apps/web/scripts/dev-db.mjs` and `apps/web/tests/config/bootstrap-lib.test.ts`. If the app changed `bootstrap.mjs`, port its local `parseArgs` edits into `parseBootstrapArgs` in `bootstrap-lib.mjs`, because `bootstrap.mjs` no longer has a parser of its own.
11. In `apps/web/scripts/seed.ts`, import `databaseUrlTarget` from `../../../scripts/lib/bootstrap-lib.mjs` and print `seeding ${databaseUrlTarget(DATABASE_URL)}` right after the `DATABASE_URL is required` check, before the `SEED_ALLOW_REMOTE` refusal.
12. Bring over the `--db-url` text in `SETUP.md` §1.4 ("No Docker: use an existing database"), `.claude/skills/rf-setup/SKILL.md` (argument hint, flag paragraph, exit-3 row, step table rows 1, 3, 4 and 7) and `.claude/skills/rf-preflight/SKILL.md`, translated into the app's names.
13. Copy `scripts/deployer.mjs`, `docs/DEPLOYER.md` and `apps/web/tests/config/deployer.test.ts` from the kit unchanged.
14. `.github/workflows/deploy.yml` is a `manual` file, so hand-merge the deployer path into it; open the kit's `deploy.yml` beside yours and, in BOTH the `staging` and the `production` job:
   1. Under `environment:`, add `permissions:` with `contents: read` and `id-token: write`, and a job `env:` with `DEPLOYER_URL: ${{ vars.DEPLOYER_URL }}`, `DEPLOYER_AUDIENCE: ${{ vars.DEPLOYER_AUDIENCE }}`, `TOML:` (`apps/web/wrangler.staging.toml` in staging, `apps/web/wrangler.toml` in production) and `DEPLOYER_OUTDIR: apps/web/dist/deploy`.
   2. Add `if: vars.DEPLOYER_URL == ''` to the `Run database migrations` step and to the `Deploy (apps/web/wrangler…toml)` step; if either already has an `if:`, join both conditions with `&&`.
   3. Between the migrations step and `Build UI`, add the step `node scripts/deployer.mjs start` with `if: vars.DEPLOYER_URL != ''`.
   4. After `Build UI`, add, each with `if: vars.DEPLOYER_URL != ''` and in this order: `pnpm --filter @rocketflare/web exec wrangler deploy --dry-run --outdir dist/deploy` (plus `-c wrangler.staging.toml` in staging); `node scripts/deployer.mjs upload` with step env `RELEASE_VERSION: ${{ steps.version.outputs.version }}`; `pnpm db:migrate:ci` with step env `DATABASE_URL: ${{ env.MIGRATOR_URL }}`; `node scripts/deployer.mjs activate`. `Build UI` must stay before the dry run, which fails on a missing `[assets] directory`.
   5. As the job's LAST step, add `node scripts/deployer.mjs finish` with `if: always() && vars.DEPLOYER_URL != ''`.
   6. Write your own web package name in place of `@rocketflare/web` if `/rf-adapt` renamed it.
15. Leave `DEPLOYER_URL` unset to keep deploying as today. To switch, stand up a deployer that implements `docs/DEPLOYER.md`, set the repository variable `DEPLOYER_URL`, then delete `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `DATABASE_URL` from the GitHub Environments once a deploy has gone through it.

## Conflicts to expect

- `.claude/settings.json` → the app may have hooks of its own → keep both sides.
- `apps/web/vite.config.ts` → the proxy block carries an installed plugin's prefixes (`/cubejs-api`, `/mcp`) → keep them; only the `/ws` target and `server` keys change.
- `scripts/bootstrap.mjs` → `parseArgs` and `UsageError` are gone, replaced by imports → keep the app's own steps, drop its parser after porting its flags into `parseBootstrapArgs`.
- `.github/workflows/deploy.yml` → steps the app added to its deploy jobs (smoke tests, notifications) → keep them; a step that needs `CLOUDFLARE_API_TOKEN` or `DATABASE_URL` takes `if: vars.DEPLOYER_URL == ''` too, and one that must run after the deploy goes after `activate`, before `finish`.

## Verify

1. `pnpm web test:config` passes, including `nudge-hooks.test.ts`, `dev-ports.test.ts` and `bootstrap-lib.test.ts` (`parseBootstrapArgs`, `bootstrapStepPlan`), plus `deployer.test.ts`.
2. `pnpm web test:api` passes, including `db-roles.test.ts` and the custom-port CORS and CSRF cases in `health.test.ts`.
3. On Neon, `pnpm db:migrate` against a branch as its owner role completes the `[role]` phase and prints `Role '<app role>' ready [role]`.
4. With no `DEV_*` keys set, `pnpm dev` still reports `http://localhost:3000` and `api http://localhost:3001`.
5. `DEV_UI_PORT=5199 DEV_API_PORT=8799 pnpm dev:status` lists `:5199` and `:8799`.
6. `node scripts/bootstrap.mjs --check --db-url postgresql://h/db` exits 2, and `node scripts/bootstrap.mjs --db-url mysql://h/db` exits 2.
7. `node scripts/bootstrap.mjs --help` lists `--db-url <url>`.
8. In `.github/workflows/deploy.yml`, every step using `secrets.CLOUDFLARE_API_TOKEN` or `secrets.DATABASE_URL` has `vars.DEPLOYER_URL == ''` in its `if:`, and the `finish` step has `always()`.
9. With `DEPLOYER_URL` unset, the next tag's staging run shows the deployer steps as skipped and deploys as before.

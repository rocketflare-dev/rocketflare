---
version: unreleased
previous: 0.13.0
date: null
breaking: false
migrations: []
areas: [docs, db, api, config]
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

`pnpm db:migrate` (and `db:migrate:ci`, so every deploy) no longer fails on Neon with `permission denied to alter role`.

- `apps/web/scripts/db-roles.ts` ran `ALTER ROLE rocketflare_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`. Only a superuser may name `SUPERUSER`, `BYPASSRLS` or `REPLICATION`, even to turn them off, and Neon's owner role is not one. It now runs `ALTER ROLE … NOCREATEDB NOCREATEROLE` always, and the other three only inside a `DO` block when `current_setting('is_superuser') = 'on'`. `CREATE ROLE … NOLOGIN` already defaults them off, and the post-check that `rolsuper` and `rolbypassrls` are false is unchanged.
- New `apps/web/tests/api/db-roles.test.ts` runs the role phase as a throwaway non-superuser owner with `CREATEDB CREATEROLE`, the shape of Neon's `neondb_owner`.
- `docs/DEPLOY.md` (Neon section) and `docs/RLS.md` explain the rule.

Dev ports are configurable for a machine where :3000/:3001 are taken (a Cloudflare Sandbox holds :3000): `DEV_UI_PORT` / `DEV_API_PORT` / `DEV_ALLOWED_HOSTS`, from the shell or `apps/web/.dev.vars`. Unset, everything stays on 3000/3001.

- New `scripts/lib/dev-ports.mjs` (+ `.d.mts`) is the one reader: `devPorts()` → `{ ui, api }` (shell, then `.dev.vars`, then 3000/3001; a non-port or two equal ports throws) and `devAllowedHosts()`.
- Its consumers: `apps/web/vite.config.ts` (port, `/api` `/auth` `/ws` proxy targets, `allowedHosts` merged with the cfld tunnel host), `apps/web/scripts/dev-server.mjs` (ports it sweeps, `wrangler dev --port`, ready line), `scripts/bootstrap.mjs` (health/login URLs), `apps/web/scripts/seed.ts` (default `APP_URL`, the dev-login curl). `apps/web` `dev:api` runs `wrangler dev --port ${DEV_API_PORT:-3001}`.
- CORS/CSRF (`middleware/cors.ts` `allowedOrigins(cfg, requestUrl?)`, called by `csrf.ts` too): outside production it now also allows the loopback twin (localhost ↔ 127.0.0.1) of `APP_URL` and of the request's own loopback origin, so only `APP_URL` has to follow a custom UI port. Production is unchanged: `APP_URL` alone.

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

## Conflicts to expect

- `.claude/settings.json` → the app may have hooks of its own → keep both sides.
- `apps/web/vite.config.ts` → the proxy block carries an installed plugin's prefixes (`/cubejs-api`, `/mcp`) → keep them; only the `/ws` target and `server` keys change.

## Verify

1. `pnpm web test:config` passes, including `nudge-hooks.test.ts` and `dev-ports.test.ts`.
2. `pnpm web test:api` passes, including `db-roles.test.ts` and the custom-port CORS and CSRF cases in `health.test.ts`.
3. On Neon, `pnpm db:migrate` against a branch as its owner role completes the `[role]` phase and prints `Role '<app role>' ready [role]`.
4. With no `DEV_*` keys set, `pnpm dev` still reports `http://localhost:3000` and `api http://localhost:3001`.
5. `DEV_UI_PORT=5199 DEV_API_PORT=8799 pnpm dev:status` lists `:5199` and `:8799`.

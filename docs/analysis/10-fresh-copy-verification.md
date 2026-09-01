# Fresh-copy verification — 2026-09-01

Tested commit: `6f40b13` (Phase 4-UI), clone at `/tmp/rocketflare-fresh` with no `node_modules`, `dist`,
or `.dev.vars`. Method: read `CLAUDE.md` → `docs/ADAPTING.md` → `SETUP.md` Part 1, then execute
Part 1 verbatim and record actual vs documented output. Docker was running with the kit's own
dev/test Postgres containers already up from the primary checkout.

## Step table

| SETUP step | Command | Documented expectation | Actual | |
|---|---|---|---|---|
| 1.1 toolchain | `node -v`, `corepack enable && pnpm -v`, `docker info` | v24 / pnpm 10 / docker-ok | v24.16.0 / 10.18.0 / ok | ✅ |
| 1.2 deps | `pnpm install` | — | 14.8 s | ✅ |
| 1.3 secrets | `cp apps/web/.dev.vars.example apps/web/.dev.vars` + 2× `openssl rand -hex 32` | two 64-hex keys set | both set; blank optional secrets are treated as absent by `config.ts` (`preprocess` → `undefined`) | ✅ |
| 1.4 db | `pnpm dev:db:up` | pgvector on :5432 | **failed**: `container name "/rocketflare-dev-postgres" is already in use` (second checkout on one machine; the running DB is still reachable) | ⚠️ |
| 1.4 db | `pnpm web db:check` | connected, pgvector installed | `Connected to rocketflare_dev as rocketflare … pgvector extension: installed` | ✅ |
| 1.4 db | `pnpm db:migrate` | role → migrations → grants | 1.5 s, `Role 'rocketflare_app' ready [grants]` | ✅ |
| 1.5 seed | `pnpm seed` | idempotent demo data | idempotent (existing rows reported), dev-login instructions printed | ✅ |
| 1.6 run | `pnpm dev` | wrangler :3001 + vite :3000 | **wrangler died**: `The directory specified by the "assets.directory" field … does not exist: apps/web/dist/ui`; vite came up alone, every proxied call 502 | ❌ **P0** |
| 1.6 run (after fix) | `pnpm dev` with `dist/ui` present | health, login page, dev-login | `/api/health` ok · `/login` 200 · dev-login 200 · session `owner@example.test acme owner` | ✅ |
| 1.6 analytics verify | `pnpm web db:refresh-facts && pnpm web db:check-facts` | fresh | `tenants=1 rows=1`, `lag=0s fresh`; `GET /api/analytics/pages` → `Organisation Overview` | ✅ |
| 1.7 CLI | `pnpm cli status` | health line | `Health: ok · vdev · development` | ✅ |
| 1.7 CLI | `pnpm cli login` | opens a browser | not possible headless; SETUP had no headless path | ⚠️ **P1** |
| 1.7 CLI (headless) | `GET /auth/cli?redirect_uri=…` with cookie → `ROCKETFLARE_API_KEY` → `pnpm cli whoami` | — | `User: Olivia Owner <owner@example.test> · Tenant: Acme` | ✅ |
| 1.8 tests | `pnpm test:db:up && pnpm test` | all green | `test:db:up` same container-name conflict (⚠️); tests **761 passed, 3 skipped** in 15 s wall | ✅ |
| 1.9 gate | `pnpm build` | UI + Worker dry-run + CLI | 12 s; Worker 1267 KiB gzip; CLI bundle built | ✅ |

## Findings and fixes applied

| Pri | Finding | Fix (committed with this report) |
|---|---|---|
| **P0** | `pnpm dev` fails on a fresh copy because `wrangler dev` requires `[assets] directory = ./dist/ui` to exist and nothing has built the UI yet. It only worked in the primary checkout because an earlier build left the directory behind. | `apps/web/package.json` `dev:api` → `mkdir -p dist/ui && wrangler dev --port 3001` (Vite serves the UI in dev; an empty assets dir is fine). |
| P1 | No headless/agent path for CLI login; `pnpm cli login` opens a browser. | `SETUP.md` §1.7 note + `docs/ADAPTING.md` §3b recipe (use `GET /auth/cli` with a session, or a tenant API key + `ROCKETFLARE_API_KEY`). |
| P1 | `apps/web/scripts/cf-provision.sh` still had the queue and R2 bucket creation commented out although both bindings ship in the tomls since Phase 2. | Enabled (`wrangler queues create`, `wrangler r2 bucket create`, name-referenced). |
| P1 | Rename checklist missed `rocketflare-dev-postgres`/`rocketflare-test-postgres` (`container_name`) and `admin@rocketflare.local` (seeded global admin, dev quick-login list). | Rows added to `docs/ADAPTING.md` §1, with the second-checkout conflict explained. |
| P1 | ADAPTING referenced `apps/web/tests/ui/contrast.test.ts`, which does not exist. | Points at `theme-toggle.test.tsx`. |
| P2 | `pnpm dev:db:up` / `test:db:up` fail with a name conflict when two checkouts of the kit coexist on one machine. | Documented in the rename row; renaming the app (the first ADAPTING step) removes it. Not changing `container_name` pinning — it is what makes `pnpm web db:check` and the docs deterministic. |
| P2 | SETUP Part 3 refers to resources by kind while `docs/DEPLOY.md` uses binding names — no binding named in either is missing from `wrangler.toml`/`cf-provision.sh`/`deploy.yml`, but a reader jumps between the two. | Left as is; DEPLOY is the reference table SETUP links to. |

## Rename-checklist coverage

Token census (`git grep`, excluding `docs/analysis`, `ADAPTING.md`, lockfile): every token found in the
tree is now named in `docs/ADAPTING.md` §1 — `@rocketflare/{shared,web,cli}` (408), `rocketflare_app` (116),
`rocketflare-light`/`rocketflare-dark` (51), `rocketflare-*` worker/queue/bucket/workflow names incl. `-staging` and the
commented `-dlq`, `~/.rocketflare`, `ROCKETFLARE_{API_KEY,URL,CONFIG_DIR,DEBUG}`, `Rocketflare`, `rocketflare_dev`/`rocketflare_test`/
`rocketflare_pass`, `noreply@example.com`, `app/staging.example.com`, `admin@rocketflare.local`, container names.

## Docs vs config drift

Every binding/var in `apps/web/wrangler.toml` (`HYPERDRIVE`, `RATE_LIMIT_KV`, `JOBS_QUEUE`,
`NOTIFICATIONS_HUB`, `FILES`, `AGENT_RUN_WORKFLOW`, `AI`, `ASSETS`, the 11 `[vars]`) and every secret in
`.dev.vars.example` appears in `docs/DEPLOY.md`; `deploy.yml` uses only `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `DATABASE_URL`, `REQUIRE_PROVISIONED`, all documented. `bash -n cf-provision.sh`
passes. `REQUIRE_PROVISIONED=1 pnpm --filter @rocketflare/web test:config` fails exactly on
`<HYPERDRIVE_ID>`, `<KV_RATE_LIMIT_ID>` and their `_STAGING` twins, with the message pointing at
`pnpm provision <env>` — as designed.

## "First three features" recipe (ADAPTING §3)

Followable without other docs: every concrete path it names exists; the two "missing" hits are
templates (`use<Feature>.ts`, `pages/agents/…`). The recipe order matches the kit's non-negotiable
(shared zod → schema → route → hook → page → CLI command).

## Timings (Apple Silicon, warm Docker)

install 14.8 s · migrate 1.5 s · seed < 1 s · `pnpm test` 15 s wall (761 tests) · `pnpm build` 12 s.

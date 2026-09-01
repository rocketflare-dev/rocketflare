# DEPLOY — Cloudflare topology reference

What runs where, what the two wrangler files may and may not differ in, how resources are created,
how a release moves, and how it comes back. Procedure lives in `SETUP.md` Part 3; this is the
reference it points at.

**Workspace shape.** Everything Cloudflare lives in `apps/web`: `wrangler.toml`,
`wrangler.staging.toml`, `worker-configuration.d.ts`, `scripts/cf-provision.sh`, the parity test.
`wrangler` is a devDependency of that package, so every wrangler command runs **in `apps/web`** —
either `pnpm --filter @rocketflare/web exec wrangler …` from the root (shorthand `pnpm web exec wrangler …`)
or the root scripts that delegate there (`pnpm deploy`, `pnpm deploy:staging`, `pnpm provision`,
`pnpm types`). `pnpm exec wrangler` at the workspace root does not resolve. Only `apps/web` is
deployed. **The CLI (`apps/cli`) is not deployed**: CI builds it (`pnpm build` → `apps/cli/dist`) as
a compile check, and it is distributed through the repo (`pnpm cli …`, or `pnpm --filter @rocketflare/cli
build` and run `dist/cli.js`) or an internal registry — publishing the CLI is an app decision; the
package is private by default (`"private": true`, like `packages/shared`, which must stay private).

## Topology

```
                    GitHub Actions (deploy.yml)
     tag X.Y.Z ──────────────┐            ┌────────────── Release published
                             ▼            ▼
              ┌──────────────────┐  ┌──────────────────┐
              │ <app>-staging    │  │ <app>            │   one Worker per env:
              │ wrangler.staging │  │ wrangler.toml    │   fetch + queue + scheduled
              │ .toml            │  │                  │   + NotificationsHub DO
              └───────┬──────────┘  └────────┬─────────┘   + AgentRunWorkflow
   bindings:  HYPERDRIVE  RATE_LIMIT_KV  [JOBS_QUEUE  FILES  AGENT_RUN_WORKFLOW  AI]  ASSETS
   crons:     0 4 * * * (prune)   15 * * * * (fact tables)         routes: /api /auth /ws /cubejs-api /mcp
                      │                      │
              Hyperdrive <app>-staging   Hyperdrive <app>-production      (direct Neon host)
                      │                      │
              Neon branch `staging`      Neon branch `production` (main)  one project, role per branch
```

Workers Paid plan is required (Hyperdrive, Workflows, `[limits]`). Smart Placement runs the Worker
near Neon rather than near the user, which is what makes sequential queries cheap.

## Wrangler anatomy — two files, one shape (D6)

`[env.*]` does not inherit bindings, so the kit ships two standalone files rather than one with a
hidden gap. `apps/web/tests/config/wrangler-parity.test.ts` enforces the table below; it runs in every
`pnpm test` and in `deploy.yml` with `REQUIRE_PROVISIONED=1`, which additionally forbids any
`<PLACEHOLDER>` value (PR CI stays green on an unprovisioned copy; a deploy cannot proceed with one).

| Must **differ** | Production | Staging |
|---|---|---|
| `name` | `<app>` | `<app>-staging` |
| `routes[].pattern` (custom domain) | app host | staging host |
| `workers_dev` | unset | `true` acceptable as fallback host |
| `[vars] APP_ENV`, `APP_URL` | `production`, `https://<app host>` | `staging`, `https://<staging host>` |
| `hyperdrive[].id`, `kv_namespaces[].id` | env's ids | env's ids |
| `queues.*.queue`, `workflows[].name`, `r2_buckets[].bucket_name`, `analytics_engine_datasets[].dataset` | `<app>-jobs`, `<app>-agent-run`, `<app>-files`, `<app>_analytics` | same + `-staging` / `_staging` |

| Must be **identical** | Why |
|---|---|
| `main`, `compatibility_date`, `compatibility_flags = ["nodejs_compat"]` | same runtime semantics |
| every `binding` name, every DO `class_name`, `[[migrations]]` | application code never branches on environment |
| `[limits]` (present in both or neither) | Workflows bound CPU per step by it — see below |
| `[triggers].crons` | the dispatcher table in `scheduled.ts` is one file |
| `[assets]`, `[placement]`, `[observability]` | same SPA, same placement, same logging |
| `[vars]` **keys** (values may differ) | `loadConfig` validates one schema |

`localConnectionString` is dev-only and is the same in both files (one local database).

## Resources per environment

| Resource | Binding | Name (prod / staging) | Create |
|---|---|---|---|
| Hyperdrive | `HYPERDRIVE` | `<app>-production` / `<app>-staging` | `pnpm --filter @rocketflare/web exec wrangler hyperdrive create <name> --connection-string="<direct neon url>"` → `id` |
| KV | `RATE_LIMIT_KV` | `<APP>_RATE_LIMIT` / `<APP>_RATE_LIMIT_STAGING` | `pnpm --filter @rocketflare/web exec wrangler kv namespace create <name>` → `id` |
| Queue (Phase 2) | `JOBS_QUEUE` | `<app>-jobs` / `<app>-jobs-staging` | `pnpm --filter @rocketflare/web exec wrangler queues create <name>` (name-referenced) |
| R2 (Phase 2) | `FILES` | `<app>-files` / `<app>-files-staging` | `pnpm --filter @rocketflare/web exec wrangler r2 bucket create <name>` |
| Durable Object (Phase 2) | `NOTIFICATIONS_HUB` | class `NotificationsHub` | declared in toml + `[[migrations]] tag = "v1", new_classes` — no create step |
| Workflow (Phase 3, built) | `AGENT_RUN_WORKFLOW` | `<app>-agent-run` / `<app>-agent-run-staging` | `[[workflows]] name / binding / class_name = "AgentRunWorkflow"` — `wrangler deploy` registers it, no create step; **account-scoped name** |
| Workers AI (Phase 3, built) | `AI` | — | `[ai] binding = "AI"` — no resource; embeddings default (`@cf/baai/bge-m3`); billed per call, `wrangler dev` proxies to the account |
| Analytics (Phase 4, built) | — | — | **no resource and no binding**: cubes read through `HYPERDRIVE`, fact tables rebuild on the `15 * * * *` cron (below); `/cubejs-api` + `/mcp` are routes of this Worker |
| Analytics Engine (optional) | `ANALYTICS_ENGINE` | `<app>_analytics[_staging]` | declared in toml — deliberately NOT wired by the kit (only a comment in both tomls) |
| Static Assets | `ASSETS` | — | `[assets] directory = "./dist/ui"` uploaded atomically with each deploy |
| RLS app role (optional, docs/RLS.md) | `HYPERDRIVE_APP` | `<app>-<env>-app` | `… hyperdrive create … --caching-disabled` |

`pnpm provision <staging|production> [app]` (root script → `apps/web/scripts/cf-provision.sh`, which
`cd`s to `apps/web` itself so it also works as `bash apps/web/scripts/cf-provision.sh …`) runs the
Hyperdrive and KV steps (the Queue/R2 create blocks are still commented in the script although both
tomls now declare `JOBS_QUEUE` and `FILES` — uncomment them, or run the two `create` commands from
the table above by hand, before the first Phase 2 deploy), reuses existing resources by name,
and prints the ids with a `sed` line per toml. It needs `NEON_DATABASE_URL` (direct host) and an
authenticated wrangler; it never writes files.

## Crons

`[triggers] crons` must be identical in both tomls (parity test); `apps/web/src/api/scheduled.ts`
`SCHEDULED_TASKS` is the dispatcher, keyed on the exact expression.

| Expression | Task | What it does | Local trigger (`wrangler dev` never fires crons itself) |
|---|---|---|---|
| `0 4 * * *` | `pruneExpired` | deletes expired sessions, consumed/expired magic links, invitations older than 30 days | `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=0+4+*+*+*"` |
| `15 * * * *` | `refreshFactTables` (D19) | every `FACT_TABLES` entry, per tenant, DELETE+INSERT in one transaction; per-tenant failures collected, logged as a warning, never abort the run | `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=15+*+*+*+*"` — or the same code without the Worker: `pnpm web db:refresh-facts [table] [--tenant=<uuid>]` |

Health of the fact tables: `GET /api/analytics/facts/status` (admin+; `stale` = newest source row
has waited > 2× the table's interval) or `pnpm web db:check-facts` (exit 1 when stale; needs
`DATABASE_URL` — in a deployed environment run it with that branch's connection string, never by
pointing `.dev.vars` at Neon). Cron runs share the Worker's CPU budget: past a few hundred tenants,
fan the per-tenant rebuilds out through `JOBS_QUEUE`.

## Account-scoped names — the incident this guards against

Workflow names are unique **per Cloudflare account**, not per Worker. Whichever script last deployed
a given name owns it, and every instance created under that name — including instances created by
the *other* environment's binding — runs with the owning script's bindings, against the owning
script's database. In one of the source applications, staging and production briefly shared a
Workflow name: the production API created a run and started an instance, the instance executed under
the staging worker against the staging database, and production was left with a `pending` row and a
UI stuck on its last progress event. Nothing errored. Queue, R2 and Analytics Engine names are
account-scoped too. Hence: every such name in `wrangler.staging.toml` ends in `-staging`, `binding`
and `class_name` stay identical, and the parity test refuses a collision.
`pnpm --filter @rocketflare/web exec wrangler workflows list` shows Name → Script name if you suspect one.

## `[limits] cpu_ms` — per step, both files or neither

Workflows bound CPU **per `step.do`** by the script's `cpu_ms` — 30 s default, up to 300 s on Paid.
CPU is not wall clock: a step that is almost entirely I/O still dies if it *processes* enough items
(items × per-item cost). The same source app lost a long ingest step to the 30 s default after 16
minutes of wall time, and separately had `[limits]` present in only one toml, so the same class died
in one environment and nowhere else. The kit ships `[limits]` commented out (default 30 s); raise it
in **both** files, and split a heavy phase into its own step to draw a fresh budget. Isolate memory
(128 MiB) is not configurable — page through large tables.

## Secrets model

| Kind | Where | Examples |
|---|---|---|
| Non-secret config | `[vars]` in each toml (committed) | `APP_ENV`, `APP_URL`, `APP_NAME`, `RELEASE_VERSION`, `LOG_LEVEL`, `EMAIL_FROM`, `TENANCY_MODE`, `SIGNUP_MODE`, `TENANT_SCOPE_MODE`, `AGENT_MAX_OUTPUT_TOKENS` (16384), `AGENT_MAX_TURNS` (30). Defaulted in `config.ts` and **not** declared in the tomls: `LANGFUSE_BASE_URL` (`https://cloud.langfuse.com`), `LANGFUSE_TRACING_ENVIRONMENT` (= `APP_ENV`) — to override, add the key to BOTH files (the parity test compares `[vars]` keys) |
| Worker secrets | `pnpm --filter @rocketflare/web exec wrangler secret put <NAME> [-c wrangler.staging.toml]`, once per worker; locally `apps/web/.dev.vars` | `OAUTH_ENCRYPTION_KEY` (also encrypts tenant AI keys — rotating it invalidates every `ai_configs` credential), `AUTH_SIGNING_KEY`, `BOOTSTRAP_ADMIN_EMAILS`, `RESEND_API_KEY`, `GOOGLE_*`, `MICROSOFT_*`; AI, all optional: `ANTHROPIC_API_KEY` (platform chat), `EMBEDDINGS_API_KEY` (platform OpenAI embeddings when no `AI` binding), `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (both or tracing is off); `DATABASE_URL` only as a no-Hyperdrive fallback |
| CI secrets | GitHub Environments `staging` / `production` | `DATABASE_URL` (that branch), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Scripts only | migration environment | `APP_DATABASE_URL` (db-roles, RLS enforce only) |
| Developer-local only | `apps/web/.drizzle-cube.json` (git-ignored; copy `.drizzle-cube.json.example`) | a **tenant API key** for the drizzle-cube CLI / Claude Code plugin against `/cubejs-api` — it is an ordinary key from Settings → API keys, scopes every query to that tenant, and is revoked there; never deployed, never committed |
| Resource ids | tomls (committed) | Hyperdrive / KV ids — not secrets |

`wrangler secret put` (run in `apps/web`) requires the worker to exist: the first deploy of a fresh environment runs via
`workflow_dispatch` and 500s until the secrets are set. Use different key material per environment.
The worker never receives `DATABASE_URL` in deployed environments — it uses `HYPERDRIVE`.

## Neon: project, branches, Hyperdrive host

- **One project, a branch per environment** (`production` = main, `staging`), plus a dedicated role
  per branch. Branches are cheap and share compute quota; separate projects give separate quotas and
  credentials — choose projects if the environments must be blast-radius isolated. A shared role
  across branches means one leaked string is every environment's string; don't.
- **Hyperdrive points at the DIRECT host** (`ep-….<region>.aws.neon.tech`), not `-pooler`. Hyperdrive
  is itself a pooler; stacking it on Neon's PgBouncer adds a hop and a second transaction-mode
  layer with nothing to gain.
- **Migrations use the direct host too.** `apps/web/scripts/migrate.ts` strips `-pooler` from any Neon host it
  is given, so the CI `DATABASE_URL` secret may be either form. A pooled backend can carry a stale
  `default_transaction_read_only` GUC that blocks DDL; the source app hit exactly that.
- `apps/web/scripts/db-roles.ts` (RLS role) also needs the direct host — `ALTER DEFAULT PRIVILEGES` and `CREATE ROLE`
  are session-level DDL.
- Tests never use Neon (`safetyCheck` requires `localhost`). `PREVIEW_DATABASE_URL` is an inert hook
  for per-PR Neon branches if previews are ever reinstated.

## CI/CD flow

All steps run at the repository root; the root scripts fan out with `pnpm -r` / `--filter`, so no
`working-directory` is set anywhere.

```
 pull_request ──► ci.yml (root): pnpm install --frozen-lockfile → gitleaks → pnpm lint → pnpm typecheck
                        → git diff --exit-code apps/web/worker-configuration.d.ts → pnpm test (pg 5433; web + cli)
                        → pnpm build (web: vite + dry-run wrangler deploy; cli: tsc → dist/cli.js)
                                                                                                            │
 push tag X.Y.Z ──► deploy.yml ─► ci (workflow_call, same file) ─► staging job (environment: staging)
                                     tag == ROOT package.json version?
                                     → REQUIRE_PROVISIONED=1 pnpm --filter @rocketflare/web test:config
                                     → pnpm db:migrate:ci (staging DATABASE_URL) → pnpm --filter @rocketflare/web build:ui
                                     → pnpm --filter @rocketflare/web exec wrangler deploy -c wrangler.staging.toml --var RELEASE_VERSION:X.Y.Z
                                                                                    │
                                                              verify on staging: /api/health, nav version
                                                                                    │
 gh release create X.Y.Z ──► deploy.yml ─► production job (environment: production, checkout the release tag)
                                     tag == ROOT version? → REQUIRE_PROVISIONED=1 test:config → db:migrate:ci (production)
                                     → build:ui → pnpm --filter @rocketflare/web exec wrangler deploy --var RELEASE_VERSION:X.Y.Z

 workflow_dispatch(environment) ──► either job from the dispatched ref (first deploy; emergencies)
```

**Bundle size expectations.** `pnpm build` (`build:api` = `wrangler deploy --dry-run --outdir dist/api`)
produces `dist/api/worker.js` at **≈ 1265 KiB gzip / ≈ 5.6 MB raw** since Phase 4 (≈ 308 KiB before).
The growth is drizzle-cube's Hono adapter statically importing its MCP transport (≈ 2.1 MB raw: MCP
SDK + inlined chart rendering) even with MCP disabled — not the kit shipping React to the Worker.
Under the Workers script limit (3 MiB gzip free / higher on Paid, which Hyperdrive needs anyway). If a
deploy is refused for size, look at new `src/api` dependencies first (`gzip -c
apps/web/dist/api/worker.js | wc -c`); the structural fix is upstream or a thin adapter over
`drizzle-cube/server` (`.claude/rules/cloudflare.md`). UI: main chunk ≈ 114 KiB gzip; chat ≈ 54 KiB;
the analytics chunk (drizzle-cube client + recharts + d3) is the largest and lazy — it must never
merge into the main chunk.

**Version rule.** The git tag must equal `version` in the **root** `package.json`; the job fails
otherwise. One tag ships `apps/web` and `apps/cli` together — the `apps/*` and `packages/*` versions
are informational and are not checked. Bump the root version, commit, tag.

Publishing the Release is the promotion gate (required reviewers are unavailable on private repos
on the free plan; add them to the `production` environment if the plan allows). Production does not
re-run the CI gate: it ships the tag staging validated. `RELEASE_VERSION` is a `[vars]` override at
deploy time, surfaced by `/auth/session`, the nav footer and `rocketflare status`. Local
`pnpm deploy[:staging]` (root → `apps/web`: `build:ui` + `wrangler deploy`) exist as escape hatches;
CI is the path. `wrangler deploy` always runs with `apps/web` as cwd so `[assets] directory =
"./dist/ui"` resolves — never call it from the root.

## Cloudflare API token scopes (CI token, account scope)

Workers Scripts · Workers KV Storage · Queues · Workflows · Durable Objects · Hyperdrive · R2 —
**Edit**. Workers AI · Account Analytics — **Read** (if used). Zone → DNS — **Edit** on the zone
holding the custom domains. One token may serve both environments.

## Observability

- `[observability.logs] enabled = true, head_sampling_rate = 1, invocation_logs = false` in both
  files: structured `console`/pino output is retained in the Workers Logs dashboard; invocation
  logs are off to keep the volume to what the app emits.
- `pnpm --filter @rocketflare/web exec wrangler tail [-c wrangler.staging.toml] [--format pretty]` streams live logs;
  `--status error` filters.
- `pnpm --filter @rocketflare/web exec wrangler deployments list`, `… wrangler workflows instances list <name>`,
  `… wrangler queues info <name>` for the async parts.
- Langfuse traces (when both keys are set) for every LLM call — one trace per chat turn (`chat`,
  session = conversation id) or agent run (`summarize-text`, session = run id), one `generation` per
  model call with token usage, tagged `environment = LANGFUSE_TRACING_ENVIRONMENT ?? APP_ENV`; batched
  and shipped from `waitUntil`, never on the response path. `ai_usage` in Postgres is the durable
  token ledger regardless of tracing. `ANALYTICS_ENGINE` request metrics are optional and
  fire-and-forget.
- Agent runs: `… wrangler workflows instances list rocketflare-agent-run[-staging]` / `describe <name>
  <runId>` (instance id = `agent_runs.id`). A row stuck `queued`/`running` whose instance is gone is
  settled on the next `GET /api/agents/runs/:id` (reconcile-on-read); there is no sweeper cron.

## Rollback

| Situation | Action |
|---|---|
| Bad Worker version, schema unchanged | `pnpm --filter @rocketflare/web exec wrangler rollback [-c wrangler.staging.toml]` — previous version, seconds. Or `wrangler rollback <version-id>` from `deployments list` |
| Need a specific earlier tag | Actions → Deploy → `production` from that tag, or publish a Release on the earlier tag |
| Schema migration must be undone | migrations are forward-only: write a compensating migration, tag, and run the dance. `wrangler rollback` does not touch the database |
| RLS enforce misbehaving | `TENANT_SCOPE_MODE = "off"` in `[vars]` and redeploy — no migration (docs/RLS.md) |
| A Workflow hijacked by a name collision | fix the staging name, redeploy **both** workers (last deployer owns the name); stuck `agent_runs` rows settle on read (`GET /api/agents/runs/:id` → `reconcileRun` → `instance.status()`; `not_found` marks them `failed`) |
| Fact tables stale or wrong after a deploy | `GET /api/analytics/facts/status` says which; fire the `15 * * * *` cron or run `refresh-fact-tables.ts` with that environment's `DATABASE_URL`. Rows are derived data — a rebuild is always safe; a schema change to a fact table is a normal forward migration followed by one rebuild |
| A dashboard renders empty / errors after a cube change | a cube member referenced by stored `analytics_pages.config` was renamed or removed — restore the member (names are frozen) or, per tenant, `POST /api/analytics/templates/recreate` (admin+) to re-copy the templates; user-created pages need a manual edit |
| Tenant AI keys unreadable after rotating `OAUTH_ENCRYPTION_KEY` | there is no re-encrypt path: admins re-enter the key in Settings → AI (the row keeps its label/model, `hasCredential` flips back); the platform `ANTHROPIC_API_KEY` is unaffected |

Verify any rollback with `/auth/session` (`releaseVersion`), `rocketflare status` and `wrangler tail`.

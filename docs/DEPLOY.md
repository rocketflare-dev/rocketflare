# DEPLOY — Cloudflare topology reference

What runs where, what the two wrangler files may and may not differ in, how resources are created,
how a release moves, and how it comes back. Procedure lives in `SETUP.md` Part 3; this is the
reference it points at.

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
                      │                      │
              Hyperdrive <app>-staging   Hyperdrive <app>-production      (direct Neon host)
                      │                      │
              Neon branch `staging`      Neon branch `production` (main)  one project, role per branch
```

Workers Paid plan is required (Hyperdrive, Workflows, `[limits]`). Smart Placement runs the Worker
near Neon rather than near the user, which is what makes sequential queries cheap.

## Wrangler anatomy — two files, one shape (D6)

`[env.*]` does not inherit bindings, so the kit ships two standalone files rather than one with a
hidden gap. `tests/config/wrangler-parity.test.ts` enforces the table below; it runs in every
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
| Hyperdrive | `HYPERDRIVE` | `<app>-production` / `<app>-staging` | `pnpm exec wrangler hyperdrive create <name> --connection-string="<direct neon url>"` → `id` |
| KV | `RATE_LIMIT_KV` | `<APP>_RATE_LIMIT` / `<APP>_RATE_LIMIT_STAGING` | `pnpm exec wrangler kv namespace create <name>` → `id` |
| Queue (Phase 2) | `JOBS_QUEUE` | `<app>-jobs` / `<app>-jobs-staging` | `pnpm exec wrangler queues create <name>` (name-referenced) |
| R2 (Phase 2) | `FILES` | `<app>-files` / `<app>-files-staging` | `pnpm exec wrangler r2 bucket create <name>` |
| Durable Object (Phase 2) | `NOTIFICATIONS_HUB` | class `NotificationsHub` | declared in toml + `[[migrations]] tag = "v1", new_classes` — no create step |
| Workflow (Phase 3) | `AGENT_RUN_WORKFLOW` | `<app>-agent-run` / `<app>-agent-run-staging` | declared in toml — no create step; **account-scoped** |
| Workers AI (Phase 3) | `AI` | — | `[ai] binding = "AI"` |
| Analytics Engine (optional) | `ANALYTICS_ENGINE` | `<app>_analytics[_staging]` | declared in toml |
| Static Assets | `ASSETS` | — | `[assets] directory = "./dist/ui"` uploaded atomically with each deploy |
| RLS app role (optional, docs/RLS.md) | `HYPERDRIVE_APP` | `<app>-<env>-app` | `… hyperdrive create … --caching-disabled` |

`scripts/cf-provision.sh <staging|production> [app]` runs the Hyperdrive and KV steps (Queue/R2 are
commented until Phase 2), reuses existing resources by name, and prints the ids with a `sed` line per
toml. It needs `NEON_DATABASE_URL` (direct host) and an authenticated wrangler; it never writes files.

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
`pnpm exec wrangler workflows list` shows Name → Script name if you suspect one.

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
| Non-secret config | `[vars]` in each toml (committed) | `APP_ENV`, `APP_URL`, `APP_NAME`, `RELEASE_VERSION`, `LOG_LEVEL`, `EMAIL_FROM`, `TENANCY_MODE`, `SIGNUP_MODE`, `TENANT_SCOPE_MODE`, `LANGFUSE_BASE_URL`, `AGENT_MAX_*` |
| Worker secrets | `wrangler secret put <NAME> [-c wrangler.staging.toml]`, once per worker; locally `.dev.vars` | `OAUTH_ENCRYPTION_KEY`, `AUTH_SIGNING_KEY`, `BOOTSTRAP_ADMIN_EMAILS`, `RESEND_API_KEY`, `GOOGLE_*`, `MICROSOFT_*`, `ANTHROPIC_API_KEY`, `EMBEDDINGS_API_KEY`, `LANGFUSE_PUBLIC_KEY/SECRET_KEY`, `DATABASE_URL` only as a no-Hyperdrive fallback |
| CI secrets | GitHub Environments `staging` / `production` | `DATABASE_URL` (that branch), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Scripts only | migration environment | `APP_DATABASE_URL` (db-roles, RLS enforce only) |
| Resource ids | tomls (committed) | Hyperdrive / KV ids — not secrets |

`wrangler secret put` requires the worker to exist: the first deploy of a fresh environment runs via
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
- **Migrations use the direct host too.** `scripts/migrate.ts` strips `-pooler` from any Neon host it
  is given, so the CI `DATABASE_URL` secret may be either form. A pooled backend can carry a stale
  `default_transaction_read_only` GUC that blocks DDL; the source app hit exactly that.
- `db-roles.ts` (RLS role) also needs the direct host — `ALTER DEFAULT PRIVILEGES` and `CREATE ROLE`
  are session-level DDL.
- Tests never use Neon (`safetyCheck` requires `localhost`). `PREVIEW_DATABASE_URL` is an inert hook
  for per-PR Neon branches if previews are ever reinstated.

## CI/CD flow

```
 pull_request ──► ci.yml: pnpm install → gitleaks → lint → typecheck (+ typegen diff) → test (pg 5433) → build:ui → build:api
                                                                                                            │
 push tag X.Y.Z ──► deploy.yml ─► ci (workflow_call, same file) ─► staging job (environment: staging)
                                     tag == package.json version?  → REQUIRE_PROVISIONED=1 test:config
                                     → db:migrate:ci (staging DATABASE_URL) → build:ui
                                     → wrangler deploy -c wrangler.staging.toml --var RELEASE_VERSION:X.Y.Z
                                                                                    │
                                                              verify on staging: /api/health, nav version
                                                                                    │
 gh release create X.Y.Z ──► deploy.yml ─► production job (environment: production, checkout the release tag)
                                     tag == version? → REQUIRE_PROVISIONED=1 test:config → db:migrate:ci (production)
                                     → build:ui → wrangler deploy --var RELEASE_VERSION:X.Y.Z

 workflow_dispatch(environment) ──► either job from the dispatched ref (first deploy; emergencies)
```

Publishing the Release is the promotion gate (required reviewers are unavailable on private repos
on the free plan; add them to the `production` environment if the plan allows). Production does not
re-run the CI gate: it ships the tag staging validated. `RELEASE_VERSION` is a `[vars]` override at
deploy time, surfaced by `/auth/session` and the nav footer. Local `pnpm deploy[:staging]` exist as
escape hatches; CI is the path.

## Cloudflare API token scopes (CI token, account scope)

Workers Scripts · Workers KV Storage · Queues · Workflows · Durable Objects · Hyperdrive · R2 —
**Edit**. Workers AI · Account Analytics — **Read** (if used). Zone → DNS — **Edit** on the zone
holding the custom domains. One token may serve both environments.

## Observability

- `[observability.logs] enabled = true, head_sampling_rate = 1, invocation_logs = false` in both
  files: structured `console`/pino output is retained in the Workers Logs dashboard; invocation
  logs are off to keep the volume to what the app emits.
- `pnpm exec wrangler tail [-c wrangler.staging.toml] [--format pretty]` streams live logs;
  `--status error` filters.
- `pnpm exec wrangler deployments list`, `wrangler workflows instances list <name>`,
  `wrangler queues info <name>` for the async parts.
- Langfuse traces (when keys are set) for every LLM call; `ANALYTICS_ENGINE` request metrics are
  optional and fire-and-forget.

## Rollback

| Situation | Action |
|---|---|
| Bad Worker version, schema unchanged | `pnpm exec wrangler rollback [-c wrangler.staging.toml]` — previous version, seconds. Or `wrangler rollback <version-id>` from `deployments list` |
| Need a specific earlier tag | Actions → Deploy → `production` from that tag, or publish a Release on the earlier tag |
| Schema migration must be undone | migrations are forward-only: write a compensating migration, tag, and run the dance. `wrangler rollback` does not touch the database |
| RLS enforce misbehaving | `TENANT_SCOPE_MODE = "off"` in `[vars]` and redeploy — no migration (docs/RLS.md) |
| A Workflow hijacked by a name collision | fix the staging name, redeploy **both** workers (last deployer owns the name), reconcile stuck rows via the status route's `instance.status()` check |

Verify any rollback with `/auth/session` (`releaseVersion`) and `wrangler tail`.

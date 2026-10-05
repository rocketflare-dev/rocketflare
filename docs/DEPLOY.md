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
   bindings:  RATE_LIMIT_KV  [JOBS_QUEUE  FILES  AGENT_RUN_WORKFLOW  AI]  ASSETS  (+ HYPERDRIVE under postgres)
   crons:     0 4 * * * (prune)  + every installed plugin's       routes: /api /auth /ws + plugins'
                      │                      │
   neon:      DATABASE_URL secret        DATABASE_URL secret              (pooled Neon host, HTTPS + WS)
   postgres:  Hyperdrive <app>-staging   Hyperdrive <app>-production      (direct host, any Postgres)
                      │                      │
              Neon branch `staging`      Neon branch `production` (main)  one project, role per branch
```

The database path is per deployment (`DATABASE_DRIVER`, D35 — § Database driver below). Workers Paid
plan is required (Workflows, `[limits]`, and Hyperdrive under `postgres`) — Hyperdrive's plan
availability has changed over time; under `postgres` the create step (`cf-provision.sh`) reports if
the plan refuses it, with the upgrade URL. The account also holds your domain as a zone (registered there, or its nameservers
moved): the custom-domain `routes` and the Resend DNS records are created in it and `pnpm provision
preflight` proves it exists — without one, both hosts are `workers.dev` and email is skipped.
Smart Placement runs the Worker
near Neon rather than near the user, which is what makes sequential queries cheap.

## Database driver (D35)

`[vars] DATABASE_DRIVER` in each toml picks how the Worker reaches Postgres. **A toml with no
`DATABASE_DRIVER` means `postgres`** — every copy from before 0.15.0 — and the kit's own tomls say
`"neon"`, so a fresh copy deploys on Neon. Locally `apps/web/.dev.vars` overrides it (the bootstrap
writes `DATABASE_DRIVER=postgres`), so development never needs the deployed driver.

| | `neon` | `postgres` |
|---|---|---|
| Driver | Neon serverless: neon-http per query, a WebSocket `Pool` per transaction | postgres.js |
| Reaches | Neon only, over HTTPS / WebSocket | any Postgres, through Hyperdrive |
| Worker holds | the `DATABASE_URL` secret — the **pooled** Neon URI | the `[[hyperdrive]]` binding (direct host) |
| `[[hyperdrive]]` block | **absent** — wrangler refuses a deploy naming an id that does not exist | present in BOTH tomls |
| Read cache | none | Hyperdrive's (60 s default) |
| Hyperdrive configs used (25 per account) | none | one per environment |

**Choosing.** Neon, and especially many apps in one account (a fleet) or a sandbox with no TCP out →
`neon`. Any other Postgres (RDS, Supabase, Crunchy, self-hosted), or one app that wants Hyperdrive's
read cache → `postgres`. `pnpm provision` reads the toml and `--driver neon|postgres` switches:
`pnpm provision cloudflare <env> --driver <d>` rewrites BOTH tomls (the var, and the
`[[hyperdrive]]` block added or removed), because the parity test wants the block in both or neither.

**Three `DATABASE_URL`s, one name.** The Worker secret (`neon` only: the pooled URI, written by
`pnpm provision secrets|deploy <env>`), the GitHub Environment secret (the DIRECT host, for
`db:migrate:ci` — any driver) and `.dev.vars` (the local database). Same name, different stores;
none of them is ever the other.

**Switching a live deployment `postgres` → `neon`**, one environment at a time, staging first:

1. `NEON_API_KEY=… pnpm provision secrets <env> --driver neon` (or `wrangler secret put
   DATABASE_URL` with the pooled URI). A `postgres` Worker ignores the secret, so this is safe first.
2. `pnpm provision cloudflare <env> --driver neon` — `DATABASE_DRIVER = "neon"` and no
   `[[hyperdrive]]` block, in both tomls. Commit.
3. Run the whole suite under `neon` once — `GATE_SUITE_DRIVER=neon pnpm gate test` (every gate
   already runs the `driver` conformance project under both drivers; this runs the rest too) —
   then deploy staging, check `/api/ready`, compare p95 with the Hyperdrive baseline, then
   production.
4. **Keep the Hyperdrive configs for about a week**: `wrangler rollback` to a `postgres` version
   restores its `HYPERDRIVE` binding and needs the config to still exist. Deleting them is a
   separate cleanup, never part of the switch.

`neon` → `postgres` is `pnpm provision cloudflare <env> --driver postgres` (creates the Hyperdrive
config, writes the block and the var into both tomls), commit, deploy. The Worker's `DATABASE_URL`
secret can stay; `postgres` reads it only when there is no binding.

## Wrangler anatomy — two files, one shape (D6)

`[env.*]` does not inherit bindings, so the kit ships two standalone files rather than one with a
hidden gap. `apps/web/tests/config/wrangler-parity.test.ts` enforces the table below; it runs in every
`pnpm test` and in `deploy.yml` with `REQUIRE_PROVISIONED=1`, which additionally forbids any
`<PLACEHOLDER>` value (CI on main stays green on an unprovisioned copy; a deploy cannot proceed with one).

| Must **differ** | Production | Staging |
|---|---|---|
| `name` | `<app>` | `<app>-staging` |
| `routes[].pattern` (custom domain) | app host | staging host |
| `workers_dev` | unset | `true` acceptable as fallback host |
| `[vars] APP_ENV`, `APP_URL` | `production`, `https://<app host>` | `staging`, `https://<staging host>` |
| `hyperdrive[].id` (under `postgres`), `kv_namespaces[].id` | env's ids | env's ids |
| `queues.*.queue`, `workflows[].name`, `r2_buckets[].bucket_name`, `analytics_engine_datasets[].dataset` | `<app>-jobs`, `<app>-agent-run`, `<app>-files`, `<app>_analytics` | same + `-staging` / `_staging` |

| Must be **identical** | Why |
|---|---|
| `main`, `compatibility_date`, `compatibility_flags = ["nodejs_compat"]` | same runtime semantics |
| every `binding` name, every DO `class_name`, `[[migrations]]` | application code never branches on environment |
| `[limits]` (present in both or neither) | Workflows bound CPU per step by it — see below |
| `[triggers].crons` | the dispatcher table in `scheduled.ts` is one file |
| `[assets]` (incl. `run_worker_first`), `[placement]`, `[observability]` | same SPA, same placement, same logging. `run_worker_first` must list every prefix the Worker owns: the asset router runs BEFORE the Worker and `single-page-application` answers any NAVIGATION with `index.html` without invoking `fetch` — and an `<object>` embed or an `<a download>` click is a navigation, so a missing prefix silently serves the app shell for those (`wrangler-parity.test.ts` asserts it mirrors `API_PREFIXES`) |
| `[vars]` **keys** (values may differ) | `loadConfig` validates one schema. `DATABASE_DRIVER` is a value, so staging may switch driver before production |
| `[[hyperdrive]]` present in both or neither | it exists only under `postgres` (D35) |

`localConnectionString` (in the `[[hyperdrive]]` block, `postgres` only) is dev-only and is the same
in both files (one local database).

## Resources per environment

| Resource | Binding | Name (prod / staging) | Create |
|---|---|---|---|
| Hyperdrive (`postgres` only) | `HYPERDRIVE` | `<app>-production` / `<app>-staging` | `pnpm --filter @rocketflare/web exec wrangler hyperdrive create <name> --connection-string="<direct neon url>"` → `id` |
| KV | `RATE_LIMIT_KV` | `<APP>_RATE_LIMIT` / `<APP>_RATE_LIMIT_STAGING` | `pnpm --filter @rocketflare/web exec wrangler kv namespace create <name>` → `id` |
| Queue (Phase 2) | `JOBS_QUEUE` | `<app>-jobs` / `<app>-jobs-staging` | `pnpm --filter @rocketflare/web exec wrangler queues create <name>` (name-referenced) |
| R2 (Phase 2) | `FILES` | `<app>-files` / `<app>-files-staging` | `pnpm --filter @rocketflare/web exec wrangler r2 bucket create <name>` |
| Durable Object (Phase 2) | `NOTIFICATIONS_HUB` | class `NotificationsHub` | declared in toml + `[[migrations]] tag = "v1", new_classes` — no create step |
| Workflow (Phase 3, built) | `AGENT_RUN_WORKFLOW` | `<app>-agent-run` / `<app>-agent-run-staging` | `[[workflows]] name / binding / class_name = "AgentRunWorkflow"` — `wrangler deploy` registers it, no create step; **account-scoped name** |
| Workers AI (Phase 3, built) | `AI` | — | `[ai] binding = "AI"` — no resource; the zero-key floor for chat (`@cf/zai-org/glm-4.7-flash`) and embeddings (`@cf/baai/bge-m3`); **billed per call to this account** (10k free neurons/day), `wrangler dev` proxies to the logged-in account; remove from BOTH tomls for zero-spend |
| Analytics (a PLUGIN, D31) | — | — | **no resource and no binding**: its cubes read through the request's database handle (either driver), its fact tables rebuild on the `15 * * * *` cron it declares, and `/cubejs-api` + `/mcp` are routes of this Worker. Installing it means adding that cron and those two prefixes to BOTH tomls — `pnpm provision cloudflare <env>` reads them off the installed surface and writes them (decision 12) |
| Analytics Engine (optional) | `ANALYTICS_ENGINE` | `<app>_analytics[_staging]` | declared in toml — deliberately NOT wired by the kit (only a comment in both tomls) |
| Static Assets | `ASSETS` | — | `[assets] directory = "./dist/ui"` uploaded atomically with each deploy; `run_worker_first` keeps `/api`, `/auth`, `/ws` — and every prefix an installed plugin declares — off the asset router |
| RLS app role (optional, docs/RLS.md, not wired yet) | `postgres`: `HYPERDRIVE_APP`; `neon`: an `APP_DATABASE_URL` Worker secret | `<app>-<env>-app` | `postgres`: `… hyperdrive create … --caching-disabled`; `neon`: `wrangler secret put APP_DATABASE_URL` |
| Plugin resources (D31) | whatever the plugin's `plugin.json` declares (`APPROVALS_CACHE`…) | `<app>-<id>-<name>[-staging]`, and `<APP>_<ID>_<NAME>[_STAGING]` for KV | `pnpm provision cloudflare <env>` — it reads each installed plugin's `bindings[]`, creates the `kv`/`queue`/`r2` ones through `cf-provision.sh` and patches every block into BOTH tomls |
| Plugin Workflow / Durable Object (D31) | whatever the plugin declares (`ORDERS_SYNC`, `ORDERS_HUB`…) | workflow `<app>-<id>-<name>[-staging]`; a DO binding has no account-scoped name | **no create step** — `pnpm provision cloudflare <env>` writes `[[workflows]]` / `[[durable_objects.bindings]]` (+ a `plugin-<id>-v1` `[[migrations]]` tag) into both tomls and `wrangler deploy` registers them. The `class_name` resolves through the sixth barrel, `apps/web/src/plugins/worker-exports.ts` |

`pnpm web provision:cloudflare <staging|production> [app] [--apply] [--force]` (the `apps/web`
script → `scripts/cf-provision.sh`, which `cd`s to `apps/web` itself so it also works as
`bash apps/web/scripts/cf-provision.sh …`) creates a RESOURCE LIST idempotently — the kit's own
ones, KV, Queue and R2 (plus Hyperdrive when `DATABASE_DRIVER` — from the environment, else the
toml — is `postgres`), are the default list, each found by name and reused when it exists, and `PLUGIN_RESOURCES` (a JSON array of `{ type, name, binding }`, set by
`pnpm provision cloudflare <env>` from the installed plugins' manifests) appends to it — and either
prints the Hyperdrive/KV ids
with a `sed` line per toml, or with `--apply` writes them into that toml through
`scripts/provision/patch-toml.ts` (a DIFFERENT existing id is refused unless `--force`). Under `postgres` it needs
`NEON_DATABASE_URL` (direct host); both drivers need an authenticated wrangler (`wrangler login`, or
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`); the connection string is an argument of the one
`wrangler hyperdrive create` process and is redacted from every echoed line.
**Plugin resources (D31, Decision 12).** A plugin ships no toml — the two files are the host's,
always — so its `plugin.json` DECLARES what the account has to provide and `pnpm provision
cloudflare <env>` applies it. `scripts/provision/plugin-resources.ts` owns the naming rule
(`<app>-<id>-<name>[-staging]` for a queue, bucket or Workflow, `<APP>_<ID>_<NAME>[_STAGING]` for a
KV namespace, mirroring the kit's own `<APP>_RATE_LIMIT[_STAGING]`) and the refusal: a `type`
outside `kv | queue | r2 | workflow | durable_object` names itself in the error rather than being
skipped, because a binding quietly not created is a Worker that deploys and then 503s.

**Two of those five are declared rather than created.** `workflow` and `durable_object` need no
`wrangler … create`: the block in the toml is the whole registration, and `wrangler deploy` does
the rest. They are writable at all only because of the sixth barrel (D31) — a `class_name` resolves
against the named exports of `src/worker.ts`, so until `apps/web/src/plugins/worker-exports.ts`
made a plugin's class reachable there without anyone editing the entry module, either block would
have named a class nothing exported, and `wrangler deploy` refuses the whole script for that.
`d1`, `vectorize` and `analytics_engine` have no such mechanism and stay refused. `hyperdrive` is
deliberately not offered — the host owns the one database.

A `durable_object` binding also brings a `[[migrations]]` entry, tagged `plugin-<id>-v1` and
carrying `new_sqlite_classes` or `new_classes` according to the plugin's declared `storage` (which
is required, because a namespace cannot be migrated between the two). **Those tags are append-only
and host-owned**, exactly as the SQL migrations are: a tag is the record of what this Worker has
already told Cloudflare, so it is never renumbered and never rewritten. Removing the plugin takes
the next free `plugin-<id>-v<n>` with `deleted_classes` — and that one is a HUMAN step, because it
destroys the namespace and everything stored in it.

The phase writes the DECLARATIONS into **both** tomls first (the binding block with a
`<PLACEHOLDER>` id, the `crons`, the `[vars]` keys, the `apiPrefixes` in `run_worker_first`), then
creates the resources for the environment it was given and patches that file's ids. Both files,
because the ordinary parity test compares binding names, `[vars]` keys, crons and
`run_worker_first` on every `pnpm test`; the placeholder in the other environment is refused by
`REQUIRE_PROVISIONED=1` until `pnpm provision cloudflare <other>` runs — exactly how the kit's own
`<KV_RATE_LIMIT_ID>` behaves. A `var` marked `"secret": true` is a Worker secret offered by
`pnpm provision secrets <env>`, never a `[vars]` key.

`pnpm provision <phase> [env]` (`apps/web/scripts/provision.ts`, driven by the `/rf-provision` skill) is
the orchestrator around it — phases `tokens` (TTY only: hidden prompts → `apps/web/.provision.env`) · `preflight` · `email create|status|verify` · `neon` ·
`cloudflare <env>` (this script with `--apply`) · `migrate <env>` · `github <env>` · `urls` ·
`deploy <env>` · `secrets <env>` · `all` — each idempotent, each ending in one `Verify:` line;
`SETUP.md` Part 3 has the table.

## Crons

`[triggers] crons` must be identical in both tomls (parity test); `apps/web/src/api/scheduled.ts`
`SCHEDULED_TASKS` is the dispatcher, keyed on the exact expression.

| Expression | Task | What it does | Local trigger (`wrangler dev` never fires crons itself) |
|---|---|---|---|
| `0 4 * * *` | `pruneExpired`, `pruneAiSpans` | deletes expired sessions, consumed/expired magic links, invitations older than 30 days; then `ai_spans` older than `OBSERVABILITY_SPAN_RETENTION_DAYS` (14), one DELETE across every tenant (D32) | `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=0+4+*+*+*"` |
| `15 * * * *` | `analytics.refreshFactTables` (the analytics PLUGIN, D31) | every registered fact table, per tenant, DELETE+INSERT in one transaction; per-tenant failures collected, logged as a warning, never abort the run. The expression is the plugin's `crons` declaration and the task is `ServerPlugin.scheduledTasks` — **a task under an expression no toml declares simply never runs** | `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=15+*+*+*+*"` — or, for one organisation, `rocketflare analytics refresh-facts` |

Health of the fact tables: `GET /api/analytics/facts/status` (admin+; `stale` = newest source row
has waited > 2× the table's interval) or `rocketflare analytics check-facts`, which exits 1 when
any table is stale and so works as a pipeline health check. Both go through the deployed API with a
tenant API key, so there is no path here that wants a production `DATABASE_URL` on somebody's
laptop. Cron runs share the Worker's CPU budget: past a few hundred tenants, fan the per-tenant
rebuilds out through `JOBS_QUEUE`.

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
| Non-secret config | `[vars]` in each toml (committed) | `APP_ENV`, `APP_URL`, `APP_NAME`, `RELEASE_VERSION`, `LOG_LEVEL`, `EMAIL_FROM`, `TENANCY_MODE`, `SIGNUP_MODE`, `TENANT_SCOPE_MODE`, `AGENT_MAX_OUTPUT_TOKENS` (16384), `AGENT_MAX_TURNS` (30), `CHAT_KNOWLEDGE_TOOLS` (`true`), `CHAT_HISTORY_MAX_CHARS` (24000), `AGENT_INTERRUPT_TIMEOUT`
(`168 hours` — how long an agent run parked on a human question waits before it expires; it is
passed verbatim to `step.waitForEvent`, so it must be a duration the platform accepts, between
1 second and 365 days. **Instance retention is the real bound, not this**: 30 days on Paid, 3 on
Free, after which the instance is gone and the park is recovered by `expireParkedRun` plus the
`sendEvent → not_found` restart), `FEATURES_ENABLED` (D30 —
feature keys this environment ships at all; blank is fail-closed, and this is the knob that keeps an
unreleased surface dark in production while staging has it). `OBSERVABILITY_CAPTURE_CONTENT` (`true`), `OBSERVABILITY_SPAN_RETENTION_DAYS` (`14`) (D32). Defaulted in `config.ts` and **not** declared in the tomls until used: the OIDC sign-in vars `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_LABEL` (`Single sign-on`), `OIDC_SCOPES` (`openid email profile`), `AUTH_OIDC_ONLY` (`false`; `true` without an issuer is a config error), `OIDC_TRUST_EMAIL` (`false` — a missing `email_verified` is refused; `true` only for an issuer that controls the email claim, e.g. single-tenant Entra) — add them to BOTH tomls to turn SSO on (`SETUP.md` 2.3b); `OBSERVABILITY_PRESET`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OBSERVABILITY_TRACE_URL`, `LANGFUSE_BASE_URL` (`https://cloud.langfuse.com`), `LANGFUSE_TRACING_ENVIRONMENT` (= `APP_ENV`) — to set one, add the key to BOTH files (the parity test compares `[vars]` keys); § Tracing |
| Worker secrets | `pnpm --filter @rocketflare/web exec wrangler secret put <NAME> [-c wrangler.staging.toml]`, once per worker; locally `apps/web/.dev.vars` | `OAUTH_ENCRYPTION_KEY` (also encrypts tenant AI keys — rotating it invalidates every `ai_configs` credential), `BOOTSTRAP_ADMIN_EMAILS`, `RESEND_API_KEY`, `GOOGLE_*`, `MICROSOFT_*`, `OIDC_CLIENT_SECRET` (optional even with OIDC on — a public client has none); AI, all optional: `ANTHROPIC_API_KEY` (platform chat), `EMBEDDINGS_API_KEY` (platform OpenAI embeddings when no `AI` binding), `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (the langfuse tracing preset), `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k=v`, any other OTLP backend's auth); `DATABASE_URL` — under `neon` THE connection (the pooled Neon URI, put by `pnpm provision secrets|deploy`), under `postgres` only a no-Hyperdrive fallback |
| CI secrets | GitHub Environments `staging` / `production` | `DATABASE_URL` (that branch), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Scripts only | migration environment | `APP_DATABASE_URL` (db-roles, RLS enforce only) |
| Developer-local only | `apps/web/.drizzle-cube.json` (git-ignored; the analytics plugin's README has the shape) | a **tenant API key** for the drizzle-cube CLI / Claude Code plugin against `/cubejs-api` — it is an ordinary key from Settings → API keys, scopes every query to that tenant, and is revoked there; never deployed, never committed |
| Resource ids | tomls (committed) | Hyperdrive (`postgres`) / KV ids — not secrets |
| Provisioning transport | `apps/web/.provision.env` (git-ignored, 0600; written by `pnpm provision tokens` or copied from `.provision.env.example`), overridden by an exported variable of the same name (CI) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NEON_API_KEY`, `RESEND_API_KEY` (the full-access account key, not the Worker's sending key) + the optional Worker secrets. Not `.dev.vars`: `wrangler dev` loads that into the Worker, and account-level tokens must never reach one. Every resolved value is registered with `redact()`; Neon connection strings are fetched from the API on demand (`reveal_password` / `reset_password`) and reach children by env or stdin (`wrangler secret put`, `gh secret set`); every printed line passes one `redact()`; `apps/web/.provision.json` (git-ignored) caches ids and answers only and refuses any secret-shaped value |

`wrangler secret put` (run in `apps/web`) requires the worker to exist: the first deploy of a fresh environment runs via
`workflow_dispatch` and 500s until the secrets are set. Use different key material per environment.
A `postgres` Worker never receives `DATABASE_URL` in deployed environments — it uses `HYPERDRIVE`.
A `neon` Worker holds nothing else: `loadConfig` fails at startup without `DATABASE_URL`.

## Neon: project, branches, hosts

- **One project, a branch per environment** (`production` = main, `staging`), plus a dedicated role
  per branch. Branches are cheap and share compute quota; separate projects give separate quotas and
  credentials — choose projects if the environments must be blast-radius isolated. A shared role
  across branches means one leaked string is every environment's string; don't.
- **Branch before you migrate.** Create `staging` before the first migration runs anywhere, so each
  branch is migrated under its own role and password rather than inheriting a migrated main; the
  `neon` phase of `pnpm provision` branches `staging` from the default branch before any `migrate`
  phase, keeps the database's default owner role and sets (or reveals) a password per branch —
  `--rotate` resets them and updates what the Worker holds to match — an existing Hyperdrive config
  (`postgres`) or the `DATABASE_URL` secret (`neon`).
- **`postgres`: Hyperdrive points at the DIRECT host** (`ep-….<region>.aws.neon.tech`), not
  `-pooler`. Hyperdrive is itself a pooler; stacking it on Neon's PgBouncer adds a hop and a second
  transaction-mode layer with nothing to gain.
- **`neon`: the Worker's `DATABASE_URL` is the POOLED host** (`ep-…-pooler.…`). Every request opens
  its own HTTP queries and at most one WebSocket transaction, so Neon's pooler is what bounds the
  connection count. `set_config(…, true)` / `SET LOCAL` are transaction-local, so the
  transaction-mode pooler is safe for RLS enforce and retrieval.
- **Migrations use the direct host too.** `apps/web/scripts/migrate.ts` strips `-pooler` from any Neon host it
  is given, so the CI `DATABASE_URL` secret may be either form. A pooled backend can carry a stale
  `default_transaction_read_only` GUC that blocks DDL; the source app hit exactly that.
- `apps/web/scripts/db-roles.ts` (RLS role) also needs the direct host — `ALTER DEFAULT PRIVILEGES` and `CREATE ROLE`
  are session-level DDL.
- Neon's owner role (`neondb_owner`) is **not a superuser** — it has `CREATEROLE` and is a
  `neon_superuser` member. Postgres lets only a superuser name `SUPERUSER`, `BYPASSRLS` or
  `REPLICATION` in `ALTER ROLE`, even to switch them off, so `db-roles.ts` sets those three only when
  `current_setting('is_superuser') = 'on'` (locally) and relies on `CREATE ROLE`'s defaults on Neon.
  Its post-check still fails the run if `rocketflare_app` ends with `rolsuper` or `rolbypassrls`.
  Before 0.14.0 this step failed on Neon with `permission denied to alter role`.
- Tests never use a real Neon database except a throwaway GATE branch the caller names
  (`TEST_DATABASE_BRANCH`, checked by `tests/helpers/db-safety.ts`); locally the `neon` runs talk to
  the proxy in front of the test Postgres, which `pnpm test` starts itself. `PREVIEW_DATABASE_URL`
  is an inert hook for per-PR Neon branches if previews are ever reinstated.

## CI/CD flow

All steps run at the repository root; the root scripts fan out with `pnpm -r` / `--filter`, so no
`working-directory` is set anywhere.

```
 pull request / push to main ─► ci.yml ─► verified (only with LAUNCH_GATE_APP_ID set): did Launch's App
                                  │         post a successful `launch/gate` for this tree? (`checks: read`)
                                  │       ─► gate (the ONE required job): pre-pull the test images (background)
                                  │         → pnpm install --frozen-lockfile → gitleaks
                                  │         → pnpm gate: lint → typecheck → test → build
                                  │           (test: compose Postgres + Neon proxy; every package; the web
                                  │            suite under postgres, then the `driver` project under neon)
                                  │           — or, verified, `pnpm gate build` only
                                  │
                                  └─► kit.yml (the kit only — `kitOnly`, so a copy has no such file)
                                        ├─ kit-checks → porting note → plugin-api.md diff → plugin check
                                        │               → defaultPlugins (no database)
                                        ├─ renamed    → rename to `my-app`, commit → pnpm gate
                                        └─ plugins    → plugin add each `defaultPlugins` entry at its ref
                                                        → db:generate → db:migrate:ci
                                                        → GATE_SUITE_DRIVER=neon pnpm gate (the whole
                                                          suite under neon; skipped with no defaults)

 push tag X.Y.Z ──► deploy.yml ─► guard: anything to deploy? (release-check.mjs --deployable)
                                  ├─ no  → gated, ci and both deploys skipped; the step summary says why
                                  │        (the kit itself: placeholders in the tomls — seconds, not a gate)
                                  └─ yes → gated: does github.sha already have a SUCCESSFUL `CI` run
                                           (push or pull_request; Actions API, `actions: read`)? Or is it
                                           a version-only bump (release-check.mjs --version-only HEAD^)
                                           over a parent that has one?
                                           ├─ yes → ci skipped: the commit (or its tree) was gated already
                                           └─ no  → ci (workflow_call: ci.yml, the same one job)
                                  ─► staging job (environment: staging) — only after ci passed, or ci
                                     skipped because `gated` found the green run; never after a failure
                                     tag == ROOT package.json version?
                                     → REQUIRE_PROVISIONED=1 pnpm --filter @rocketflare/web test:config
                                     → pnpm db:migrate:ci (staging DATABASE_URL) → pnpm --filter @rocketflare/web build:ui
                                     → pnpm --filter @rocketflare/web exec wrangler deploy -c wrangler.staging.toml --var RELEASE_VERSION:X.Y.Z
                                                                                    │
                                                              verify on staging: /api/health, /api/ready (the database, either driver), nav version
                                                                                    │
 gh release create X.Y.Z ──► deploy.yml ─► production job (environment: production, checkout the release tag)
                                     tag == ROOT version? → REQUIRE_PROVISIONED=1 test:config → db:migrate:ci (production)
                                     → build:ui → pnpm --filter @rocketflare/web exec wrangler deploy --var RELEASE_VERSION:X.Y.Z

 workflow_dispatch(environment) ──► either job from the dispatched ref (first deploy; emergencies);
                                    staging goes through guard → gated → ci exactly as a tag does
```

**A commit is gated once.** A copy usually deploys a commit that was pushed to main a minute
earlier, so `deploy.yml`'s `gated` job asks the Actions API whether `github.sha` already has a
completed, successful `CI` run from a `push` or a `pull_request`, and skips `ci` if so. A run still
in progress does NOT count — the deploy gates anyway rather than polling, which costs a duplicate
gate only on the first deploy after a push and never waits on a run that may be cancelled. Any
doubt (the API errors, the answer is not a count) means "gate here".

**A version-only bump rides its parent's run.** `gated` is also true when the commit has exactly
one parent, `node scripts/release-check.mjs --version-only HEAD^` passes — the diff touches only
the root `package.json`, and in it only the top-level `"version"` value, byte for byte (a reformat,
any other key or any other file fails) — and that PARENT has a completed, successful `CI` run on
its exact sha. That is Launch's release commit (`release: X.Y.Z` straight to main, then the tag):
its own CI is still running, or skipped (`[skip ci]`), when the tag's deploy asks, and the tree it
deploys is the parent's plus one version string. The job checks out with `fetch-depth: 2` for the
diff; a parent whose CI is still running counts as none, so the deploy gates itself. A person's own
bump commit still gets its CI run as before — this only removes a redundant re-gate, and still
requires a green parent. The decision is `gatedDecision` in `scripts/release-check.mjs`. One
caveat for a `[skip ci]` bump: GitHub drops EVERY `push`-triggered run whose head commit carries it,
tag pushes included, so a tag on that commit never starts this workflow — dispatch it on the tag
ref instead (`gh workflow run deploy.yml --ref X.Y.Z -f environment=staging`), where `gated`
applies the same rule. (The kit's own release commit is never version-only: `kit:release` also
writes the note, the changelog and `.rocketflare.json`.) `staging` is
`!cancelled()` so a skipped `ci` does not skip it, and its last clause is the security property:

```yaml
needs: [guard, gated, ci]
if: |
  !cancelled() && needs.guard.outputs.deployable == 'true' && (<tag push or staging dispatch>) && (
    needs.ci.result == 'success' ||
    (needs.ci.result == 'skipped' && needs.gated.outputs.gated == 'true')
  )
```

**A copy's CI is one job, and it is the gate.** `ci.yml` adds nothing to `pnpm gate` but the
secrets scan, so a green PR means exactly what a green `pnpm gate` on a laptop means, and what
Launch's ship gate runs in a sandbox (`tests/config/ci-workflows.test.ts` holds the file to that:
no second test job, no `services:` database beside the compose file, no `--skip`). A copy's
plugins are installed and committed, so the one gate covers them. What proves the KIT — what a
rename does to it, what a fresh clone installs, whether its published plugin API moved — is
`kit.yml`, which is `kitOnly`: the rename deletes it and `kit:upgrade` never ports it. It is a
required pull-request check in the kit and never a deploy precondition; the kit does not deploy,
and `guard` ends its tag runs in seconds with a summary saying so.

**Verified once, for an app Launch ships (off by default).** Launch runs `pnpm gate` in its
sandbox before it pushes, then its GitHub App posts a `launch/gate` check run on the pushed commit:
`conclusion: success`, `external_id: tree:<tree sha>`, `output.text` JSON
`{ tree, sessionId, attempt, steps }`. Set the repository variable **`LAUNCH_GATE_APP_ID`** to that
App's numeric id and `ci.yml`'s first job, `verified`, looks for it; when it finds one for the tree
under test, `Gate` runs gitleaks and `pnpm gate build` only. The rule (`scripts/lib/gate-verified-lib.mjs`):

| event | tree compared | where the attestation is looked for |
|---|---|---|
| `pull_request` | the checked-out MERGE commit's — what the gate would test | the PR head (what Launch attested), and the merge commit |
| `push` to main | the pushed commit's | the commit, then the head of every PR `GET /commits/{sha}/pulls` returns |
| anything else (deploy.yml's `workflow_call` on a tag or dispatch) | — | nothing: `verified=false` |

A pull request whose branch does not contain main's tip has a merge tree Launch never tested, so it
gets the full gate; so does a push whose tree moved past the PR head. Only a check run whose
`app.id` is `LAUNCH_GATE_APP_ID` counts — a `launch/gate` from any other app is ignored — and it
must be `completed`/`success` with that exact `external_id`. Any API error is `verified=false`.
`Gate` re-reads its own checkout's tree and reuses the verdict only when it matches, and runs on
`!cancelled()`, so a skipped or failed `verified` still runs the full gate. With the variable unset
`verified` is skipped (no runner, no API call) and `Gate` is exactly the job above. `verified` asks
for `contents`, `checks` and `pull-requests: read`, so deploy.yml's `ci` job grants those three — a
called workflow may not ask for more than its caller grants.

### Deploying through an external deployer (off by default)

Set the repository variable **`DEPLOYER_URL`** (optionally `DEPLOYER_AUDIENCE`) and both jobs take
a second path with **no `CLOUDFLARE_API_TOKEN` and no `DATABASE_URL` secret**: the job authenticates
with a GitHub OIDC token (`permissions: id-token: write`) and `scripts/deployer.mjs` runs

```
start (ticket; waits for approval) → build:ui → wrangler deploy --dry-run --outdir dist/deploy
  → upload (the deployer checks the bindings, stores an undeployed version, returns a short-lived
    MIGRATOR_URL, masked) → pnpm db:migrate:ci with DATABASE_URL=$MIGRATOR_URL → activate
  → finish (if: always())
```

Triggers, the guard, the CI gate, the parity check and the version resolution are the same on both
paths; with `DEPLOYER_URL` unset the migrate / `wrangler deploy` steps run exactly as above. The
contract a deployer implements — endpoints, payload, OIDC claims to check, what `migratorUrl` must be
able to do — is **`docs/DEPLOYER.md`** (protocol v1).

### Default plugins in CI, and the template a plugin repository calls (D31, decision 5)

The gate's steps live in ONE place, `pnpm gate` (`scripts/lib/gate-lib.mjs`), and every workflow
runs that command rather than restating it: a copy's `ci.yml` once, and in the kit `kit.yml` twice
more — renamed to a hyphenated slug, and with every default plugin installed and the whole suite
under `neon` (`GATE_SUITE_DRIVER=neon`). A second copy of the steps would prove nothing about the
copy nobody ran.

`defaultPlugins` in `.rocketflare.json` is a list of OBJECTS, and CI is its only strict reader:

```json
"defaultPlugins": [
  { "id": "analytics", "repo": "https://github.com/rocketflare-dev/rocketflare-plugin-analytics.git", "ref": "1.0.2" }
]
```

`repo` because a bare id says nothing about where a plugin comes from (decision 13 already made a
repository required of every plugin manifest); `ref` because CI installs a PINNED version rather
than whatever the default branch says this morning; `subdir` when the plugin is not the root of its
repository. A bare string parses as an id with no repo and is reported as such rather than having a
URL guessed for it. With the list empty `kit-checks` still reads it and says so — that is the
answer worth seeing on a bare kit — and the `plugins` gate is skipped, since with nothing installed
it would only re-run the renamed one's suite.

**`pnpm kit:release X.Y.Z` refuses a version its default plugins are not ready for**: every entry
must still resolve at the ref the kit pins (`git ls-remote`), and the `minKit` floor it declares
there must be at or below the version being cut. A plugin still carrying the retired `requires.kit`
is named as such, with the edit, rather than approximated — there is no range machinery left to fall
back on. `--skip-plugin-check` is the escape hatch and says so loudly. Be clear about what that proves: it catches a pin nobody updated.
**"CI green" is proven by the `plugins` job above, on the release commit** — a release script cannot
run somebody else's tests.

The mirror image, for a plugin repository, is `.github/workflows/plugin-ci.yml`, which lives in the
kit so that a change to how compatibility is proved reaches every plugin through one file. It reads
the plugin's own top-level `minKit` — one bare `X.Y.Z`, a floor with no ceiling — pairs it with the
kit's NEWEST release tag, and for each clones that kit, starts the test database from THAT kit's
own compose file (every kit a `minKit` can name ships one), installs the plugin from the checkout
under test, generates and applies the migrations the host owns, and runs the full gate — `pnpm
gate` where the cloned kit has it, the four commands it replaced on an older floor (a capability
probe on the root `gate` script, pinned by `tests/kit-only/plugin-ci.test.ts`) — then
`pnpm plugin check`. A plugin whose
`requires.plugins` names others gets them installed FIRST — each resolved by `id` to a directory in
the same checkout, dependencies before dependants, a missing id or a cycle failing the resolve job
by name — and its floor is the highest `minKit` across the plugin and those requirements, because a
kit too old for a dependency cannot host the plugin either. Both ends, not a
midpoint: the floor an adopter may still be on and the ceiling the kit has just reached. It compares
no versions itself — `sort -V` over `git ls-remote --tags` picks the newest, and everything left in
JavaScript is exact string matching, so there is no range to be malformed. A plugin repository
copies this and nothing else:

```yaml
# .github/workflows/ci.yml in the plugin repository
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  ci:
    uses: rocketflare-dev/rocketflare/.github/workflows/plugin-ci.yml@main
    # with:
    #   kit_repo: https://github.com/rocketflare-dev/rocketflare.git  # the default
    #   kit_ref: my-branch         # prove against one kit branch/tag; minKit is not consulted
    #   plugin_subdir: ""          # when the plugin is not the root of this repository
    #   plugin_subdirs: '["plugins/analytics"]'   # a repository holding several plugins
    # secrets:
    #   kit_token: ${{ secrets.KIT_READ_TOKEN }}   # only if the kit repository is private
```

There is no `kit_range` input: it was removed with the ranges, and **passing an input a reusable
workflow does not declare is a hard error**, so a caller that still names it fails outright rather
than being ignored.

Failing there means one of two things and the matrix says which: at the FLOOR, the plugin has
started using something the kit only gained later — raise `minKit` and release the plugin; at the
CEILING, the kit has moved under it — port the plugin (`pnpm plugin upgrade` is the adopter's side
of the same change) and release it. `pnpm plugin check` names the symbols, because compatibility is
the set difference between what a plugin `uses` and the kit's `## Surface ledger` (D31, §16).

**The driver seam** is how a fresh copy's DEPLOYED path (`neon`) is tested while local
development and the gate's suite run `postgres` (D35, `apps/web/src/db/CLAUDE.md`). App code is
driver-agnostic by construction: `src/db/client.ts` normalises what differs (result shapes, raw
arrays, error codes), `tests/config/driver-results.test.ts` bans what cannot be normalised (session
state outside a transaction, `LISTEN`, a SQLSTATE read by hand), and the `driver` conformance
project runs in every `pnpm test` under BOTH drivers — `neon` through the local proxy on :4433,
which the runner starts. It stays in a copy that deploys on `postgres` too, so switching drivers
later is safe. The whole suite runs under `neon` in `kit.yml`'s plugins pass, and on demand with
`GATE_SUITE_DRIVER=neon pnpm gate test`. Time limits scale with the target by one latency factor
(`vitest.config.ts`: 1 local postgres, 4 through the proxy, 12 on a real Neon branch); no test
carries a budget of its own.

**Bundle size.** `pnpm build` (`build:api` = `wrangler deploy --dry-run --outdir dist/api`) produces
`dist/api/worker.js`; **`gzip -c apps/web/dist/api/worker.js | wc -c` is the size that matters, and
no figure is quoted here on purpose** — it moves with every dependency bump, and a stale number in a
doc reads as a budget nobody is holding. What is stable: drizzle-cube's Hono adapter statically
imports its MCP transport (MCP SDK + inlined chart rendering) even with MCP disabled, and that
dominates the bundle — it is not the kit shipping React to the Worker. The ceiling is the Workers
script limit (3 MiB gzip free / higher on Paid, which Workflows need anyway). If a deploy is
refused for size, look at new `src/api` dependencies first; the structural fix is upstream or a thin
adapter over `drizzle-cube/server` (`.claude/rules/cloudflare.md`). UI: the analytics chunk
(drizzle-cube client + recharts + d3) is the largest and lazy — it must never merge into the main
chunk.

**Deploy guard.** A `guard` job runs first and the two deploy jobs are conditional on it. It skips
only the kit's own repository, which keeps `<PLACEHOLDER>` ids in both tomls on purpose — an app
(`app` set in `.rocketflare.json`) always deploys and still fails loudly at the parity check if it
was never provisioned. `isDeployable` (`scripts/lib/upgrade-lib.mjs`, unit-tested) deploys in every
ambiguous case, because a false skip is a release quietly not happening.

**Version rule.** The git tag must equal `version` in the **root** `package.json`; the job fails
otherwise. It also fails without `docs/upgrades/<tag>.md`, its `CHANGELOG.md` section and a
matching `.rocketflare.json` `kit.version` (`scripts/release-check.mjs --tag`): a release with no
porting note is a permanent gap in the chain `/rf-upgrade` walks, and every copy of the kit has to
step over it. `pnpm kit:release <version>` writes all of that, so the gate passes by construction — and in the
kit it also refuses a version whose `defaultPlugins` no longer resolve at their pinned ref
(D31, above).
**Released history is never rewritten** — a copy pins a kit commit and a force-push orphans it. One tag ships `apps/web` and `apps/cli` together — the `apps/*` and `packages/*` versions
are informational and are not checked. Bump the root version, commit, tag. The kit itself has one
more step after the tag, which nothing automates: updating rocketflare.dev's changelog
(`CONTRIBUTING.md`, "Cutting a release"). A Claude Code `PreToolUse` hook
(`scripts/release-site-nudge.mjs`) reminds the agent of it on any commit that changes the root
`package.json` version, in the kit and in the plugins monorepo (which carries a copy).

Publishing the Release is the promotion gate (required reviewers are unavailable on private repos
on the free plan; add them to the `production` environment if the plan allows). Production does not
re-run the CI gate: it ships the tag staging validated. `RELEASE_VERSION` is a `[vars]` override at
deploy time, surfaced by `/auth/session`, the nav footer and `rocketflare status`. Local
`pnpm deploy[:staging]` (root → `apps/web`: `build:ui` + `wrangler deploy`) exist as escape hatches;
CI is the path. `wrangler deploy` always runs with `apps/web` as cwd so `[assets] directory =
"./dist/ui"` resolves — never call it from the root.

## Cloudflare API token scopes (CI token, account scope)

Workers Scripts · Workers KV Storage · Queues · Workflows · Durable Objects · R2 · Hyperdrive (only
under `postgres`) —
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
- AI traces (D32): spans for every chat turn, agent run, tool call, retrieval, embeddings batch and
  AI job land in the tenant's `ai_spans` rows (read with `rocketflare traces list|show`) and, when a
  backend is configured, are exported as OTLP from `waitUntil`, never on the response path —
  § Tracing below. `ai_usage` in Postgres is the durable token ledger regardless of tracing.
  `ANALYTICS_ENGINE` request metrics are optional and fire-and-forget.
- Agent runs: `… wrangler workflows instances list rocketflare-agent-run[-staging]` / `describe <name>
  <instanceId>`. **The instance id is `agent_runs.instance_id`, which starts as the run id and is
  not always it**: a run parked on a human whose instance was lost is restarted as `<runId>-r1`,
  `-r2`… A row stuck `queued`/`running` whose instance is gone is settled on the next
  `GET /api/agents/runs/:id` — but only once it has been quiet for `RECONCILE_LIVENESS_MS` (30 s), so
  a run that is still emitting events is left alone rather than costing a Workflow subrequest per
  reader. A row stuck `awaiting_input` is settled by `expireParkedRun` on the same read, once every
  one of its asks is past `expiresAt`; a parked run whose asks are still in date is deliberately
  left waiting. There is no sweeper cron, which means both nets need somebody to open the run.

## Tracing (D32)

The local store needs nothing: every environment writes `ai_spans` and prunes it nightly. A
backend is ADDITIONAL and platform-wide (one per deployment, never per tenant). Vars go in BOTH
tomls (the parity test compares `[vars]` keys); headers are a secret. After any change, one chat
turn or agent run should appear in the backend within a minute.

| Backend | Set |
|---|---|
| Langfuse Cloud | nothing new — `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` select the `langfuse` preset, which sends OTLP/JSON to `<LANGFUSE_BASE_URL>/api/public/otel` with Basic auth and `x-langfuse-ingestion-version: 4`. A deployment that ran D16's ingestion client migrates by deploying. Optional `OBSERVABILITY_TRACE_URL = "https://cloud.langfuse.com/project/<id>/traces/{traceId}"` for the CLI's link-out |
| Self-hosted Langfuse | the two keys + `LANGFUSE_BASE_URL = "https://langfuse.example.com"` (or `OTEL_EXPORTER_OTLP_ENDPOINT` to the full `/api/public/otel` URL) |
| Phoenix (self-hosted) | `docker run -p 6006:6006 arizephoenix/phoenix` (or your deployment); `OBSERVABILITY_PRESET = "phoenix"`, `OTEL_EXPORTER_OTLP_ENDPOINT = "https://phoenix.example.com"`. The preset defaults to `http/protobuf` — Phoenix answers JSON with a 415. Auth, if enabled: secret `OTEL_EXPORTER_OTLP_HEADERS = authorization=Bearer%20<key>` |
| Any OTLP/HTTP collector | `OBSERVABILITY_PRESET = "generic"` (the default without Langfuse keys), `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL; `/v1/traces` is appended), optionally `OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"`; headers via the secret |

Headers go in with `pnpm --filter @rocketflare/web exec wrangler secret put OTEL_EXPORTER_OTLP_HEADERS
[-c wrangler.staging.toml]`, or from `.provision.env` through `pnpm provision secrets <env>`. Values
are URL-encoded per the OTel spec. `OBSERVABILITY_CAPTURE_CONTENT = "false"` strips prompts,
completions and tool I/O from BOTH the export and `ai_spans` (names, models, tokens and latency
stay). `OBSERVABILITY_SPAN_RETENTION_DAYS` bounds the local store only — the backend keeps its own
retention. Export failures are logged (`tracing: OTLP export returned a non-OK status`) and never
fail a request; `wrangler tail` is where to look.

## Rollback

| Situation | Action |
|---|---|
| Bad Worker version, schema unchanged | `pnpm --filter @rocketflare/web exec wrangler rollback [-c wrangler.staging.toml]` — previous version, seconds. Or `wrangler rollback <version-id>` from `deployments list` |
| Need a specific earlier tag | Actions → Deploy → `production` from that tag, or publish a Release on the earlier tag |
| Schema migration must be undone | migrations are forward-only: write a compensating migration, tag, and run the dance. `wrangler rollback` does not touch the database |
| Bad deploy right after switching a deployment to `neon` | `wrangler rollback` to the last `postgres` version — it restores that version's `HYPERDRIVE` binding, which is why the Hyperdrive configs are kept about a week (§ Database driver). Then switch the toml back with `pnpm provision cloudflare <env> --driver postgres` before the next deploy |
| RLS enforce misbehaving | `TENANT_SCOPE_MODE = "off"` in `[vars]` and redeploy — no migration (docs/RLS.md) |
| A Workflow hijacked by a name collision | fix the staging name, redeploy **both** workers (last deployer owns the name); stuck `agent_runs` rows settle on read (`GET /api/agents/runs/:id` → `reconcileRun` → `instance.status()`; `not_found` marks them `failed`) — except on the RESUME path, where `not_found` is recovered from by starting `<runId>-r1` rather than failing the run |
| Fact tables stale or wrong after a deploy | `GET /api/analytics/facts/status` (or `rocketflare analytics check-facts`) says which; fire the `15 * * * *` cron, or `rocketflare analytics refresh-facts` for one organisation. Rows are derived data — a rebuild is always safe; a schema change to a fact table is a normal forward migration followed by one rebuild. **First check the cron is in both tomls at all**: it is the analytics plugin's declaration, and an install that skipped that step leaves a task nothing ever dispatches |
| A dashboard renders empty / errors after a cube change | a cube member referenced by stored `analytics_pages.config` was renamed or removed — restore the member (names are frozen) or, per tenant, `POST /api/analytics/templates/recreate` (admin+) to re-copy the templates; user-created pages need a manual edit |
| Tenant AI keys unreadable after rotating `OAUTH_ENCRYPTION_KEY` | there is no re-encrypt path: admins re-enter the key in Settings → AI (the row keeps its label/model, `hasCredential` flips back); the platform `ANTHROPIC_API_KEY` is unaffected |

Verify any rollback with `/auth/session` (`releaseVersion`), `rocketflare status` and `wrangler tail`.

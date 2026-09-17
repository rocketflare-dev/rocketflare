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
   crons:     0 4 * * * (prune)  + every installed plugin's       routes: /api /auth /ws + plugins'
                      │                      │
              Hyperdrive <app>-staging   Hyperdrive <app>-production      (direct Neon host)
                      │                      │
              Neon branch `staging`      Neon branch `production` (main)  one project, role per branch
```

Workers Paid plan is required (Hyperdrive, Workflows, `[limits]`) — Hyperdrive's plan availability
has changed over time; the create step (`cf-provision.sh`) reports if the plan refuses it, with the
upgrade URL. The account also holds your domain as a zone (registered there, or its nameservers
moved): the custom-domain `routes` and the Resend DNS records are created in it and `pnpm provision
preflight` proves it exists — without one, both hosts are `workers.dev` and email is skipped.
Smart Placement runs the Worker
near Neon rather than near the user, which is what makes sequential queries cheap.

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
| `hyperdrive[].id`, `kv_namespaces[].id` | env's ids | env's ids |
| `queues.*.queue`, `workflows[].name`, `r2_buckets[].bucket_name`, `analytics_engine_datasets[].dataset` | `<app>-jobs`, `<app>-agent-run`, `<app>-files`, `<app>_analytics` | same + `-staging` / `_staging` |

| Must be **identical** | Why |
|---|---|
| `main`, `compatibility_date`, `compatibility_flags = ["nodejs_compat"]` | same runtime semantics |
| every `binding` name, every DO `class_name`, `[[migrations]]` | application code never branches on environment |
| `[limits]` (present in both or neither) | Workflows bound CPU per step by it — see below |
| `[triggers].crons` | the dispatcher table in `scheduled.ts` is one file |
| `[assets]` (incl. `run_worker_first`), `[placement]`, `[observability]` | same SPA, same placement, same logging. `run_worker_first` must list every prefix the Worker owns: the asset router runs BEFORE the Worker and `single-page-application` answers any NAVIGATION with `index.html` without invoking `fetch` — and an `<object>` embed or an `<a download>` click is a navigation, so a missing prefix silently serves the app shell for those (`wrangler-parity.test.ts` asserts it mirrors `API_PREFIXES`) |
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
| Workers AI (Phase 3, built) | `AI` | — | `[ai] binding = "AI"` — no resource; the zero-key floor for chat (`@cf/zai-org/glm-4.7-flash`) and embeddings (`@cf/baai/bge-m3`); **billed per call to this account** (10k free neurons/day), `wrangler dev` proxies to the logged-in account; remove from BOTH tomls for zero-spend |
| Analytics (a PLUGIN, D31) | — | — | **no resource and no binding**: its cubes read through `HYPERDRIVE`, its fact tables rebuild on the `15 * * * *` cron it declares, and `/cubejs-api` + `/mcp` are routes of this Worker. Installing it means adding that cron and those two prefixes to BOTH tomls — `pnpm provision cloudflare <env>` reads them off the installed surface and writes them (decision 12) |
| Analytics Engine (optional) | `ANALYTICS_ENGINE` | `<app>_analytics[_staging]` | declared in toml — deliberately NOT wired by the kit (only a comment in both tomls) |
| Static Assets | `ASSETS` | — | `[assets] directory = "./dist/ui"` uploaded atomically with each deploy; `run_worker_first` keeps `/api`, `/auth`, `/ws` — and every prefix an installed plugin declares — off the asset router |
| RLS app role (optional, docs/RLS.md) | `HYPERDRIVE_APP` | `<app>-<env>-app` | `… hyperdrive create … --caching-disabled` |
| Plugin resources (D31) | whatever the plugin's `plugin.json` declares (`APPROVALS_CACHE`…) | `<app>-<id>-<name>[-staging]`, and `<APP>_<ID>_<NAME>[_STAGING]` for KV | `pnpm provision cloudflare <env>` — it reads each installed plugin's `bindings[]`, creates them through `cf-provision.sh` and patches the block into that environment's toml |

`pnpm web provision:cloudflare <staging|production> [app] [--apply] [--force]` (the `apps/web`
script → `scripts/cf-provision.sh`, which `cd`s to `apps/web` itself so it also works as
`bash apps/web/scripts/cf-provision.sh …`) creates a RESOURCE LIST idempotently — the kit's own
four, Hyperdrive, KV, Queue and R2, are the default list, each found by name and reused when it
exists, and `PLUGIN_RESOURCES` (a JSON array of `{ type, name, binding }`, set by
`pnpm provision cloudflare <env>` from the installed plugins' manifests) appends to it — and either
prints the Hyperdrive/KV ids
with a `sed` line per toml, or with `--apply` writes them into that toml through
`scripts/provision/patch-toml.ts` (a DIFFERENT existing id is refused unless `--force`). It needs
`NEON_DATABASE_URL` (direct host) and an authenticated wrangler (`wrangler login`, or
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`); the connection string is an argument of the one
`wrangler hyperdrive create` process and is redacted from every echoed line.
**Plugin resources (D31, Decision 12).** A plugin ships no toml — the two files are the host's,
always — so its `plugin.json` DECLARES what the account has to provide and `pnpm provision
cloudflare <env>` applies it. `scripts/provision/plugin-resources.ts` owns the naming rule
(`<app>-<id>-<name>[-staging]` for a queue or bucket, `<APP>_<ID>_<NAME>[_STAGING]` for a KV
namespace, mirroring the kit's own `<APP>_RATE_LIMIT[_STAGING]`) and the refusal: a `type` outside
`kv | queue | r2` names itself in the error rather than being skipped, because a binding quietly
not created is a Worker that deploys and then 503s. `hyperdrive` is deliberately not offered — the
host owns the one database.

The phase writes the DECLARATIONS into **both** tomls first (the binding block with a
`<PLACEHOLDER>` id, the `crons`, the `[vars]` keys, the `apiPrefixes` in `run_worker_first`), then
creates the resources for the environment it was given and patches that file's ids. Both files,
because the ordinary parity test compares binding names, `[vars]` keys, crons and
`run_worker_first` on every `pnpm test`; the placeholder in the other environment is refused by
`REQUIRE_PROVISIONED=1` until `pnpm provision cloudflare <other>` runs — exactly how the kit's own
`<HYPERDRIVE_ID>` behaves. A `var` marked `"secret": true` is a Worker secret offered by
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
| `0 4 * * *` | `pruneExpired` | deletes expired sessions, consumed/expired magic links, invitations older than 30 days | `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=0+4+*+*+*"` |
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
unreleased surface dark in production while staging has it). Defaulted in `config.ts` and **not** declared in the tomls: `LANGFUSE_BASE_URL` (`https://cloud.langfuse.com`), `LANGFUSE_TRACING_ENVIRONMENT` (= `APP_ENV`) — to override, add the key to BOTH files (the parity test compares `[vars]` keys) |
| Worker secrets | `pnpm --filter @rocketflare/web exec wrangler secret put <NAME> [-c wrangler.staging.toml]`, once per worker; locally `apps/web/.dev.vars` | `OAUTH_ENCRYPTION_KEY` (also encrypts tenant AI keys — rotating it invalidates every `ai_configs` credential), `BOOTSTRAP_ADMIN_EMAILS`, `RESEND_API_KEY`, `GOOGLE_*`, `MICROSOFT_*`; AI, all optional: `ANTHROPIC_API_KEY` (platform chat), `EMBEDDINGS_API_KEY` (platform OpenAI embeddings when no `AI` binding), `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (both or tracing is off); `DATABASE_URL` only as a no-Hyperdrive fallback |
| CI secrets | GitHub Environments `staging` / `production` | `DATABASE_URL` (that branch), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Scripts only | migration environment | `APP_DATABASE_URL` (db-roles, RLS enforce only) |
| Developer-local only | `apps/web/.drizzle-cube.json` (git-ignored; the analytics plugin's README has the shape) | a **tenant API key** for the drizzle-cube CLI / Claude Code plugin against `/cubejs-api` — it is an ordinary key from Settings → API keys, scopes every query to that tenant, and is revoked there; never deployed, never committed |
| Resource ids | tomls (committed) | Hyperdrive / KV ids — not secrets |
| Provisioning transport | `apps/web/.provision.env` (git-ignored, 0600; written by `pnpm provision tokens` or copied from `.provision.env.example`), overridden by an exported variable of the same name (CI) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NEON_API_KEY`, `RESEND_API_KEY` (the full-access account key, not the Worker's sending key) + the optional Worker secrets. Not `.dev.vars`: `wrangler dev` loads that into the Worker, and account-level tokens must never reach one. Every resolved value is registered with `redact()`; Neon connection strings are fetched from the API on demand (`reveal_password` / `reset_password`) and reach children by env or stdin (`wrangler secret put`, `gh secret set`); every printed line passes one `redact()`; `apps/web/.provision.json` (git-ignored) caches ids and answers only and refuses any secret-shaped value |

`wrangler secret put` (run in `apps/web`) requires the worker to exist: the first deploy of a fresh environment runs via
`workflow_dispatch` and 500s until the secrets are set. Use different key material per environment.
The worker never receives `DATABASE_URL` in deployed environments — it uses `HYPERDRIVE`.

## Neon: project, branches, Hyperdrive host

- **One project, a branch per environment** (`production` = main, `staging`), plus a dedicated role
  per branch. Branches are cheap and share compute quota; separate projects give separate quotas and
  credentials — choose projects if the environments must be blast-radius isolated. A shared role
  across branches means one leaked string is every environment's string; don't.
- **Branch before you migrate.** Create `staging` before the first migration runs anywhere, so each
  branch is migrated under its own role and password rather than inheriting a migrated main; the
  `neon` phase of `pnpm provision` branches `staging` from the default branch before any `migrate`
  phase, keeps the database's default owner role and sets (or reveals) a password per branch —
  `--rotate` resets them and updates an existing Hyperdrive config to match.
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
 push to main ─► ci.yml (root) ─► check      → gate.yml: pnpm install --frozen-lockfile → gitleaks
                        │                       → porting note → pnpm lint → pnpm typecheck
                        │                       → git diff --exit-code apps/web/worker-configuration.d.ts
                        │                       → pnpm test (pg 5433; web + cli)
                        │                       → pnpm build (web: vite + dry-run wrangler deploy; cli: tsc)
                        ├─► default-plugins → what .rocketflare.json `defaultPlugins` names (or "none")
                        └─► plugins         → gate.yml again with `plugins: true`: pnpm plugin add each
                                              entry at its pinned ref → pnpm db:generate → db:migrate:ci
                                              → the same gate (D31; skipped when there are none)
                                                                                                            │
 push tag X.Y.Z ──► deploy.yml ─► ci (workflow_call, same file) ─► staging job (environment: staging)
                                     tag == ROOT package.json version?
                                     → REQUIRE_PROVISIONED=1 pnpm --filter @rocketflare/web test:config
                                     → pnpm db:migrate:ci (staging DATABASE_URL) → pnpm --filter @rocketflare/web build:ui
                                     → pnpm --filter @rocketflare/web exec wrangler deploy -c wrangler.staging.toml --var RELEASE_VERSION:X.Y.Z
                                                                                    │
                                                              verify on staging: /api/health, /api/ready (Hyperdrive → Neon), nav version
                                                                                    │
 gh release create X.Y.Z ──► deploy.yml ─► production job (environment: production, checkout the release tag)
                                     tag == ROOT version? → REQUIRE_PROVISIONED=1 test:config → db:migrate:ci (production)
                                     → build:ui → pnpm --filter @rocketflare/web exec wrangler deploy --var RELEASE_VERSION:X.Y.Z

 workflow_dispatch(environment) ──► either job from the dispatched ref (first deploy; emergencies)
```

### Default plugins in CI, and the template a plugin repository calls (D31, decision 5)

The gate's steps live in `.github/workflows/gate.yml` and `ci.yml` calls it twice — once on the
checkout as it is, once with every default plugin installed. One boolean input is the difference,
because a second copy of those steps would prove nothing about the copy nobody ran.

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
URL guessed for it. With the list empty the `default-plugins` job still runs and says so — that is
the answer worth seeing on a bare kit — and the expensive second gate is skipped, since with nothing
installed it would re-run the first one verbatim.

**`pnpm kit:release X.Y.Z` refuses a version its default plugins are not ready for**: every entry
must still resolve at the ref the kit pins (`git ls-remote`), and a declared `requires.kit` range
must admit the version being cut. `--skip-plugin-check` is the escape hatch and says so loudly. Be
clear about what that proves: it catches a pin nobody updated. **"CI green" is proven by the
`plugins` job above, on the release commit** — a release script cannot run somebody else's tests.

The mirror image, for a plugin repository, is `.github/workflows/plugin-ci.yml`, which lives in the
kit so that a change to how compatibility is proved reaches every plugin through one file. It reads
the plugin's own `requires.kit`, resolves the OLDEST and NEWEST kit releases inside that range, and
for each clones that kit, installs the plugin from the checkout under test, generates and applies
the migrations the host owns, and runs the full gate. Both ends of the range, not a midpoint: the
floor an adopter may still be on and the ceiling the kit has just reached. A plugin repository
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
    #   kit_range: "=0.6.0"        # override the plugin's own requires.kit
    #   plugin_subdir: ""          # when the plugin is not the root of this repository
    # secrets:
    #   kit_token: ${{ secrets.KIT_READ_TOKEN }}   # only if the kit repository is private
```

Failing there means one of two things and the matrix says which: at the FLOOR, the plugin has
started using something the kit only gained later — raise `requires.kit` and release the plugin; at
the CEILING, the kit has moved under it — port the plugin (`pnpm plugin upgrade` is the adopter's
side of the same change) and widen the range.

**Bundle size.** `pnpm build` (`build:api` = `wrangler deploy --dry-run --outdir dist/api`) produces
`dist/api/worker.js`; **`gzip -c apps/web/dist/api/worker.js | wc -c` is the size that matters, and
no figure is quoted here on purpose** — it moves with every dependency bump, and a stale number in a
doc reads as a budget nobody is holding. What is stable: drizzle-cube's Hono adapter statically
imports its MCP transport (MCP SDK + inlined chart rendering) even with MCP disabled, and that
dominates the bundle — it is not the kit shipping React to the Worker. The ceiling is the Workers
script limit (3 MiB gzip free / higher on Paid, which Hyperdrive needs anyway). If a deploy is
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
kit it also refuses a version whose `defaultPlugins` no longer resolve at their pinned ref or whose
declared `requires.kit` excludes it (D31, above).
**Released history is never rewritten** — a copy pins a kit commit and a force-push orphans it. One tag ships `apps/web` and `apps/cli` together — the `apps/*` and `packages/*` versions
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
  <instanceId>`. **The instance id is `agent_runs.instance_id`, which starts as the run id and is
  not always it**: a run parked on a human whose instance was lost is restarted as `<runId>-r1`,
  `-r2`… A row stuck `queued`/`running` whose instance is gone is settled on the next
  `GET /api/agents/runs/:id` — but only once it has been quiet for `RECONCILE_LIVENESS_MS` (30 s), so
  a run that is still emitting events is left alone rather than costing a Workflow subrequest per
  reader. A row stuck `awaiting_input` is settled by `expireParkedRun` on the same read, once every
  one of its asks is past `expiresAt`; a parked run whose asks are still in date is deliberately
  left waiting. There is no sweeper cron, which means both nets need somebody to open the run.

## Rollback

| Situation | Action |
|---|---|
| Bad Worker version, schema unchanged | `pnpm --filter @rocketflare/web exec wrangler rollback [-c wrangler.staging.toml]` — previous version, seconds. Or `wrangler rollback <version-id>` from `deployments list` |
| Need a specific earlier tag | Actions → Deploy → `production` from that tag, or publish a Release on the earlier tag |
| Schema migration must be undone | migrations are forward-only: write a compensating migration, tag, and run the dance. `wrangler rollback` does not touch the database |
| RLS enforce misbehaving | `TENANT_SCOPE_MODE = "off"` in `[vars]` and redeploy — no migration (docs/RLS.md) |
| A Workflow hijacked by a name collision | fix the staging name, redeploy **both** workers (last deployer owns the name); stuck `agent_runs` rows settle on read (`GET /api/agents/runs/:id` → `reconcileRun` → `instance.status()`; `not_found` marks them `failed`) — except on the RESUME path, where `not_found` is recovered from by starting `<runId>-r1` rather than failing the run |
| Fact tables stale or wrong after a deploy | `GET /api/analytics/facts/status` (or `rocketflare analytics check-facts`) says which; fire the `15 * * * *` cron, or `rocketflare analytics refresh-facts` for one organisation. Rows are derived data — a rebuild is always safe; a schema change to a fact table is a normal forward migration followed by one rebuild. **First check the cron is in both tomls at all**: it is the analytics plugin's declaration, and an install that skipped that step leaves a task nothing ever dispatches |
| A dashboard renders empty / errors after a cube change | a cube member referenced by stored `analytics_pages.config` was renamed or removed — restore the member (names are frozen) or, per tenant, `POST /api/analytics/templates/recreate` (admin+) to re-copy the templates; user-created pages need a manual edit |
| Tenant AI keys unreadable after rotating `OAUTH_ENCRYPTION_KEY` | there is no re-encrypt path: admins re-enter the key in Settings → AI (the row keeps its label/model, `hasCredential` flips back); the platform `ANTHROPIC_API_KEY` is unaffected |

Verify any rollback with `/auth/session` (`releaseVersion`), `rocketflare status` and `wrangler tail`.

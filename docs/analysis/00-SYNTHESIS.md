# GMGO Starter Kit — Synthesis & Decision Matrix

Consolidates the nine subsystem analyses (`01`–`09`) into one set of decisions, one kit tree, and a
phased build plan. Where two analyses disagreed, the resolution is recorded here and wins.

Sources: `~/work/mirevue` (structure) and `~/work/guidemode/apps/server` (Cloudflare substrate).
Framing: **a port, not a merge** — Mirevue's foundation with its Node-specific organs replaced by
GM's Cloudflare equivalents. Nine analyses independently reached the same base/graft verdicts:

| Subsystem | Base | Grafted from the other | Doc |
|---|---|---|---|
| Auth (sessions, magic link, OAuth, API keys, CSRF) | Mirevue | GM: single LATERAL session query, `waitUntil` side-effects, KV rate limit, `scheduled` shape | 01 |
| Tenancy + CASL | Mirevue (server) / GM (UI) | GM: `AbilityProvider`/`Can`/`usePermissions`, bulk invite, org create/delete, demo cleanup, KV `operationLock` | 02 |
| Database | Mirevue (schema, RLS scaffolding, harness, seed) | GM: client shape (`postgres.js` over Hyperdrive), `migrate.ts` Neon host rewrite, pagination | 03 |
| API shell | Mirevue | GM: `{ fetch, queue, scheduled }`, `Hono<{Bindings}>` + `wrangler types`, `ASSETS` catch-all, per-request DB client, fetch-based Langfuse | 04 |
| Async / realtime / email / storage | GM (Queues, Workflows, cron, DO hub) | Mirevue: "routes enqueue, never run", `/ws` upgrade auth, `Broadcaster` seam, Resend-via-fetch, `StorageService` | 05 |
| UI shell | Mirevue | GM: `RELEASE_VERSION` footer, env badge, CASL trio, dev-only Query devtools, route preload | 06 |
| DX / deploy / docs | Mirevue (shape, vitest harness, docs system) | GM: wrangler anatomy, two-toml staging, release dance, `db:migrate:ci`, `wrangler types` | 07 |
| Analytics / dashboards (drizzle-cube) | GM (only source) | — | 08 |
| AI layer (settings, chat, agents, tracing) | Mirevue | GM: fetch-based Langfuse ingestion, `aws4fetch` Bedrock path (deferred) | 09 |

---

## 1. Decisions

### 1.1 Locked before analysis (user + advisor)

- CF-Workers-first, single deploy target; no Node/Docker adapter (Mirevue's Dockerfile/entrypoint named in `ADAPTING.md` as the recipe if ever needed).
- ~~Single package~~ **REVISED 2026-09-01 (user): pnpm workspace monorepo** — `apps/web` (Worker + UI, Mirevue-shaped `src/`), `apps/cli` (default CLI: `login` via browser → loopback callback → API key in `~/.<app>/config.json`, `whoami`, `logout`, plus an example tenant-scoped command; `<APP>_API_KEY`/`<APP>_URL` env overrides for CI), `packages/shared` (`@gmgo/shared`, **private**, `"private": true`, no publishConfig: zod contracts/errors/pagination/permission types consumed by web API, web UI and CLI). Root `package.json` delegates via `pnpm -r` / `--filter`. Per-package tsconfig; shared is consumed as TS source via workspace link (`exports` → `./src/index.ts`) so no build step is needed in dev.
- One worker; `NotificationsHub` Durable Object in-script. (05 confirmed GM split it only to keep preview URLs, since dropped; the split-out is a documented, reversible recipe.)
- **In v1**: analytics/dashboards via drizzle-cube; AI enablement layer (settings, chat, agents, tracing seam).
- Out of v1: Paddle/billing, Vectorize, voice, documents pipeline, reporting/export, benchmarks, evals harness, every app domain.
- Zero-creds first run preserved (no `RESEND_API_KEY` → magic link logged; no AI key → AI settings show "not configured").
- No baked resource ids or secrets; `<PLACEHOLDER>`s + `scripts/cf-provision.sh` + parity test that fails while placeholders remain.

### 1.2 Resolved from the analyses

| # | Decision | Resolution | Why |
|---|---|---|---|
| D1 | **Tenant isolation** | Predicates-only at runtime (`TENANT_SCOPE_MODE=off` default). RLS scaffolding ships **inert**: `tenantIsolation()` on every tenant table, `db-roles.ts` (SQL-created NOLOGIN role), catalog-driven `rls-coverage.test.ts`, `withTenantScope` rewritten as `db.transaction + set_config(..., true)` for `enforce`. A defined half-day spike (03 §9b) gates `enforce`. | Mirevue's RLS is a session GUC on a pinned `pg` connection; Hyperdrive is a transaction-mode pooler. GM is predicate-only. Scaffolding costs nothing and turns a later rollout into a config change. |
| D2 | DB driver | `postgres.js` only, per-request client, `ctx.waitUntil(sql.end())`. `resolveDatabaseUrl(env) = PREVIEW_DATABASE_URL ?? HYPERDRIVE.connectionString ?? DATABASE_URL`. Drop `@neondatabase/serverless` and `pg`. | Single driver keeps transactions possible (invite accept, tenant create, future RLS); GM's never-`end()`ed clients are a real defect to fix. |
| D3 | Config | `loadConfig(env)` zod-validated, memoised per isolate by env identity, called from `fetch`/`queue`/`scheduled`; routes read `c.get('config')`, never `c.env`. Forbid `process.env` in app code. | Mirevue's fail-fast boot parse has no Worker equivalent; GM's `c.env.X \|\| process.env.X` fallbacks are dead in prod. |
| D4 | Env naming | `APP_ENV = development \| staging \| production` in `[vars]`; `NODE_ENV=test` only in test scripts. | `NODE_ENV` is a Node concept; env badge/title need staging distinct from production. |
| D5 | Worker entry | `src/worker.ts` = `export default { fetch, queue, scheduled }` + `export { NotificationsHub, AgentRunWorkflow }`. `src/api/index.ts` exports the Hono `app` only. | Keeps the Hono app testable via `app.request()` without dragging DO/Workflow classes into Node tests. |
| D6 | wrangler format | `wrangler.toml` + `wrangler.staging.toml` (two files, parity test), not `[env.*]`. | GM's proven shape; bindings don't inherit under `[env.*]`; comments as documentation. |
| D7 | Background work | One queue (`JOBS_QUEUE`), one Workflow class (`AgentRunWorkflow` — the agent runtime *is* the example workflow), cron dispatcher keyed on `event.cron`. pg-boss `exclusive` → deterministic instance id + `get()` probe; coalesce → DB claim row (`UPDATE … WHERE status IN (queued,running) RETURNING`); cancel → per-turn status poll; progress → durable `agent_run_events` + DO nudge. | 05 §1.3 mapping + 09 §4.5 handoff contract. Avoids a second throwaway example workflow. |
| D8 | Realtime | GM `NotificationsHub` DO (hibernation, tenant/user tags, RPC not fetch) + Mirevue `/ws` upgrade auth (cookie → session → `tenant_users` check) + Mirevue client (jittered backoff, entity→query-key invalidation). "DB is the truth, WebSocket is a nudge." | Both repos state the principle independently. Mirevue's SSE `Last-Event-ID` replay is deferred (no NOTIFY wake on Workers). |
| D9 | Sign-up | `SIGNUP_MODE = open \| invite_only \| approval` (config). **Default `invite_only`** + `BOOTSTRAP_ADMIN_EMAILS` (promote only on verified login, log loudly). `open` = GM auto-personal-tenant via one `onNoTenant` hook. Domain allow-list = new, small, ships behind `approval`/`invite_only`. | Neither repo's behaviour is right for every app; a config fork is cheaper than two kits. **User may override the default.** |
| D10 | Roles / abilities | `owner` / `admin` / `member` assignable; `support` readable-only (minted via `/admin`); `users.isGlobalAdmin` platform flag. Core subjects `all`, `Tenant`, `TenantMember`, `Invitation`, `ApiKey`, `Notification` + `access` feature hook taking injected `features: string[]`. GM CASL semantics (`manage Tenant` = owner) + Mirevue explicit `role === 'owner'` for delete/ownership. Typed `AppAbility`. Routes: coarse `AdminRoute`/`GlobalAdminRoute` by role + `RequireAbility` per page; `SideNav` flags use the same mechanism. | 02 §10b matrix. Neither repo uses CASL conditions/`accessibleBy` — don't pretend to. |
| D26 | **Workspace layout & CLI** (user request) | Layout as in §1.1. CLI stack: `commander` + `chalk` + `open` (as the Workers reference app's CLI), `tsx` in dev, `tsc` build to `dist/` with a `bin`. Server adds `GET /auth/cli?redirect_uri=` (loopback `127.0.0.1`/`localhost` allowlist only) which, after login + tenant select, mints a tenant API key named `cli:<hostname>` and redirects with `?key=&tenant_id=&tenant_name=`. CLI stores config `0600` under `~/.<app>/`. | Every GM app wants a CLI; a private shared package keeps contracts single-sourced across three consumers. |
| D11 | OAuth providers v1 | Google + Microsoft + magic link + dev-login (404 in prod). One generic `/auth/:provider` router over a `ProviderDefinition` registry; redirect URIs derived from `APP_URL`; `emailVerified !== false` enforced for every provider. GitHub/Slack as documented additions. | Cheapest verified-email set; provider copy-paste in both repos is the anti-pattern. |
| D12 | Auth security fixes during port | `hashToken` → SHA-256 (was `btoa`); signing key from env (`AUTH_SIGNING_KEY`), never derived from `DATABASE_URL`; `OAUTH_ENCRYPTION_KEY` required (no plaintext pass-through); `randomBytes` → `crypto.getRandomValues`; `Secure` cookie from `APP_ENV`; UNIQUE `(provider, provider_user_id)`; `validateApiKey` checks `expires_at`; `__Host-session` cookie; single `oauth_state` cookie carrying provider. | 01 §12. |
| D13 | Contracts | zod on both ends via `src/shared/`; no `hono/client` RPC. Codify error envelope `{ error, statusCode, code?, details? }` and override zValidator's 400 body to match. Pagination = `page/pageSize/total/totalPages` (Mirevue). `createRouter()` factory so no bare `new Hono()`; drop `declare module 'hono'` augmentation. | Existing practice in both; 06's UI pagination question resolved to Mirevue shape. |
| D14 | Rate limiting | KV sliding window (`RATE_LIMIT_KV`), no-op when binding absent; `operationLock` on same KV. Workers Rate Limiting binding noted as the exact alternative. | Proven in GM; approximate is fine for login throttling. |
| D15 | Testing | Node vitest, real Postgres (5433), `app.request(req, env)` with `tests/mocks/bindings.ts` (in-memory KV, recording Queue, stub DO/Workflow/Hyperdrive), `cloudflare:workers` aliased to a stub. Mirevue's 4-project split (`api` shared / `api-isolated` via `// @vitest-isolate` / `ui` jsdom / `config`). Queue consumers and workflow steps are plain functions tested directly. `@cloudflare/vitest-pool-workers` = one smoke project, **not v1**. | Both teams know it; fast; 07 §2.3. |
| D16 | Observability | `withAgentTrace` / `traceClient` seams with no-op defaults; backend = fetch-based Langfuse batcher flushed in `waitUntil`; presence of keys is the switch. No OTel dep in v1. `[observability.logs]` on; `ANALYTICS_ENGINE` optional binding with fire-and-forget middleware. | Mirevue's `NodeSDK` can't run in Workers; GM's batcher is proven. |
| D17 | AI providers v1 | Chat: `anthropic`, `anthropic_compatible` (Fireworks/Moonshot presets). Embeddings: `workers_ai` (binding, default model **`@cf/baai/bge-m3`**, 1024-dim), `openai`, `openai_compatible` → **pgvector on Neon**, not Vectorize. Compose images are `pgvector/pgvector:pg17`; migration `0000` runs `CREATE EXTENSION IF NOT EXISTS vector` (Neon has it per-branch). Config: env defaults → tenant `ai_configs` (scope × provider, encrypted creds, one default) → `agent_models` (promptKey → config+model); single `resolveClient(db, tenantId, env, promptKey?)`. **No Vercel AI SDK.** Bedrock deferred (Node-only eventstream; `aws4fetch` recipe documented). | 09 §2.4. Everything non-trivial in Mirevue is built on `.messages`. |
| D18 | AI extras in v1 | Add `ai_usage` table (tenantId, promptKey, model, input/output/cacheRead/cacheWrite tokens, at) written from the existing `toUsageDetails` tap. Embedding column dim fixed at **1024** (`EMBEDDING_DIM` constant) — must agree with the default `bge-m3`; a 768-dim model requires changing the constant before the first migration. Retrieval ships **with** one minimal ingest path (`services/ai/ingest.ts`: text in → chunk → embed → insert `documents`/`chunks`) exercised by the `summarize-text` example agent's tests, so `retrieval.ts` is never dead code. | Cheap now, impossible to backfill later. |
| D19 | Analytics ship set | Cubes `Users` + `TenantUsers` (shows both scoping patterns) + `ActivityEvents` + `TenantActivityDaily`; one fact table `tenant_activity_daily_facts` (registry-driven DELETE+INSERT per tenant at `:15`, freshness check); one `tenant-overview` template; drizzle-cube Hono adapter per request at `/cubejs-api` + `/mcp` — **both mounted behind `authMiddleware` and added to the ASSETS catch-all's 404 guard alongside `/api|/auth`** (securityContext reads `c.get('auth')`); drizzle-cube React components; **recharts** only (drop nivo, keep d3 as un-imported peer). Pin `drizzle-cube` exactly. Two-tenant cube isolation test is mandatory (GM's is skipped). Port `DASHBOARD_PATTERNS.md`, not GM's stale `analytics.md`. | 08. Requires an `activity_events` table — added (see 1.3). |
| D20 | UI additions neither repo has | Root + per-`<main>` `ErrorBoundary`; global 401 → `QueryCache.onError` clears client and redirects to `/login?returnUrl=`. `Layout` mounted once under `/*` (GM shape) with Mirevue guards. Provider order per 06 §b. Ship emitted CSS tokens + contrast test; palette pipeline documented, not shipped. | 06 §d. |
| D21 | Docs system | Mirevue's shape: `CLAUDE.md` (5–6 KB, canonical) + `AGENTS.md` symlink, `README.md`, `SETUP.md` (agent-*executable*, Part 3 = Cloudflare), `docs/CONCEPTS.md`, `docs/DEPLOY.md`, `docs/ADAPTING.md` ("you just copied this"), `docs/RLS.md`, `docs/ai.md`, `.claude/rules/{api,database,ui,testing,code-quality,cloudflare}.md`, `src/**/CLAUDE.md` ×7. No OpenSpec/GitNexus blocks, no `gemini.md`/`QWEN.md`. "Update the doc when you change the behaviour" is a Non-Negotiable. | 07 §6, §8c. Docs drift is GM's most visible failure mode. |
| D22 | Tooling versions | Set fresh: `compatibility_date` = current, Biome 2.x, pnpm 10, Node 24, TS 5.9, one `tsconfig` with `skipLibCheck` (split only if Node/Workers global conflicts surface). Commit `worker-configuration.d.ts`; `pretypecheck` regenerates; CI fails on dirty diff. | 07 §8e. |
| D23 | Storage | `StorageService` interface (Mirevue) over native `R2Bucket` binding (`FILES`); stream through the worker; presigned URLs deferred. | 05 §4. |
| D25 | **Tenancy mode** (user request) | `TENANCY_MODE = multi \| single` (config, default `multi`). **Schema is identical in both modes** — every table keeps `tenant_id`, predicates and RLS scaffolding stay, so a single-tenant app can flip to multi later without a migration. In `single`: one tenant is created at bootstrap (seed / first verified login of a `BOOTSTRAP_ADMIN_EMAILS` user becomes `owner`); every user admitted by `SIGNUP_MODE` is auto-joined to that tenant as `member`; the session always resolves to it. **Disabled surface**: `OrgSwitcher`, `/select-tenant`, `create-org` / `delete-org` routes, "new organisation" branch of access-request approval, `/admin/tenants` list (collapses to the one tenant's detail), `onNoTenant` → auto-join. **Kept**: members/roles/invitations, tenant settings (rendered as "Workspace settings"), `/admin` users + access requests, analytics, AI settings. Server enforces the mode (routes return 404 `tenancy_mode_single`), UI hides it via a `useTenancyMode()` flag from `/auth/session`; a `tests/api/tenancy-single.test.ts` proves the disabled routes 404 and auto-join works. | Most internal GM apps start as one-org tools; keeping the data model multi-tenant costs nothing and preserves the upgrade path. |
| D24 | Ports / local | UI 3000 (vite, proxies `/api`,`/auth`,`/ws`,`/cubejs-api` → 3001), API 3001 (`wrangler dev`), dev Postgres 5432, test Postgres 5433 (image `pgvector/pgvector:pg17`). `cfld` tunnel included (`dev:tunnel`; `wrangler dev --var APP_URL:`). | Consistency across both repos' conventions. |

### 1.3 Additions that exist in neither repo (all small, all justified above)

`ErrorBoundary`, global 401 handling, `TENANCY_MODE` (single/multi switch), `SIGNUP_MODE` + domain allow-list, `BOOTSTRAP_ADMIN_EMAILS`,
`activity_events` table (generic audit/activity log — also the analytics example source), `ai_usage`
table, `timestamps()` / `tenantRef()` schema helpers (standardise `timestamptz`), `createRouter()`
factory, shared error envelope override for zValidator, `tests/config/wrangler-parity.test.ts`,
`scripts/cf-provision.sh`, `gitleaks` CI step.

### 1.4 Open for the user (defaults chosen; say so to change)

1. **`SIGNUP_MODE` default** — chosen `invite_only`. `open` is friction-free for demos.
2. **`support` role visible in the customer's member list** — chosen yes (Mirevue transparency default).
3. **Separate `AUTH_SIGNING_KEY` vs reuse `OAUTH_ENCRYPTION_KEY`** — chosen separate (one more secret, independent rotation).
4. **Personal API keys in addition to tenant keys** — chosen tenant-only for v1 (GM's `?userOnly=` documented).
5. **Kit package/app name token** — using `<APP>` / `gmgo-starter` until told otherwise.

---

## 2. Proposed kit tree

```
gmgo/
├── CLAUDE.md  AGENTS.md→CLAUDE.md  README.md  SETUP.md
├── docs/  CONCEPTS.md  DEPLOY.md  ADAPTING.md  RLS.md  ai.md  DASHBOARD_PATTERNS.md  analysis/ (this folder)
├── .claude/rules/  api.md  database.md  ui.md  testing.md  code-quality.md  cloudflare.md
├── .github/workflows/  ci.yml  deploy.yml
├── wrangler.toml  wrangler.staging.toml  worker-configuration.d.ts  .dev.vars.example  .env.test
├── package.json  tsconfig.json  biome.json  vite.config.ts  vitest.config.ts  postcss.config.js  drizzle.config.ts
├── docker-compose.dev.yml  docker-compose.test.yml  .nvmrc  .gitignore
├── migrations/                      # drizzle-kit output, committed (0000_init written fresh)
├── scripts/  migrate.ts  db-roles.ts  seed.ts  test-db-connection.ts  tunnel-dev.mjs  cf-provision.sh
│             refresh-fact-tables.ts  check-fact-table-freshness.ts
├── tests/
│   ├── setup.ts  api-setup.ts  mocks/bindings.ts  helpers/{db,auth,request}.ts
│   ├── api/  auth-*.test.ts  members.test.ts  invitations.test.ts  admin.test.ts  keys.test.ts  csrf.test.ts
│   │         rls-coverage.test.ts  rls.test.ts(skipped unless enforce)  unscoped-allowlist.test.ts
│   │         cubes/{security,cube-isolation}.test.ts  services/fact-table-refresh.test.ts
│   │         ai/{resolve,agent-runtime,chat}.test.ts  ws.test.ts  scheduled.test.ts
│   ├── config/  wrangler-parity.test.ts  env-schema.test.ts
│   ├── dashboards/all-templates.test.ts
│   └── ui/  setup.ts  helpers/renderWithProviders.tsx  contrast.test.ts  + shell tests
└── src/
    ├── worker.ts                    # default { fetch, queue, scheduled }; export DO + Workflow classes
    ├── config.ts                    # zod over Cloudflare.Env; loadConfig(env) memoised
    ├── shared/                      # zod contracts used by API and UI (CLAUDE.md)
    │   errors.ts  pagination.ts  auth.ts  tenants.ts  access-requests.ts  permissions.ts
    │   notifications.ts  admin.ts  tenant-settings.ts  analytics.ts
    │   ai/{config,agent-models,agents,progress,chat,tool-labels}.ts  prompts/{registry,defaults,contracts}.ts
    ├── permissions/  abilities.ts  index.ts  CLAUDE.md
    ├── db/
    │   client.ts  tenant-scope.ts
    │   schema/  index.ts  _helpers.ts  rls.ts  CLAUDE.md
    │            users.ts  tenants.ts  tenant-users.ts  team-invitations.ts  access-requests.ts
    │            oauth-providers.ts  keys.ts  tenant-settings.ts  tenant-user-settings.ts
    │            notifications.ts  activity-events.ts  analytics-pages.ts  facts/tenant-activity-daily-facts.ts
    │            ai-configs.ts  agent-models.ts  prompt-overrides.ts  conversations.ts  messages.ts
    │            agent-runs.ts  agent-run-events.ts  ai-usage.ts  documents.ts  chunks.ts
    ├── dashboards/  index.ts  general-templates/{index,tenant-overview}.ts
    ├── api/
    │   index.ts                     # Hono<AppEnv> assembly, middleware order (04 §10), mounts, ASSETS catch-all
    │   types.ts  queue.ts  scheduled.ts
    │   middleware/  config  request-logger  security-headers  body-limit  cors  csrf  database
    │                auth  permissions  rate-limit  operation-guard  error-handler  CLAUDE.md
    │   auth/  sessions  cookies  signed-tokens  magic-link  oauth-encryption  token-crypto  oauth-providers
    │          api-keys  providers/{types,google,microsoft,index}.ts
    │   routes/  CLAUDE.md  health  auth/{index,oauth,magic-link,dev-login,session-management,provider-management,helpers}
    │            keys  members  invitations  tenants  admin  notifications  user-settings  tenant-settings
    │            ws  files  analytics-pages  cube-api  ai-config  agent-models  prompts  chat  agent-runs
    │   services/  email  notification  storage  dashboard-templates  prompts
    │              fact-tables/{registry,refresh,freshness,queries/tenant-activity-daily}.ts
    │              ai/{providers,resolve,embeddings,kit,errors,connection-test}.ts
    │              agents/{runtime,queue,run-log,registry,examples/summarize-text}.ts
    │              chat/conversations.ts  retrieval.ts
    │   cubes/  index  security  users  tenant-users  activity-events  tenant-activity-daily
    │   workflows/  agent-run.ts  utils.ts
    │   durable-objects/  notifications-hub.ts
    │   observability/  tracer  langfuse-fetch  tracing  analytics
    │   utils/  core/{errors,logger,keys,ids}  routes/{route-helpers,router,pagination,broadcast,with-resource,agent-progress}
    │           db/{tenant-helpers,access-helpers}
    └── ui/  (06 §a tree)  index.html  main.tsx  App.tsx  index.css  CLAUDE.md
         components/{…shell, shared/, permissions/, ai/, analytics/}
         hooks/  lib/{api-client,queryClient,query-options,websocketClient,environment,sse,agentProgress,chatStream}
         stores/  pages/{Home,Login,MagicLinkVerify,InviteAccept,SelectTenant,Pending,NotFound,Profile}
         pages/settings/{SettingsLayout,General,People,ApiKeys,AIProvider,AgentModels,Prompts}
         pages/admin/{AdminLayout,AccessRequests,TenantList,TenantDetail,UserList,UserDetail}
         pages/analytics/{DashboardList,DashboardView,QueryBuilder}  pages/chat/ChatPage  pages/agents/AgentRuns
```

### Bindings (wrangler.toml)

`ASSETS` · `HYPERDRIVE` (+ `HYPERDRIVE_APP` only when `enforce` is supported) · `RATE_LIMIT_KV` ·
`JOBS_QUEUE` (producer+consumer) · `AGENT_RUN_WORKFLOW` (`<APP>-agent-run[-staging]`, account-scoped) ·
`NOTIFICATIONS_HUB` (DO, `[[migrations]] v1`) · `FILES` (R2) · `AI` (Workers AI) ·
`ANALYTICS_ENGINE` (optional) · `[triggers] crons = ["15 * * * *", "0 4 * * *"]` (fact refresh; nightly prune).
`compatibility_flags = ["nodejs_compat"]`, `[assets] not_found_handling = "single-page-application"`,
`[observability.logs] enabled`, `[placement] mode = "smart"`.

### Env (names only)

Vars: `APP_ENV` `APP_URL` `APP_NAME` `RELEASE_VERSION` `LOG_LEVEL` `EMAIL_FROM` `TENANCY_MODE` `SIGNUP_MODE`
`TENANT_SCOPE_MODE` `LANGFUSE_BASE_URL` `AGENT_MAX_OUTPUT_TOKENS` `AGENT_MAX_TURNS`.
Secrets: `DATABASE_URL` (dev/fallback) `PREVIEW_DATABASE_URL` `OAUTH_ENCRYPTION_KEY` `AUTH_SIGNING_KEY`
`BOOTSTRAP_ADMIN_EMAILS` `RESEND_API_KEY` `GOOGLE_CLIENT_ID/SECRET` `MICROSOFT_CLIENT_ID/SECRET`
`ANTHROPIC_API_KEY` `EMBEDDINGS_API_KEY` `LANGFUSE_PUBLIC_KEY/SECRET_KEY`.
Scripts only: `APP_DATABASE_URL` (db-roles). CI: `DATABASE_URL` `CLOUDFLARE_API_TOKEN` `CLOUDFLARE_ACCOUNT_ID`.

---

## 3. Build plan (phased; each phase leaves `lint && typecheck && test && build` green)

| Phase | Scope | Exit criterion |
|---|---|---|
| **0 Skeleton** | git init; tooling (D22); `wrangler*.toml` with placeholders; `config.ts`; `db/client.ts` + `_helpers` + `rls.ts`; `migrate.ts`/`db-roles.ts`/compose; `worker.ts` + `api/index.ts` with middleware chain + `/api/health`; UI shell renders; vitest 4 projects + bindings mock + parity test; CI `ci.yml`; docs *skeletons* (CLAUDE.md, SETUP Part 1). | `pnpm dev` serves hello; tests green; parity test red on placeholders (expected). |
| **1 Identity** | Schema (users, tenants, tenant_users, invitations, access_requests, oauth_providers, keys, settings, notifications, activity_events); auth module (D11, D12); tenancy + CASL (D9, D10, D25 incl. single-tenant test); email; members/invitations/tenants/admin routes; UI auth pages, settings, admin, `AbilityProvider`, ErrorBoundary, 401 handling; seed; tests. | Log in via magic link with zero creds, invite a member, switch tenant, admin approves an access request; same flow passes with `TENANCY_MODE=single` (no switcher, auto-join). |
| **2 Substrate** | `NotificationsHub` DO + `/ws` + client store; `JOBS_QUEUE` consumer; `scheduled.ts` (prune task); `StorageService` over R2 + files route; `AGENT_RUN_WORKFLOW` shell (no AI yet) with status row/claim/cancel. | Realtime toast on invite; cron runs locally via `/cdn-cgi/handler/scheduled`; workflow completes and nudges UI. |
| **3 AI** | D17/D18: shared contracts, providers/resolve/kit/embeddings, `ai_configs`/`agent_models`/`prompts`/`ai_usage` + settings pages; chat (conversations/messages, SSE route, ChatPanel); agent runtime on the Workflow + `summarize-text` + runs page; tracing seam + Langfuse fetch; pgvector `documents`/`chunks` + `retrieval.ts`. Spike: tool loop as `step.do` turns. | Configure Anthropic key in Settings, chat streams, run the example agent, trace appears in Langfuse when keys set. |
| **4 Analytics** | D19: cubes, `cube-api` mount, `analytics_pages` + templates service, fact-table registry/refresh/freshness + cron, dashboard UI, isolation test, template test. | `tenant-overview` dashboard renders with live numbers for the seeded tenant; cross-tenant test passes. |
| **5 Ship-ready** | `deploy.yml` release dance; `cf-provision.sh`; `SETUP.md` Part 3; `DEPLOY.md`; `ADAPTING.md`; `CONCEPTS.md` full; all `.claude/rules` + `src/**/CLAUDE.md`; gitleaks; provenance/archive convention. | A fresh agent can copy the repo, follow `ADAPTING.md` → `SETUP.md`, and deploy to a new CF account with only placeholders + secrets changed. |
| **Track R (parallel, optional)** | RLS-over-Hyperdrive spike per 03 §9b; outcome recorded in `docs/RLS.md`; `enforce` promoted or explicitly unsupported. | Go/no-go documented. |

Estimated order of magnitude: Phase 0–1 is the bulk of hand-porting (~120 files); 2–4 are mostly
mechanical ports with the CF re-plumbing concentrated in `agents/queue.ts`, `workflows/agent-run.ts`,
`durable-objects/notifications-hub.ts`, and `services/fact-tables/refresh.ts`.

---

## 4. Risks to carry forward (cross-cutting)

1. **RLS × Hyperdrive caching** is undocumented — `--caching-disabled` on any app-role binding until the spike proves otherwise (03).
2. **Coalescing back-pressure has no CF primitive** — the claim-row pattern must be designed and tested, not faked in memory (05, 09).
3. **Agent tool loop as Workflow steps** — state between turns must be serialisable; needs the Phase 3 spike (09).
4. **Cube isolation is convention** — the two-tenant test is the guard; frozen measure names need the template structural test + reset-to-template (08).
5. **Account-scoped Workflow names and `[limits]` per-step CPU** — encoded in the parity test so GM's two production incidents can't recur (07).
6. **Docs drift** — Non-Negotiable + CI check that every `src/**/CLAUDE.md` dir exists and every `docs/*.md` is linked (07).
7. **Bundle** — kit lands well under 1 MB gzip once Paddle/exceljs/pptx are gone; drizzle-cube's optional peers (AI SDKs, elkjs, xyflow, exceljs) must be *not* installed or explicitly tree-shaken (08).

## 5. Secrets hygiene — report to owner (found in GM's working tree, none copied anywhere)

- `~/work/guidemode/apps/server/.dev.vars`: live values **and comment lines** holding Neon connection strings (dev/prod/test) plus commented provider keys → rotate the Neon role password and both provider keys.
- `~/work/guidemode/.claude/settings.local.json`: two allow-list entries embed a live Neon staging URL → delete.
- `~/work/guidemode/apps/server/.drizzle-cube.json`: live production API token → rotate; kit ships `.example` only.
- `wrangler.toml [vars] PADDLE_CLIENT_TOKEN`: public-by-design client token, but app config the kit must not inherit.

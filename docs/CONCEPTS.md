# CONCEPTS — what is built, and why

The reference for someone about to change something: what each subsystem does, the invariant it
protects, and the decision behind it (recorded as D-numbers in `docs/analysis/00-SYNTHESIS.md`).

This file is deliberately **not**: setup (`SETUP.md`), Cloudflare topology (`docs/DEPLOY.md`), code
conventions (`.claude/rules/*.md`, `src/**/CLAUDE.md`), or the RLS runbook (`docs/RLS.md`). Every
section ends with **Known gaps**; sections for phases not yet built say so.

| § | Section | Status |
|---|---|---|
| 1 | [Tenancy](#1-tenancy) | Phase 1 |
| 2 | [Auth](#2-auth) | Phase 1 |
| 3 | [API shell](#3-api-shell) | Phase 0 |
| 4 | [Database](#4-database) | Phase 0 |
| 5 | [Background work and realtime](#5-background-work-and-realtime) | Phase 2 |
| 6 | [Email and storage](#6-email-and-storage) | Phase 1–2 |
| 7 | [UI shell](#7-ui-shell) | Phase 0–1 |
| 8 | [Analytics](#8-analytics) | Phase 4 |
| 9 | [AI layer](#9-ai-layer) | Phase 3 |
| 10 | [Deployment](#10-deployment) | Phase 0 / 5 |
| 11 | [Definition of done](#11-definition-of-done-for-the-kit) | |

Provenance: extracted from two internal GM applications — one supplied the structure, docs system,
auth/tenancy/AI layer; the other the Cloudflare substrate and analytics. Nine subsystem analyses
(`docs/analysis/01–09`) and the synthesis are the decision record.

---

## 1. Tenancy

**Status: planned (Phase 1).**

**Every row of domain data belongs to a tenant, and the schema is identical whether the app runs
as one tenant or many.** `TENANCY_MODE = multi | single` (D25) is configuration, not a fork:

- `multi` (default): users belong to many tenants through `tenant_users`; the session carries the
  current tenant; `OrgSwitcher` and `/select-tenant` switch it; global admins manage tenants at `/admin`.
- `single`: one tenant is created at bootstrap (seed, or the first verified `BOOTSTRAP_ADMIN_EMAILS`
  login becomes `owner`); every admitted user is auto-joined as `member`; the session always resolves
  to it. Disabled surface returns 404 `tenancy_mode_single` server-side and is hidden client-side via
  `useTenancyMode()`. Members, roles, invitations, "Workspace settings", `/admin` users and access
  requests, analytics and AI settings all remain. Flipping to `multi` later needs no migration.

**Sign-up is a mode too.** `SIGNUP_MODE = open | invite_only | approval` (D9), default `invite_only`:

- `invite_only`: signing in does not create an organisation. An uninvited login gets a `users` row
  and lands on `/pending` with no access request (nothing for admins to review).
- `approval`: the uninvited login also files one `access_requests` row (written at *verify* time, not
  at magic-link *request* time, so the queue cannot be spammed by typing a stranger's address). Global
  admins approve into a new or existing tenant, or reject with a note. An optional domain allow-list
  (`SIGNUP_ALLOWED_DOMAINS`) short-circuits obvious outsiders.
- `open`: a member-less user gets a personal tenant via the single `onNoTenant` hook.

Invited users are unchanged in every mode: `handlePendingInvitation` runs first on every login path.
All four login paths share the fallback and all gate on "has no memberships" — not "is new", which
strands a user who lost their last organisation.

**Roles and abilities (D10, 02 §10b).** `tenant_users.role` is `owner | admin | member` (assignable)
or `support` (minted only from `/admin`, excluded from member counts, visible to the customer by
design). `users.isGlobalAdmin` is a platform flag, not a tenant role. CASL subjects: `all`, `Tenant`,
`TenantMember`, `Invitation`, `ApiKey`, `Notification`, plus an `access` hook over an injected
`features: string[]`.

| Subject \ Role | globalAdmin | owner | admin | support | member |
|---|---|---|---|---|---|
| `all` | manage | – | – | – | – |
| `Tenant` (settings; delete*, ownership*) | manage | manage | read | manage | read |
| `TenantMember` | manage | manage | manage | manage | read |
| `Invitation` | manage | manage | manage | manage | read |
| `ApiKey` | manage | manage | manage | manage | read (own, route-scoped) |
| `Notification` (own) | manage | manage | manage | manage | manage |

`*` Deleting a tenant and assigning/changing `owner` additionally require an explicit
`role === 'owner'` check — CASL conditions are not used anywhere, so don't pretend they are. A new
app subject defaults to owner/admin/support `manage`, member `read` with route-scoped writes.

**Admin area.** `/admin` (UI) and `/api/admin/*` behind `globalAdminMiddleware` is the only place
with cross-tenant queries by design, so the blast radius is one file. "Entering" a customer tenant
inserts a real `support` membership; `authMiddleware` keeps its single "must be a member" invariant.

**Isolation = predicates + inert RLS (D1).** Every query filters by `tenantId` from the auth
context; every tenant table also carries an RLS policy that is not enforced until `TENANT_SCOPE_MODE
= enforce` — see §4 and `docs/RLS.md`.

**Known gaps / not built yet:** no audit log of admin actions beyond `activity_events`; the domain
allow-list is new code with no production history; feature-flag source for `access` is undecided
(inject `features`, keep it open); personal API keys are not in v1 (tenant keys only).

## 2. Auth

**Status: planned (Phase 1).**

**Sessions are rows.** `user_sessions` is DB-backed with a 7-day sliding TTL; the cookie is
`__Host-session` (no `Domain`, `Secure` when `APP_ENV !== development`, `SameSite=Lax`,
`HttpOnly`). `authMiddleware` resolves session → user → membership → ability in one LATERAL query
and does bookkeeping (`last_used`, cleanup) in `waitUntil`. Bearer `Authorization` is the second
strategy: hashed tenant API keys in `keys`, `expires_at` checked, soft revoke.

**Magic link** is the zero-credential path: an HMAC-signed, 15-minute, single-use token stored
hashed (SHA-256, not `btoa`). Without `RESEND_API_KEY` the URL is logged by `wrangler dev`, so a
fresh clone can log in with nothing configured. Dev-login (`/auth/dev-login`) exists and 404s in
production.

**OAuth is a registry, not a copy-paste.** One generic `/auth/:provider` + `/auth/:provider/callback`
router over `ProviderDefinition`s (`src/api/auth/providers/`), v1 = Google + Microsoft via arctic
(D11). Redirect URIs derive from `APP_URL` — no `*_REDIRECT_URI` variables. A single `oauth_state`
cookie carries the provider and PKCE state. Account linking is by verified email, and
`emailVerified !== false` is enforced for every provider. Tokens are AES-GCM encrypted at rest with
`OAUTH_ENCRYPTION_KEY`; `UNIQUE (provider, provider_user_id)`. GitHub/Slack are documented additions.

**Security properties fixed during the port (D12):** SHA-256 token hashing; signing key from
`AUTH_SIGNING_KEY` (never derived from `DATABASE_URL`; separate from the encryption key so they
rotate independently); `OAUTH_ENCRYPTION_KEY` required (no plaintext pass-through);
`crypto.getRandomValues` for key material; CSRF by origin allow-list (`APP_URL` + localhost dev
ports) with Bearer requests exempt; KV sliding-window rate limit on login routes (`RATE_LIMIT_KV`,
approximate by design, no-op when the binding is absent); the same KV backs `operationLock` for
per-tenant single-flight operations.

**Known gaps / not built yet:** provider token refresh cron is optional and not in v1; CLI/device
auth flow is documented, not shipped; rate limiting is approximate (Workers Rate Limiting binding
is the exact alternative); session revocation UI beyond "log out everywhere" is absent.

## 3. API shell

**Status: built (Phase 0).**

**One Worker, one app, one env.** `src/worker.ts` exports `{ fetch, queue, scheduled }` and the DO
and Workflow classes; `src/api/index.ts` exports the Hono `app` only so tests drive it with
`app.request(req, env, ctx)` (D5). `loadConfig(env)` (D3) validates `Cloudflare.Env` with zod once
per isolate (memoised by env identity, so a `.dev.vars` edit under `wrangler dev` re-validates) and
is called at the top of all three entry points. Routes read `c.get('config')`, never `c.env`, and
`process.env` is forbidden in `src/`. `APP_ENV` replaces `NODE_ENV` (D4).

**Middleware order and why** (04 §10): `onError` first so config failures get the envelope →
request logger (request id for everything) → config → security headers → body limit → CORS (before
CSRF so preflights are answered) → CSRF (cheap, no DB) → database (per-request client, first real
cost) → optional tracing flush → mounts. Auth is per-mount because the public surface (health,
OAuth callbacks, invite accept) is small and enumerable. The ASSETS catch-all serves the SPA and
404s `/api|/auth|/cubejs-api|/mcp` so a missing route never returns `index.html`.

**Contracts (D13).** zod schemas in `src/shared/` are the API contract; the server validates with
them, the UI parses responses with them. No `hono/client` RPC (it drags the server type graph into
the browser). Error envelope `{ error, statusCode, code?, details? }` everywhere including validation
failures (the `validate()` wrapper throws `ValidationError` instead of zValidator's raw body); success bodies are bare. Pagination is `{ page, pageSize, total, totalPages }`.
`createRouter()` replaces bare `new Hono()` and there is no `declare module 'hono'` augmentation.

**Routes are thin** (`withAuthAndDb` → `guardPermission` → tenant-filtered query → optional
broadcast) and **never run long work** — they enqueue or create a workflow instance (§5).

**Config model.** Non-secrets live in `[vars]`: `APP_ENV`, `APP_URL`, `APP_NAME`, `RELEASE_VERSION`
(injected by CI), `LOG_LEVEL`, `EMAIL_FROM`, `TENANCY_MODE`, `SIGNUP_MODE`, `TENANT_SCOPE_MODE`,
`LANGFUSE_BASE_URL`, `AGENT_MAX_*`. Secrets live in `.dev.vars` / `wrangler secret put`.

**Known gaps / not built yet:** `/api/ready` smoke step in CI against a preview URL is not wired;
OpenAPI generation (`@hono/zod-openapi`) is the upgrade path if ever needed and should be adopted
before routes multiply; per-PR preview deployments (`PREVIEW_DATABASE_URL` hook exists, inert).

## 4. Database

**Status: built (Phase 0); schema lands in Phase 1.**

**One driver, one client per request.** `postgres.js` only (D2): `createDatabase(url) → { db,
close }`, built in `databaseMiddleware` (or at the top of a queue consumer / workflow step / cron
task) and closed via `ctx.waitUntil(close())` or `finally`. `resolveDatabaseUrl(env) =
PREVIEW_DATABASE_URL ?? env.HYPERDRIVE.connectionString ?? DATABASE_URL` — the same code path in
production (Hyperdrive → Neon), `wrangler dev` (`localConnectionString`) and tests (`.env.test`).
Hyperdrive is the pool; the client's `max` is small; `LISTEN/NOTIFY`, advisory locks and `PREPARE`
are unsupported through it and unused on the request path. Transactions are why postgres.js was
kept (invite accept, tenant create, future RLS) — keep them short.

**Schema conventions.** One file per table; `tenantRef()` and `timestamps()` helpers standardise the
tenant FK and `timestamptz` columns (both source apps mixed `timestamp` and `timestamptz`); `pgEnum`
values append-only; migration `0000_init` is written fresh and creates the `vector` extension (D17).

**Migrations flow.** `pnpm db:generate` → read the SQL → `pnpm db:migrate` = `db-roles --phase=role`
→ `migrate.ts` → `db-roles --phase=grants`. Role first because a policy's `TO gmgo_app` needs it;
grants after because `REVOKE` needs the tables. `migrate.ts` rewrites a Neon `-pooler` host to the
direct host so DDL never lands on a pooled backend with a stale GUC. In CI (`deploy.yml`) the same
runs as `db:migrate:ci` before `wrangler deploy`.

**RLS upgrade path.** Policies via `tenantIsolation()` on every tenant table, `gmgo_app` created
`NOLOGIN` via SQL, `withTenantScope` that becomes `db.transaction + set_config(..., true)` under
`enforce`, and a catalog-driven coverage test — all inert by default. The spike, go/no-go and the
switch-on procedure are in `docs/RLS.md`.

**Known gaps / not built yet:** the RLS spike has not been run (Track R); `pin` mode from the source
app is dropped (it soaked Node connection pinning, which no longer exists); no read replica routing.

## 5. Background work and realtime

**Status: planned (Phase 2).**

**A route never runs long work; it enqueues (fire-and-forget, < 30 s total) or creates a workflow
(multi-step, retries, minutes+). Cron only dispatches.** (05 §1.4, D7)

| Need | Primitive | Kit shape |
|---|---|---|
| plain job | `JOBS_QUEUE` (one queue) | typed producer helper; consumer `processJobsBatch(batch, env)` switched on `batch.queue`; retry policy in the toml + `message.retry({ delaySeconds })` |
| durable multi-step | `AGENT_RUN_WORKFLOW` (one class) | the agent runtime *is* the example workflow — no throwaway second one |
| periodic | `[triggers] crons` | `scheduled.ts` dispatch table on `event.cron`; each task try/caught; `0 4 * * *` prune, `15 * * * *` fact refresh (Phase 4) |

**What replaced the Node queue semantics.** `exclusive` (singleton per key) → a deterministic
Workflow instance id `<kind>:<tenant>:<subject>` with a `get()` probe. **Coalesce has no Cloudflare
primitive** — it becomes a DB claim row: `UPDATE agent_runs … WHERE status IN ('queued','running')
RETURNING`, with a running row setting `rerun_requested`. A redelivered message that finds the row
settled is a no-op. Never fake either in an in-memory `Map` — isolates are many and short-lived.
Cancellation is cooperative: flip the row, the loop polls status between turns. Orphan sweep is a
cron task. Progress is durable in `agent_run_events`; the DO only wakes viewers.

**Realtime (D8).** The `NotificationsHub` Durable Object (hibernation API, tenant/user tags, RPC
methods) lives in this Worker — the source app split it into a second worker only to keep preview
URLs, which the kit does not have. `/ws` upgrade auth: session cookie → membership check → forward to
the DO stub. **"DB is the truth, WebSocket is a nudge"**: payloads are `{ entity, id }`, the client
maps entity → query keys and re-fetches; the UI never trusts socket payloads as state. Routes go
through `services/notification.ts`, never the DO. Client: jittered backoff, upgrade fast-path,
`ConnectionBanner` when degraded.

**Known gaps / not built yet:** SSE `Last-Event-ID` replay for run progress is deferred (no NOTIFY
wake); per-user targeting in the hub is optional; dead-letter queue is declared in comments only;
`@cloudflare/vitest-pool-workers` smoke project for DO/Workflow is not in v1.

## 6. Email and storage

**Status: email Phase 1, storage Phase 2.**

**Email** is Resend over plain `fetch` (no SDK), `sendEmail(env, to, subject, html)`, with shared
`emailShell`/`ctaButton` helpers and three templates: magic link, tenant invitation, invitation
accepted. From-address and branding come from `EMAIL_FROM`, `APP_NAME`, `APP_URL`. Absent
`RESEND_API_KEY` → log and skip; the magic-link route logs the URL itself so login works with zero
configuration. Sends are best-effort in `waitUntil` — a failure never breaks the requester's login.

**Storage (D23)** is the `StorageService` interface (`upload`, `download`, `head`, `delete`,
`exists`, `buildStorageKey`, `sanitizeFilename`) over the native `FILES` R2 binding. Keys are
tenant-prefixed (`tenants/<tenantId>/…`); bytes stream through the Worker. `wrangler dev` emulates R2
locally, so there is no filesystem adapter.

**Known gaps / not built yet:** presigned URLs (the binding cannot mint them — needs S3 credentials
+ `aws4fetch`); no per-tenant storage configuration; email templates are neutral and need branding.

## 7. UI shell

**Status: shell Phase 0; pages Phase 1.**

**Design tokens, not raw colours.** `src/ui/index.css` holds two DaisyUI themes (`gm-light`,
`gm-dark`) whose brand hexes live in one header block, plus semantic surface/border/text tokens,
shape/motion tokens, a base layer (focus ring, reduced motion, tabular numerals) and component
primitives (`.surface-panel`, `.data-table`, `.status-badge`). `tests/ui/contrast.test.ts` gates the
emitted tokens; the palette *pipeline* is documented, not shipped (D20). Tailwind v4 scans via
`@source`; the safelist exists only for classes built from props.

**Providers, in order** (06 §b): `ErrorBoundary` → `QueryClientProvider` → `AuthProvider`
(`GET /auth/session`, zod-parsed, tenant selection) → `AbilityProvider` (CASL from
`session.permissions`) → `WebSocketProvider` → `BrowserRouter` → routes with `Layout` mounted once
under `/*`. Neither source app had an `ErrorBoundary` or global 401 handling; the kit adds both —
`QueryCache.onError` clears the client and redirects to `/login?returnUrl=`.

**Guards.** One `RequireGuard` primitive composed into coarse role guards and fine ability guards
(`RequireAbility`, `<Can>`); `SideNav` flags use the same guard as the page. `EnvironmentBadge`
and the version footer read `APP_ENV`/`RELEASE_VERSION` so staging never looks like production.

**Data layer.** `api-client.ts` (`credentials: 'include'`, `ApiError` from the envelope, `schema`
option) → one hook file per resource → `queryKeys` factory → `queryOptions` for shared queries.
zustand holds only websocket state.

**Known gaps / not built yet:** route preloading only if derived from one route table; no "system"
theme option or cross-tab sync; dev quick-login account list should come from a dev-only endpoint.

## 8. Analytics

**Status: planned (Phase 4).**

**drizzle-cube is the semantic layer; tenant scoping is inside every cube's `sql()`.** The Hono
adapter is created per request at `/cubejs-api` and `/mcp`, both mounted behind `authMiddleware` and
added to the ASSETS 404 guard (D19). `extractSecurityContext` (one copy) reads `c.get('auth')` and
every cube filters on `ctx.securityContext.tenantId` — directly (`TenantUsers`, fact tables) or
via a junction subquery for global tables (`Users`). **This is convention, not enforcement**, so
`tests/api/cubes/cube-isolation.test.ts` (two tenants, same query, disjoint rows) is mandatory.

**Ship set.** Cubes `Users` + `TenantUsers` (both scoping patterns), `ActivityEvents` (event stream
over the generic `activity_events` table) and `TenantActivityDaily` over one fact table
`tenant_activity_daily_facts` — grain `(tenant_id, day, user_id)`, refreshed per tenant by
DELETE+INSERT from a registry at `:15`, with a freshness check (lag vs `MAX(created_at)` on the
source). One dashboard template, `tenant-overview`; `analytics_pages` are created lazily per tenant
from templates with "reset to template". drizzle-cube React components; **recharts only**.

**Frozen measure names.** Stored dashboards reference `Cube.measure` strings in JSONB. Renaming a
measure silently breaks every saved dashboard — `tests/dashboards/all-templates.test.ts` checks
templates structurally, and reset-to-template is the user-facing repair.

**Known gaps / not built yet:** cube access is authentication + tenant scope only (no per-cube CASL
gate); per-request compiler cost is fine for a kit (cube sets are the scaling path); drizzle-cube's
cache is per-isolate (a KV provider would be an extension); `rlsSetup` unused; reporting/export,
AI dashboard generation, benchmarks deferred.

## 9. AI layer

**Status: planned (Phase 3).**

**Three-tier configuration, one resolver** (D17): platform env defaults (`ANTHROPIC_API_KEY`,
`EMBEDDINGS_API_KEY`, `AGENT_MAX_OUTPUT_TOKENS`, `AGENT_MAX_TURNS`) → tenant `ai_configs` (scope ×
provider, encrypted credentials, one default per scope, `serviceTier`, `thinking`, last health
check) → `agent_models` (promptKey → config + model). `resolveClient(db, tenantId, env, promptKey?)`
is the only read path. Zero keys → Settings → AI says "not configured" and AI routes 503.

**Providers v1.** Chat: `anthropic`, `anthropic_compatible` (Fireworks/Moonshot as presets, not enum
values). Embeddings: `workers_ai` via the `AI` binding (default `@cf/baai/bge-m3`, 1024-dim, no key),
`openai`, `openai_compatible`. Vectors go to **pgvector on Neon**, not Vectorize; `EMBEDDING_DIM =
1024` is a column type and must be chosen before the first migration (D18). No Vercel AI SDK; Bedrock
deferred (Node-only event stream; `aws4fetch` recipe documented).

**Chat.** `conversations` / `messages`, one SSE route (`streamSSE` works on Workers), frames `meta |
delta | progress | done | error`, `ChatPanel` with markdown bubbles and a tool-step strip, zero
default tools, prompt key `chat` editable in Settings → Prompts. Post-stream persistence in `waitUntil`.

**Agents run on the Workflow.** `AgentRunWorkflow` executes the tool loop as `step.do` turns (state
between turns must be serialisable — Phase 3 spike). `enqueueRun` resolves the client first (a tenant
with no provider gets a 503 before anything is written), honours a `precheck`, applies `exclusive` or
`coalesce` via the claim row (§5), writes `agent_runs`, appends `agent_run_events`, nudges the DO.
The example agent is `summarize-text`: one terminal tool, persists a result, broadcasts. Its tests
also exercise the minimal ingest path (`ingest.ts`: text → chunk → embed → `documents`/`chunks`) so
`retrieval.ts` is never dead code.

**Tracing (D16).** `withAgentTrace` / `traceClient` seams with no-op defaults; the only backend is a
fetch-based Langfuse batcher flushed in `waitUntil` (or at step end). Presence of both keys is the
switch; no OpenTelemetry dependency. **Every LLM call goes through the traced client.**

**Usage.** `ai_usage` (tenantId, promptKey, model, input/output/cacheRead/cacheWrite tokens, at) is
written from the same usage tap — cheap now, impossible to backfill.

**Known gaps / not built yet:** budgets/quotas over `ai_usage`; rerank and context layers; prompt
versioning; evals harness; Bedrock/Azure/Gemini adapters; SSE duration cap + `Last-Event-ID`
reconnect for run progress.

## 10. Deployment

**Status: tomls, CI, deploy workflow and scripts built (Phase 0); first real deploy in Phase 5.**

Two standalone tomls (D6) — `wrangler.toml` production, `wrangler.staging.toml` — kept identical in
everything code can observe by `tests/config/wrangler-parity.test.ts`, with account-scoped names
suffixed `-staging`. Neon: one project, a branch and a role per environment, Hyperdrive per
environment on the **direct** host. The release dance: tag `X.Y.Z` → staging; publish the GitHub
Release → production, shipping the exact validated tag with `RELEASE_VERSION` injected. `ci.yml`
is the single gate (lint, typecheck + typegen diff, tests on real Postgres, `build:ui`,
`build:api`, gitleaks) and is *called* by `deploy.yml`, not copied. Full reference: `docs/DEPLOY.md`.

**Known gaps / not built yet:** `scripts/release.sh` (bump-commit-tag helper) is optional and not
shipped; no per-PR previews; a CI check that every `src/**/CLAUDE.md` exists and every `docs/*.md`
is linked is proposed, not implemented.

## 11. Definition of done for the kit

A fresh agent can copy the repository, follow `docs/ADAPTING.md` → `SETUP.md` Part 1 with zero
external credentials and log in via a logged magic link; invite a member, switch tenant, approve an
access request; run the same flow with `TENANCY_MODE=single`; receive a realtime toast; run the
example agent and see its trace when Langfuse keys are set; render the `tenant-overview` dashboard
with live numbers; and, following `SETUP.md` Part 3, deploy to a new Cloudflare account changing
only placeholders and secrets — with `lint && typecheck && test && build` green at every step and
every behaviour described here still true.

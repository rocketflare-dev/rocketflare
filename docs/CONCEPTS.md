# CONCEPTS — what is built, and why

The reference for someone about to change something: what each subsystem does, the invariant it
protects, and the decision behind it (D-numbers below are that decision record).

This file is deliberately **not**: setup (`SETUP.md`), Cloudflare topology (`docs/DEPLOY.md`), code
conventions (`.claude/rules/*.md`, `apps/web/src/**/CLAUDE.md`, `packages/shared/CLAUDE.md`), or the RLS runbook (`docs/RLS.md`). Every
section ends with **Known gaps**; sections for phases not yet built say so.

| § | Section | Status |
|---|---|---|
| 1 | [Tenancy](#1-tenancy) | Phase 1 |
| 2 | [Auth](#2-auth) | Phase 1 |
| 3 | [API shell](#3-api-shell) | Phase 0 |
| 4 | [Database](#4-database) | Phase 0 |
| 5 | [Background work and realtime](#5-background-work-and-realtime) | Phase 2–3 — built |
| 6 | [Email and storage](#6-email-and-storage) | Phase 1–2 — built |
| 7 | [UI shell](#7-ui-shell) | Phase 0–1 |
| 8 | [Analytics](#8-analytics) | Phase 4 — built (server + UI) |
| 9 | [AI layer](#9-ai-layer) | Phase 3 — built |
| 10 | [Deployment](#10-deployment) | Phase 0 / 5 |
| 11 | [CLI](#11-cli) | Phase 1 |
| 12 | [Shared package](#12-shared-package) | Phase 0 |
| 13 | [Upgrading a copy](#13-upgrading-a-copy) | built |
| 14 | [Definition of done](#14-definition-of-done-for-the-kit) | |
| 15 | [Feature flags](#15-feature-flags) | D30 — built |
| 16 | [Plugins](#16-plugins) | D31 — Phase A built |

Provenance: extracted from two internal applications — one supplied the structure, docs system,
auth/tenancy/AI layer; the other the Cloudflare substrate and analytics. This file is the decision
record that came out of them.

**Layout (D26).** The repo is a pnpm workspace: `apps/web` (`@rocketflare/web` — the Worker: Hono API +
React UI, everything in §§1–10), `apps/cli` (`@rocketflare/cli`, §11) and `packages/shared` (`@rocketflare/shared`,
§12 — the zod contracts all three consume). Root `package.json` scripts delegate with `pnpm -r` /
`--filter`; paths below are workspace-relative.

---

## 1. Tenancy

**Status: built (Phase 1).**

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
`TenantMember`, `Invitation`, `ApiKey`, `ActivityEvent`, `Notification`, `File`, `AiConfig`, `Prompt`,
`Conversation`, `AgentRun`, `Document`, `Dashboard`, `Analytics`, plus an `access` hook over an
injected `features: string[]`.

| Subject \ Role | globalAdmin | owner | admin | support | member |
|---|---|---|---|---|---|
| `all` | manage | – | – | – | – |
| `Tenant` (settings; delete*, ownership*) | manage | manage | read | manage | read |
| `TenantMember` | manage | manage | manage | manage | read |
| `Invitation` | manage | manage | manage | manage | read |
| `ApiKey` | manage | manage | manage | manage | read (own, route-scoped) |
| `ActivityEvent` | manage | manage | manage | manage | read |
| `Notification` (own) | manage | manage | manage | manage | manage |
| `File` (D23) | manage | manage | manage | manage | create + read (delete own: route's `ownerUserId` check) |
| `AiConfig`, `Prompt` (D17) | manage | manage | manage | manage | read |
| `Conversation` (D17) | manage | manage | manage | manage | manage (own only: routes filter by `userId`, others' threads are 404) |
| `AgentRun` (D7) | manage | manage | manage | manage | manage (own runs; admin+ see and cancel every run) |
| `Document` (D18) | manage | manage | manage | manage | create + read (delete own: route's `ownerUserId` check) |
| `Dashboard` (D19, `analytics_pages`) | manage | manage | manage | manage | read |
| `Group` (D29) | manage | manage | manage | manage | read (routes narrow it to their OWN groups) |
| `Analytics` (D19, the cube API `/cubejs-api`, `/mcp`) | manage | read | read | read | read (rows are tenant-scoped by every cube, §8) |

`*` Deleting a tenant and assigning/changing `owner` additionally require an explicit
`role === 'owner'` check — CASL conditions are not used anywhere, so don't pretend they are. A new
app subject defaults to owner/admin/support `manage`, member `read` with route-scoped writes.

**Admin area.** `/admin` (UI) and `/api/admin/*` behind `globalAdminMiddleware` is the only place
with cross-tenant queries by design, so the blast radius is one file. It is reachable **without a
membership**: a global admin with no tenant (the bootstrap admin of an `invite_only` deployment)
opens `/admin/*` directly — `ProtectedRoute`'s one exemption, and `/pending` / `/no-access` link
there — so there is always someone who can approve the first request. "Entering" a customer tenant
inserts a real `support` membership; `authMiddleware` keeps its single "must be a member" invariant.

**Groups and visibility (D29).** A tenant may declare group TYPES ("Department", "Region",
"Client"), each holding GROUPS, each holding members. Group membership is part of the auth context
(`AuthContext.groups`, resolved in the same LATERAL query as the membership; the Bearer path reads
the KEY'S CREATOR's groups on every request, so removing somebody from a group narrows their keys
with nothing to revoke) and it decides who may READ a knowledge document (§9) or a dashboard (§8).
It is core rather than an optional surface, and it is inert until somebody uses it: every row ships
`visibility: 'tenant'`.

**Visibility is an explicit column, not the absence of grants.** `documents.visibility` and
`analytics_pages.visibility` are `tenant | groups`; the junction tables (`document_groups`,
`analytics_page_groups` — one per resource, with a real FK and cascade) hold the grants. That
asymmetry is the whole design: deleting the last group a document was shared with leaves it
`groups` with an EMPTY grant list, which matches nobody, so it narrows to its owner and to admins.
Inferring "restricted" from "has grant rows" — what the app this was ported from did — makes the
same delete publish the document to the entire organisation, silently. Deleting a group or a type
that still grants anything is 409 `group_in_use` with a count; `?force=1` proceeds, always in the
narrowing direction.

**The predicate is SQL, never a CASL condition.** `api/services/access.ts` is the one place it
lives: `accessScopeOf(auth) → { tenantId, userId, groupIds, bypass }`, then
`visibleDocuments(scope)` / `visibleAnalyticsPages(scope)` — **ANDed with the tenant predicate,
never substituted for it**. `bypass` is `isAdminLevel`, so owner, admin, support and global admins
are not narrowed (support deliberately: it is admin-level everywhere else and is a membership row
the customer can see). The rule it follows is the kit's existing one — an ability answers "may this
role do this KIND of thing", and "is this row yours" is always a predicate in the query.

**Group membership grants READ only.** Editing a document or a dashboard stays where it was: the
owner, or `manage Document` / `manage Dashboard`. `PUT /api/ai/documents/:id/visibility` is the
owner or admin+; `PUT /api/analytics/pages/:id/visibility` is admin+. A member may only share with
groups they belong to (403 `group_not_yours`); an admin with any. Administering groups themselves
(`/api/groups`) is `manage Group` throughout, and a member's only read there is `GET /mine`.

**A membership change is a nudge to the people it moved.** `access.changed` goes to the affected
users through `nudgeUsers` and invalidates `['auth'] ['documents'] ['analytics'] ['groups']`, so
somebody who loses a group watches the content disappear rather than clicking into a 404; the admin
view refreshes tenant-wide on `entity.changed { entity: 'groups' }`.

**Isolation = predicates + inert RLS (D1).** Every query filters by `tenantId` from the auth
context; every tenant table also carries an RLS policy that is not enforced until `TENANT_SCOPE_MODE
= enforce` — see §4 and `docs/RLS.md`.

**The CLI is a tenant API key.** `rocketflare login` ends with a tenant-scoped key (§11), so every CLI call
is already inside one tenant and goes through the same `authMiddleware` Bearer path and CASL
abilities as the UI; in `single` mode the tenant-select step of the login handoff is skipped.

**Known gaps / not built yet (groups):** no IdP sync — SCIM Groups and SAML/Entra group claims are
the obvious next step and the kit has neither protocol; no hierarchy or inheritance (`parentId` was
deliberately not ported — a column nothing reads); groups grant no EDIT rights and carry no
per-group role; conversations, agent runs, prompts and files uploaded outside Knowledge have no
visibility; a document an agent writes (`summarize-text` with `index: true`) is always `tenant` —
inheriting its source's visibility is a follow-up; the group-member picker reads one page of 100
people, so a very large organisation must search rather than scroll.

**Known gaps / not built yet:** no audit log of admin actions beyond `activity_events`; the domain
allow-list is new code with no production history; personal API keys are not in v1 (tenant keys
only). (`features` now has a source — §15 — and it is deliberately NOT read through the `access`
ability.)

## 2. Auth

**Status: built (Phase 1).**

**Sessions are rows.** `user_sessions` is DB-backed with a 7-day sliding TTL; the cookie is
`__Host-session` (no `Domain`, `Secure` when `APP_ENV !== development`, `SameSite=Lax`,
`HttpOnly`). `authMiddleware` resolves session → user → membership → ability in one LATERAL query
and does bookkeeping (`last_used`, cleanup) in `waitUntil`. Bearer `Authorization` is the second
strategy: hashed tenant API keys in `keys`, `expires_at` checked, soft revoke.

**Magic link** is the zero-credential path: a random 256-bit, 15-minute, single-use token stored
hashed (SHA-256, not `btoa`). Without `RESEND_API_KEY` the URL is logged by `wrangler dev`, so a
fresh clone can log in with nothing configured. Dev-login (`/auth/dev-login`) exists and 404s in
production.

**OAuth is a registry, not a copy-paste.** One generic `/auth/:provider` + `/auth/:provider/callback`
router over `ProviderDefinition`s (`apps/web/src/api/auth/providers/`), v1 = Google + Microsoft via arctic
(D11). Redirect URIs derive from `APP_URL` — no `*_REDIRECT_URI` variables. A single `oauth_state`
cookie carries the provider and PKCE state. Account linking is by verified email, and
`emailVerified !== false` is enforced for every provider. Tokens are AES-GCM encrypted at rest with
`OAUTH_ENCRYPTION_KEY`; `UNIQUE (provider, provider_user_id)`. GitHub/Slack are documented additions.

**Security properties fixed during the port (D12):** SHA-256 hashing of random 256-bit tokens
(no key is ever derived from `DATABASE_URL`); `OAUTH_ENCRYPTION_KEY` required (no plaintext pass-through);
`crypto.getRandomValues` for key material; CSRF by origin allow-list (`APP_URL` + localhost dev
ports) with Bearer requests exempt; KV sliding-window rate limit on login routes (`RATE_LIMIT_KV`,
approximate by design, no-op when the binding is absent); the same KV backs `operationLock` for
per-tenant single-flight operations.

**CLI login handoff (D26).** `GET /auth/cli?redirect_uri=http://127.0.0.1:<port>/callback&hostname=`
(`apps/web/src/api/routes/auth/cli.ts`) is the one browser-to-terminal bridge. `redirect_uri` must
be exactly `http://127.0.0.1:<port>/callback` or `http://localhost:<port>/callback` — any port, no
query or fragment; anything else is a 400 `invalid_redirect_uri` — so the key never leaves the
machine. Without a session the route bounces to `/login?returnUrl=`, without a tenant to
`/select-tenant?returnUrl=` (skipped in `TENANCY_MODE=single`), then mints a tenant API key named
`cli:<sanitised hostname>` with scopes `['*']` through the same helper as `POST /api/keys` (so it is
visible and revocable in Settings → API keys like any other, and logged as `api_key.created` via
`cli`) and 302s to `redirect_uri?key=&tenant_id=&tenant_name=`. The key is shown exactly once; there
is no device-code flow and no refresh — revoke and log in again.

**Known gaps / not built yet:** provider token refresh cron is optional and not in v1; rate limiting
is approximate (Workers Rate Limiting binding is the exact alternative); session revocation UI
beyond "log out everywhere" is absent; the CLI key is not distinguished from other tenant keys
beyond its `cli:` name prefix (no separate scope).

## 3. API shell

**Status: built (Phase 0).**

**One Worker, one app, one env.** `apps/web/src/worker.ts` exports `{ fetch, queue, scheduled }` and the DO
and Workflow classes; `apps/web/src/api/index.ts` exports the Hono `app` only so tests drive it with
`app.request(req, env, ctx)` (D5). `loadConfig(env)` (D3) validates `Cloudflare.Env` with zod once
per isolate (memoised by env identity, so a `.dev.vars` edit under `wrangler dev` re-validates) and
is called at the top of all three entry points. Routes read `c.get('config')`, never `c.env`, and
`process.env` is forbidden in `apps/web/src/`. `APP_ENV` replaces `NODE_ENV` (D4).

**Middleware order and why** (04 §10): `onError` first so config failures get the envelope →
request logger (request id for everything) → config → security headers → body limit → CORS (before
CSRF so preflights are answered) → CSRF (cheap, no DB) → database (per-request client, first real
cost) → optional tracing flush → mounts. Auth is per-mount because the public surface (health,
OAuth callbacks, invite accept) is small and enumerable. The ASSETS catch-all serves the SPA and
404s `/api|/auth|/cubejs-api|/mcp` so a missing route never returns `index.html`.

**Contracts (D13, D26).** zod schemas in `packages/shared/src/` (`@rocketflare/shared`, §12) are the API
contract; the server validates with them, the UI and the CLI parse responses with them. No
`hono/client` RPC (it drags the server type graph into the browser). Error envelope `{ error, statusCode, code?, details? }` everywhere including validation
failures (the `validate()` wrapper throws `ValidationError` instead of zValidator's raw body); success bodies are bare. Pagination is `{ page, pageSize, total, totalPages }`.
`createRouter()` replaces bare `new Hono()` and there is no `declare module 'hono'` augmentation.

**Routes are thin** (`withAuthAndDb` → `guardPermission` → tenant-filtered query → optional
`nudge` through `services/realtime.ts`) and **never run long work** — they enqueue or create a
workflow instance (§5). Two deliberate exceptions to the global middleware: `/ws` is mounted without
`authMiddleware` (it resolves the cookie itself) and `/api/files` mounts its own larger body limit.

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
values append-only. `apps/web/scripts/migrate.ts` runs `CREATE EXTENSION IF NOT EXISTS vector` before
the migrations (D17/D18), so `chunks.embedding vector(1024)` applies on Neon and on the local
`pgvector/pgvector:pg17` image alike; `EMBEDDING_DIM` is a column type — a new dimension is a new
table, not an `ALTER`.

**The local port is chosen, not fixed.** `pnpm dev:db:up` runs `apps/web/scripts/dev-db.mjs`, which
gives each checkout its own compose project, container name and port. It keeps the port already in
`DATABASE_URL` while that is still free or still this checkout's — so a re-run never moves a working
database — and otherwise takes the next free one from 5432 (skipping the test database's 5433) and
writes it back to `.dev.vars`. Before this, `docker-compose.dev.yml` pinned `5432:5432` and a
`container_name`, and compose derives its project name from the directory (`apps/web` in every
checkout): a second copy of the kit on one machine either failed to start Postgres or silently
attached to the first copy's database, which is a data hazard, not just an inconvenience.
`DATABASE_URL` is the single truth downstream — `db:migrate`, `seed` and `drizzle-kit` read it
through dotenv, and `pnpm dev` passes it to `wrangler dev` as
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, the local override for the Hyperdrive
binding (the toml's `localConnectionString` remains the single-checkout default). `pnpm dev:db:down`
stops only this checkout's container; `pnpm dev:db:status` lists every dev database on the machine
and marks the one that is ours.

**Migrations flow.** `pnpm db:generate` → read the SQL → `pnpm db:migrate` = `db-roles --phase=role`
→ `migrate.ts` → `db-roles --phase=grants`. Role first because a policy's `TO rocketflare_app` needs it;
grants after because `REVOKE` needs the tables. `migrate.ts` rewrites a Neon `-pooler` host to the
direct host so DDL never lands on a pooled backend with a stale GUC. In CI (`deploy.yml`) the same
runs as `db:migrate:ci` before `wrangler deploy`.

**The cross-tenant allow-list.** `apps/web/tests/config/unscoped-allowlist.test.ts` (the `config`
project, no database) parses every `apps/web/src/**/*.ts` and fails when a query on a table that has
a `tenant_id` column sits inside a function that never names a tenant. The four exceptions carry a
written reason: the API-key `last_used_at` stamp, the pre-tenant login path, a file delete by
primary key whose caller already scoped it, and the nightly invitation prune. What it does NOT
prove: that `routes/admin.ts` is the only cross-tenant surface — admin queries DO name a tenant, the
one from the URL, so they never trip the check, and `globalAdminMiddleware` is what makes them safe.
The unit is the enclosing function, so a handler that scopes one query and forgets a second reads as
scoped.

**RLS upgrade path.** Policies via `tenantIsolation()` on every tenant table, `rocketflare_app` created
`NOLOGIN` via SQL, `withTenantScope` that becomes `db.transaction + set_config(..., true)` under
`enforce`, and a catalog-driven coverage test — all inert by default. The spike, go/no-go and the
switch-on procedure are in `docs/RLS.md`.

**Known gaps / not built yet:** the RLS spike has not been run (Track R); `pin` mode from the source
app is dropped (it soaked Node connection pinning, which no longer exists); no read replica routing;
the TEST database is still pinned to 5433 (`docker-compose.test.yml`, `.env.test` and the Postgres
service in `ci.yml` all name it), so two checkouts cannot run `pnpm test` at the same time — the dev
port is the one that moves; switching to a per-checkout project name for the dev database also
orphans the old `web_rocketflare-dev-data` volume, which the bootstrap reports once rather than
deleting.

## 5. Background work and realtime

**Status: built — jobs and realtime (Phase 2), the `AgentRunWorkflow` (Phase 3).**

**A route never runs long work; it enqueues (fire-and-forget, < 30 s total) or creates a workflow
(multi-step, retries, minutes+). Cron only dispatches.** (05 §1.4, D7)

| Need | Primitive | Kit shape |
|---|---|---|
| plain job | `JOBS_QUEUE` (one queue) — **built** | `enqueueJob(queue, input)` (`services/jobs.ts`) → `processJobsBatch(batch, { env, config, logger })` (`queues/jobs.ts`) dispatched on `type` through one merged handler table (`queues/handlers/*` plus each installed plugin's, §16); `queue.ts` routes `batch.queue` by prefix |
| durable multi-step | `AGENT_RUN_WORKFLOW` (one class) — **built** | `AgentRunWorkflow` (`api/workflows/agent-run.ts`): `claim → (execute#N → resume#N \| expire#N)* → finish`, bodies in `services/agents/runtime.ts`; `resume#N` is `step.waitForEvent` — the run parks on a human and the round number is part of every step NAME (§9). The agent runtime *is* the example workflow — no throwaway second one |
| periodic | `[triggers] crons` | `scheduled.ts` dispatch table on `event.cron`; each task try/caught; `0 4 * * *` prune, `15 * * * *` fact-table refresh (§8) |

**Jobs (D7) — one queue, typed envelopes, poison never loops.** The contract is
`@rocketflare/shared/jobs`: a discriminated union on `type` (`email.send`, `activity.record`,
`document.index`) wrapped in an envelope `{ id, type, payload, enqueuedAt, attempt? }`. **The
variants are DATA** — `CORE_JOB_VARIANTS` is one list, both unions, `JobType` and `JOB_TYPES` are
derived from it, and a plugin's `SharedPlugin.jobs` are appended (§16), so the set the consumer must
cover is one the kit cannot enumerate. That is why the consumer's dispatch is
`handlers[job.type](job as never, ctx)` over a mapped table (`coreHandlers` merged with each
plugin's `jobHandlers`) and there is **no `runHandler` switch**: the mapped type already proves
completeness, for a set that grows. The `type`
string is the versioning seam — a breaking payload change ships as a new type (`email.send.v2`)
with its own handler while the old one drains; there is no schema-version field. The producer
(`enqueueJob` / `enqueueJobs`, batches of ≤ 100) validates the input and stamps the envelope; a
missing `JOBS_QUEUE` binding throws `JobsQueueNotConfiguredError` rather than silently running
inline. The consumer is a plain function: per message it parses `jobEnvelopeSchema` — **invalid →
log + `ack()`** (retrying cannot make it valid) — then runs the handler, `ack()`s on success and on
error `retry({ delaySeconds })` with 30 s doubling to a 15 min cap; the toml's `max_retries = 3`
ends it (`retry_delay = 60` only applies to a retry with no explicit delay). Each message opens and
closes its own DB client and **everything is awaited — there is no `waitUntil` in a consumer**.
`queue.ts` matches the jobs queue by **prefix** (`isJobsQueue`, `JOBS_QUEUE_NAME_PREFIX =
'rocketflare-jobs'`) because queue names are account-scoped and staging's carries `-staging`; an
unknown queue is `ackAll()`ed so a stray binding can never retry forever.

What is queued today: the invitation email (create, bulk, resend) and the access-request decision
email, so those routes answer as soon as the row exists — the `email.send` payload carries the
optional `link` so the `[email:dev]` console fallback still prints the accept URL. **The magic-link
email stays inline** (a person is waiting on it; latency beats offloading). `example-feature.ping`
is the smoke job (logs and acks) and it belongs to the `example-feature` PLUGIN (D31) rather than to
the kit — `POST /api/example-feature/ping`, or `rocketflare example-feature ping`, proves the
pipeline under `wrangler dev` when that plugin is installed.
Services that queue take the binding as a parameter: `createInvitation(db, cfg, logger, jobs,
input)`, `decideAccessRequest(db, cfg, logger, jobs, input)`.

**Realtime (D8).** The `NotificationsHub` Durable Object (`api/durable-objects/notifications-hub.ts`)
is one instance per tenant (`idFromName(tenantId)`), **stateless** (no `ctx.storage`, so DO
migrations are free), on the hibernation API: sockets are accepted with tags `tenant:<id>` and
`user:<id>`, per-socket metadata `{ userId, sessionId, connectedAt }` lives in the attachment, and
`setWebSocketAutoResponse` answers the client's `{"type":"ping"}` (every 30 s) with `pong` without
waking the object. Publishing is RPC, never fetch dispatch: `broadcast(event)`,
`broadcastToUser(userId, event)`, `broadcastToUsers(userIds, event)` → `{ delivered }`, and
`connectionCount()` → `{ count }`. It lives in this Worker — the source app split it into a second
worker only to keep preview URLs, which the kit does not have.

`GET /ws?tenantId=` (`routes/ws.ts`) is mounted **without** `authMiddleware` (a browser cannot set
headers on an upgrade) and resolves the cookie itself: not an upgrade → 426 `upgrade_required`; no
session → 401; no membership in the requested tenant (or `?tenantId` absent with no session tenant)
→ 403; suspended tenant → 403 `tenant_suspended`; else the upgrade is forwarded to the tenant's stub
with `X-Tenant-Id` / `X-User-Id` / `X-Session-Id` headers. The DO trusts those headers **only**
because it is reachable solely through the `NOTIFICATIONS_HUB` binding. `cors` skips WebSocket
upgrades and `securityHeaders` returns a 101 untouched (its headers are immutable; re-wrapping
drops the socket).

**"DB is the truth, WebSocket is a nudge."** Events are `realtimeEventSchema` in
`@rocketflare/shared/realtime`: `{ type, tenantId, at, payload? }` with `type` ∈ `notification.created |
notification.read | member.changed | invitation.changed | tenant.changed | entity.changed | ping`.
`REALTIME_INVALIDATIONS` in the same file maps each type to the TanStack query-key roots the UI
invalidates (`invitation.changed` → `['invitations']` and `['pending-invitations']`;
`tenant.changed` → `['tenant']`, `['tenants']`, `['auth']`); `entity.changed` carries its own root in
`{ entity, id }`. The UI re-queries; it never applies a payload as state.

`services/realtime.ts` is the **only** module that touches the hub: `nudge(rt, event)`,
`nudgeUser(rt, userId, event)`, `nudgeUsers(rt, userIds, event)` over a `Broadcaster` seam. `rt` is
the `Realtime` (`{ defer, env }`) that `withAuth()` / `withAuthAndDb()` return as `realtime`; every
send goes through `defer` → `waitUntil`, is never awaited on the response path and is a no-op
without the binding. Nudges fire from `createInvitation`, `revokeInvitation`, `acceptInvitation`
(two, deliberately: `invitation.changed` + `member.changed`, after the transaction commits),
`changeMemberRole`, `removeMember`, `updateTenant`, `deleteTenant`, and `notify` / `notifyMany`
(`notification.created` to the recipient's sockets). Services take `realtime?` as a trailing
optional parameter or inside their `input` — it is never imported.

**Client.** `ui/lib/websocketClient.ts` is a singleton outside React: same-origin `/ws?tenantId=`,
reconnect with exponential backoff, base `min(1 s · 2^attempt, 30 s)`, jittered uniformly in
`[base/2, base]`; a close with code 1001/1012 or a reason containing "upgraded"/"new version" means
the Worker was redeployed and reconnects in 100 ms without counting as a failure. State goes to the
one zustand store (`status | connectedAt | disconnectedAt | attempt | lastEvent`);
`WebSocketProvider` (after `AbilityProvider`) connects once authenticated with a tenant, reconnects
on tenant switch, turns events into `queryClient.invalidateQueries` via `invalidationsFor()` and
toasts `notification.created`. `WebSocketStatus` is the header dot; `ConnectionBanner` appears
after 5 s away from `open`.

**What replaced the Node queue semantics (built in §9).** `exclusive` (one active run per tenant and
agent) is the partial unique index `agent_runs_active_exclusive_idx (tenant_id, agent_key)` over
`ACTIVE_RUN_STATUSES` — `queued`, `running` **and `awaiting_input`**, so a run parked on a question
still holds the slot and a second enqueue returns it (`deduplicated: true`) rather than starting a
rival. **The predicate is rendered from that shared list, not typed out**, because an index whose
SQL and whose TypeScript disagree about what "active" means is a bug nothing can see.
**Concurrency has no Cloudflare primitive** — it is a DB claim row: `UPDATE agent_runs … SET running,
attempt + 1 WHERE status IN ('queued','running') RETURNING`; a retried step re-claims, a settled row
is never rewritten. That claim reads `CLAIMABLE_RUN_STATUSES`, which is deliberately NARROWER than
the index's list: a parked run holds the exclusive slot but must not be claimable, or answering it
and a stray retry would both run it. Three lists, three jobs — widening them together is the
mistake. The Workflow instance id is the run id (`AGENT_RUN_WORKFLOW.create({ id: runId })`
after the row exists) — **until a run parked on a human has to be restarted**, when it becomes
`<runId>-r1`, `-r2`… (issue #17: on the resume path `instance.not_found` is an ANSWER, not an error,
so the column is *the latest* instance rather than "the run id"; it stays `unique()`, so a probe
still maps back 1:1). Never fake either in an in-memory `Map` — isolates are many and short-lived.
Cancellation is cooperative, then forced: the first `POST /cancel` flips `cancelRequestedAt` and the
run polls it between turns; a second one on a row that already carries it terminates the instance
and settles the row, because a run stuck inside a model call cannot poll anything. There is no
orphan sweep cron: an active row is reconciled against `instance.status()` **on read, and only when
the row has been quiet** — a run that wrote a durable event inside `RECONCILE_LIVENESS_MS` (30 s) is
alive by definition, and the binding is not touched (a subrequest per reader, per poll, is what that
guard exists to remove). A parked run is settled by a different net, `expireParkedRun`: every ask
past its deadline and no instance left to wake. Progress is durable in `agent_run_events` — read
live over SSE (§9) and nudged over the DO for everything else.

**Known gaps / not built yet:** `/api/admin` paths do not nudge — `decideAccessRequest` writes the
`access_request_decided` notification without a `Realtime`, so the approved user's bell and the
tenant's member list refresh on the next fetch, not live; `notification.read` is in the event enum
and the invalidation map but nothing emits it yet; the `activity.record` handler ships with no kit
producer (routes still `defer(recordActivity)` inline — enqueue it when an audit write is on a hot
path); the DO's 101 branch cannot run under Node (undici rejects status 101) and is proven by
`wrangler dev`, not the suite; `dead_letter_queue` is commented out in both tomls; run progress now streams over SSE
(§9) but there is no DO fan-out for TOKENS; `@cloudflare/vitest-pool-workers` smoke project
for DO/Workflow is not in v1 (the Workflow class is driven by `createFakeWorkflowStep()` under Node).

## 6. Email and storage

**Status: email Phase 1, storage built (Phase 2).**

**Email** is Resend over plain `fetch` (no SDK), `sendEmail(cfg, logger, { to, subject, html, text,
link })`, with shared `emailShell`/`ctaButton` helpers and templates for the magic link, tenant
invitation, invitation accepted and access-request decision. From-address and branding come from
`EMAIL_FROM`, `APP_NAME`, `APP_URL`. Absent `RESEND_API_KEY` → the message is logged (`[email:dev]`,
with `link` printed loudly) and counted as delivered-false, never as an error, so login and invites
work with zero configuration. The magic link is sent inline from its route; invitation and
access-request emails are `email.send` jobs on `JOBS_QUEUE` (§5) — a provider failure there retries
with backoff instead of failing the request.

**Storage (D23)** is the `StorageService` seam (`put`, `get`, `head`, `delete`, `list`) over the
native `FILES` R2 binding (`createR2Storage(bucket)` in `services/storage.ts`), plus
`buildStorageKey` / `sanitizeFilename` / `tenantStoragePrefix`. Keys are
`tenants/<tenantId>/<scope>/<uuid>-<sanitisedName>`, so one prefix scopes a tenant (or one scope of
it) for listing or bulk deletion and the UUID makes every key unique whatever the client called the
file. Bytes **stream through the Worker** — the binding cannot mint presigned URLs. The `files`
table (`db/schema/files.ts`, migration `0001`, RLS policy like every tenant table) is the index and
the only thing the browser can name: rows are immutable (`id, tenantId, ownerUserId, scope, key,
filename, contentType, sizeBytes, createdAt`; no `updated_at`). Scopes are `FILE_SCOPES =
['avatars', 'uploads']`, declared in `@rocketflare/shared/files` and mirrored in the DB enum.

`/api/files` (`routes/files.ts`, behind `authMiddleware`, contract in `@rocketflare/shared/files`):

- `POST /api/files?scope=` — multipart with one `file` field; `create File`. The route mounts its
  own transport cap (`MAX_UPLOAD_BYTES + 64 KB` for multipart overhead) and the JSON `bodyLimit`
  skips `/api/files`; the handler then enforces the exact per-file limit: empty → 400 `file_empty`,
  > 5 MB → 413 `payload_too_large`, `avatars` with a type outside `AVATAR_MIME_TYPES` (png, jpeg,
  gif, webp) → 415 `unsupported_media_type`. Object first, row second; if the insert fails the
  object is deleted (no orphans). `scope=avatars` also sets `users.avatarUrl = /api/files/<id>`.
  201 with the `fileSchema` row; `file.uploaded` activity in `defer`.
- `GET /api/files/:id` — `read File`, tenant-scoped lookup (another tenant's file is a 404),
  `Cache-Control: private, max-age=3600`, `ETag` from R2 and `If-None-Match` → 304. Only
  `INLINE_MIME_TYPES` (the avatar image allowlist **plus `application/pdf`**) renders `inline`;
  **everything else — SVG included — is `Content-Disposition: attachment`** so stored HTML/SVG never
  executes on this origin. A PDF is safe inline because the browser hands it to its own viewer,
  which does not run the file's script in this document's context.

**One framable response class, and it is opt-in per response.** `securityHeaders` stamps
`X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` on everything, and `DENY` forbids framing by
ANY origin including our own — so the document viewer's `<object data="/api/files/:id">` would render
empty however the disposition was set. A route that has PROVED the content type
(`isEmbeddableMimeType`, `EMBEDDABLE_MIME_TYPES = ['application/pdf']`) sets `c.set('embeddable',
true)` and that ONE response gets `SAMEORIGIN` + `frame-ancestors 'self'` instead; both policies are
built from one `CSP_BASE` so they cannot drift, and `nosniff` is on both. The flag is set BEFORE the
`If-None-Match` early return, or a revalidation from inside the `<object>` answers 304 with `DENY`
and the embed works once then goes blank. Deliberately **not** a path allowlist (`/api/files/` would
relax framing for the `text/html` we download on purpose) and **not** a global policy change. The two
media-type lists are separate on purpose: inline and framable are different properties, and an app
adding an inline type must not silently widen the framing hole. Exposure: a same-origin page could
frame a PDF byte stream with no script context — materially smaller than framing the app shell,
which stays forbidden.
- `DELETE /api/files/:id` — the uploader may always delete their own file; anyone else needs
  `delete File` (admin+). Deleting the file behind your own `avatarUrl` nulls it. 204. A
  `documents`-scope file (the original behind a knowledge document, §9) is 409 `owned_by_document` —
  delete the document instead; it takes the object and the row with it.

Missing `FILES` binding → 503 `storage_not_configured` (loud, unlike the hub's silent no-op).
`wrangler dev` emulates R2 locally, so there is no filesystem adapter; tests use `MemoryR2Bucket`.
UI: `api.upload(url, FormData)` (no JSON content-type — the browser sets the boundary),
`useUploadAvatar()` (client-side type/size check first, then `POST /api/files?scope=avatars`,
then refreshes `me` and the session), and the Profile avatar block.

**Known gaps / not built yet:** `users.avatarUrl` is global but the object is tenant-scoped, so
the picture 404s in another organisation and the `<img onError>` fallback shows initials; a
re-upload leaves the previous object and row in place (rows are immutable — a cleanup job is the
app's call); no listing endpoint (`StorageService.list` exists, no route uses it); no per-tenant
quota or storage configuration; presigned URLs would need S3 credentials + `aws4fetch`; email
templates are neutral and need branding.

## 7. UI shell

**Status: shell Phase 0; pages Phase 1.**

**Design tokens, not raw colours.** `apps/web/src/ui/index.css` holds two DaisyUI themes (`rocketflare-light`,
`rocketflare-dark`) whose brand hexes live in one header block, plus semantic surface/border/text tokens,
shape/motion tokens, a base layer (focus ring, reduced motion, tabular numerals) and component
primitives (`.surface-panel`, `.data-table`, `.status-badge`). `apps/web/tests/ui/contrast.test.ts` gates the
emitted tokens; the palette *pipeline* is documented, not shipped (D20). Tailwind v4 scanning is
opted out globally (`@import "tailwindcss" source(none)`) and re-enabled with explicit `@source`
lines scoped to `apps/web/src/ui` — auto-detection scanned the whole repo (docs, API code) and
DaisyUI emitted components for stray words; the safelist exists only for classes built from props.
A dependency that ships JSX (drizzle-cube's `dist/client`, §8) gets its own explicit `@source`
line, never safelist entries.

**Providers, in order** (06 §b): `ErrorBoundary` → `QueryClientProvider` → `AuthProvider`
(`GET /auth/session`, zod-parsed, tenant selection) → `AbilityProvider` (CASL from
`session.permissions`) → `WebSocketProvider` → `BrowserRouter` → routes with `Layout` mounted once
under `/*`. Neither source app had an `ErrorBoundary` or global 401 handling; the kit adds both —
`QueryCache.onError` clears the client and redirects to `/login?returnUrl=`.

**Guards.** One `RequireGuard` primitive composed into coarse role guards and fine ability guards
(`RequireAbility`, `<Can>`); `SideNav` flags use the same guard as the page. `EnvironmentBadge`
and the version footer read `APP_ENV`/`RELEASE_VERSION` so staging never looks like production.
`/login?as=<email>` (what `pnpm bootstrap` opens) signs in through the dev-only `POST /auth/dev-login`
once on mount — honoured ONLY when `GET /auth/methods` reports `devLogin` (the route 404s outside
`APP_ENV=development`) AND the email is one of the allow-listed seeded `DEV_ACCOUNTS`; an arbitrary
address in the URL does nothing.

**Data layer.** `api-client.ts` (`credentials: 'include'`, `ApiError` from the envelope, `schema`
option) → one hook file per resource → `queryKeys` factory → `queryOptions` for shared queries.
zustand holds only websocket state.

**Known gaps / not built yet:** route preloading only if derived from one route table; no "system"
theme option or cross-tab sync; dev quick-login account list should come from a dev-only endpoint.

## 8. Analytics

**Status: built (Phase 4) — server and UI; UI specifics in `apps/web/src/ui/CLAUDE.md`.** Server:
`apps/web/src/api/cubes/*` (+ `CLAUDE.md`), `routes/{cube-api,analytics-pages}.ts`,
`services/dashboard-templates.ts`, `services/fact-tables/**` (+ `CLAUDE.md`), `src/dashboards/**`
(`CLAUDE.md`, `DASHBOARD_PATTERNS.md`), `db/schema/{analytics-pages.ts,facts/*}`, migration `0004`.
Contracts: `@rocketflare/shared/analytics`.

**drizzle-cube is the semantic layer; tenant scoping is inside every cube's `sql()` (D19).**
`routes/cube-api.ts` is ONE router mounted at both `/cubejs-api` and `/mcp` behind
`authMiddleware`. Per request it does `withAuthAndDb(c)` → `guardPermission(c, 'read',
'Analytics')` → `extractSecurityContext(c)` (`cubes/security.ts`: `{ tenantId, userId, role }`
from `c.get('auth')`, throws without a tenant) → `createCubeApp({ cubes: allCubes, drizzle: db,
schema, engineType: 'postgres', mcp: { enabled: true } })` from `drizzle-cube/adapters/hono`, then
forwards `c.req.raw` — the adapter registers absolute paths `/cubejs-api/v1/{load,meta,sql,batch,
dry-run}` and `/mcp`. The compiler is rebuilt per request because the Hyperdrive-backed `db` exists
only inside one. Both prefixes are in the SPA catch-all's JSON-404 guard, so an unauthenticated hit
is a 401 envelope, never `index.html` (`tests/api/health.test.ts`). MCP uses drizzle-cube's default
origin policy (loopback and clients that send no `Origin`, e.g. a desktop connector); a browser MCP
client needs `mcp.allowedOrigins`, which the kit does not set. `apps/web/.drizzle-cube.json.example`
→ a git-ignored `.drizzle-cube.json` holding a tenant API key for the drizzle-cube CLI / Claude Code
plugin — the Bearer key scopes it to one tenant like any other request.

**Every cube filters on `tenantIdOf(ctx)`** — directly (`TenantUsers`, `ActivityEvents`,
`TenantActivityDaily`: `where: eq(table.tenantId, tenantIdOf(ctx))`) or, for a global table,
through a membership subquery (`Users`: `inArray(users.id, select user_id from tenant_users where
tenant_id = $1)` — the pattern for any table without `tenant_id`). `tenantIdOf` throws on an empty
tenant rather than compiling `tenant_id = NULL`. **This is convention, not enforcement** — drizzle-
cube joins whatever a query asks for and there is no second line of defence in the cube layer — so
`apps/web/tests/api/cubes/cube-isolation.test.ts` is mandatory: two seeded tenants, every cube in
`allCubes` through the real `POST /cubejs-api/v1/load` as each tenant, only that tenant's rows back
(and none of the other's ids anywhere in the payload), a join case (`ActivityEvents → Users`),
`/meta` lists every cube, 401 and 403 `no_tenant` envelopes, `/mcp` answers a JSON-RPC
`initialize`, and every template portlet query executes with rows. A new cube must add a case —
the coverage assertion compares `allCubes` to the case keys. No cube reads `role`; access is
membership + `read Analytics`, filtering is by tenant.

**Ship set** (`cubes/index.ts`, sorted by title). `ActivityEvents` — event stream over
`activity_events` with `meta.eventStream { bindingKey, timeDimension, eventDimension }` (funnel /
flow / retention modes); measures `count`, `activeUsers`. `TenantActivityDaily` — over the fact
table; `eventCount` (sum), `activeUsers`, `activeDays`; dimensions `day`, `userId`,
`factRefreshedAt`. `TenantUsers` — `count` plus filtered `ownerCount` / `adminCount` /
`memberCount` over a synthetic `tenant:user` key (the junction has no `id`); `role`, `joinedAt`.
`Users` — `count`; `name`, `email`, `createdAt`, `lastLoginAt`. Joins are declared on the
`belongsTo` side only (the three tenant cubes → `Users`); `Users` declares none, because drizzle-cube
0.8.3 resolves join paths in both directions and a declared `hasMany` makes every ungrouped
(`recordsTable`) query that mixes the two cubes a 400.

**Fact tables.** `tenant_activity_daily_facts` (`db/schema/facts/`, migration `0004`): grain
`(tenant_id, day, user_id)` declared `UNIQUE NULLS NOT DISTINCT` (Postgres 15+ — NULL actors collapse
to one row), `event_count`, `distinct_event_types`, `first_event_at` / `last_event_at`,
`fact_refreshed_at` watermark; no surrogate `id`, no FK to `users` (a refresh must never fail
because a person left), RLS policy like every tenant table. It is a plain table, not a materialised
view: `REFRESH MATERIALIZED VIEW` cannot run through Hyperdrive and cannot be scoped to one tenant.
`services/fact-tables/registry.ts` `FACT_TABLES` is the one list — `{ name, table,
refreshIntervalMinutes: 60, source: { table, timestampColumn }, selectForTenant(tenantId) }` — that
`refresh.ts`, `freshness.ts`, the cron and both scripts iterate. `refreshFactTableForTenant` runs
one transaction per tenant: `DELETE … WHERE tenant_id = $1`, then `INSERT INTO t (<columns from
getTableColumns>) <selectForTenant>` — the target list comes from the drizzle mirror, so a column
drift between `queries/<name>.ts` and the schema fails loudly instead of shifting values. Tenants
run sequentially; errors are isolated per tenant (`errors[]`; the cron logs a warning). Cron
`"15 * * * *"` → `refreshFactTables` (`scheduled.ts`, both tomls). Freshness: `lagSeconds` = newest
`source.timestampColumn` minus newest `fact_refreshed_at` (0 when the build is newer; a never-built
table with source rows is measured to now); `stale` = lag > 2× the interval (one missed cron is
fine, two is not). `GET /api/analytics/facts/status` (admin+, `isAdminLevel`) and `pnpm web
db:check-facts` (exit 1 when any table is stale) read it; `pnpm web db:refresh-facts [table]
[--tenant=<uuid>]` runs the same service the cron does. `wrangler dev` never fires crons — trigger
`:15` by hand (`.claude/rules/cloudflare.md`).

**Dashboards.** Templates are TypeScript `DashboardConfig`s (type from `drizzle-cube/client`) in
`src/dashboards/`: `layoutMode: 'rows'` with explicit `rows` (widths sum to 12), `groups` for KPI
strips, one `isUniversalTime` filter, portlets whose `query` is a cube query as a JSON string;
registered in `DASHBOARD_TEMPLATES` (`index.ts`; categories are folders such as
`general-templates/`; `key` doubles as the page slug; `order` unique; at most one `isDefault`).
One ships: `tenant-overview` ("Organisation Overview", default) — it exercises every ship-set cube.
`analytics_pages` (`slug` unique per tenant, `config` jsonb, `templateKey` — null = user page,
`isDefault`, `sortOrder`, `createdByUserId`) are copied from templates by `ensureDefaultDashboards`
in two places: `onTenantCreated` (`utils/db/tenant-helpers.ts`) after the create transaction
commits — best-effort, a failure is swallowed — AND lazily on every `GET /api/analytics/pages`,
idempotent through `(tenant_id, slug)` `onConflictDoNothing`. The lazy path is the guarantee and
is how a template added later reaches existing tenants. Routes (`/api/analytics`, contracts in
`@rocketflare/shared/analytics`): every member — `GET /pages` (`{ items }`, ordered by `sortOrder`),
`GET /pages/:id`, `GET /templates`; `manage Dashboard` (admin+) — `POST /pages` (an empty rows
dashboard unless `config` is given; unique slug from the name), `PATCH /pages/:id` (name,
description, config, order, isDefault), `DELETE /pages/:id` (a template page → 403
`template_page`), `POST /pages/:id/reset` (a user page → 400 `not_a_template_page`; a template
that no longer exists → 404 `template_not_found`), `POST /templates/recreate` → `{ created, reset }`.
Activity: `dashboard.created | updated | deleted | reset`. `config` is a copy: **a template change
reaches existing tenants only through reset or recreate.**

**Frozen member names.** Stored dashboards reference `Cube.measure` / `Cube.dimension` strings in
JSONB, so renaming a member silently breaks every saved page in every tenant. Add members, never
rename them. `apps/web/tests/dashboards/all-templates.test.ts` (the `config` project, no database)
checks every template structurally — rows sum to 12, ids unique, every portlet placed exactly once
with x/y/w/h matching its row, every referenced member exists in `allCubes`, `recordsTable` is
`ungrouped`, the chart-type rules from `DASHBOARD_PATTERNS.md`, registry keys/orders/one default —
and reset/recreate is the user-facing repair.

**Group visibility (D29).** `analytics_pages` carries `visibility` and `analytics_page_groups`;
`GET /pages` and `GET /pages/:id` AND `visibleAnalyticsPages(scope)` onto the tenant predicate, and
a page the reader may not see is the same 404 as one that does not exist. `ensureDefaultDashboards`
is unchanged and template pages are always `tenant` — they are seeded for every tenant, and reset
and recreate must never change who can see one. The security context gains `groupIds`, `groups`
(names by type name) and `groupIdsByType`, plus **`groupFilter(ctx, typeName, column)`**: a helper
for an app whose own fact table carries a group dimension. No kit cube uses it, because no kit
table has one. Admin → `undefined` (no narrowing); groups of that type → `column in (…ids)`; NO
group of that type → **`false`**, fail-closed. It matches on IDS: matching on names means renaming
a group silently moves rows.

**Permissions.** `Dashboard` (pages): admin+ `manage`, member `read`. `Analytics` (the cube API):
`read` for every role (§1 matrix). The cube API is read-only by nature.

**UI.** In progress; specifics in `apps/web/src/ui/CLAUDE.md`. It renders `analytics_pages` with
drizzle-cube's React components (`drizzle-cube/client`; the dependencies added for it are
`recharts`, `d3`, `react-grid-layout`, `react-is`) in its own lazy chunk. Nothing in this section
depends on it — the contract is the routes above.

**Dependencies and bundle.** `drizzle-cube@0.8.3`, pinned exactly (one transitive peer warning,
`@duckdb/node-api`, is expected). It is **by far the largest thing in the Worker bundle**, and it is
one import: `drizzle-cube/adapters/hono` statically imports `dist/adapters/mcp-transport-*.js` (the
MCP SDK plus inlined chart rendering) even when `mcp.enabled` is false — not the kit's own imports
(the sourcemap has no `node_modules/react` or `recharts` entries reached from our code). It stays
under the Workers size cap (3 MiB gzip on the free plan, higher on Paid, which the kit needs
anyway). No byte count is quoted anywhere in these docs on purpose: it moves with every dependency
bump, so `gzip -c apps/web/dist/api/worker.js | wc -c` after `pnpm build` is the only figure worth
trusting. The fix is upstream — a lazy `import()` of the MCP path in the adapter — or a thin adapter
of our own over `drizzle-cube/server`.

**Known gaps / not built yet:** UI — no router-level unsaved-changes blocker (`beforeunload` + flush on leaving edit mode), heat-map charts stubbed (`@nivo/heatmap` aliased to a notice; install it and drop the alias), drizzle-cube runs its own TanStack Query context so `CubeClientProvider` gives it a dedicated `QueryClient` whose 401 handler calls `notifyUnauthorized`, and mirrors `data-theme="rocketflare-dark"` into a `dark` class while mounted; isolation is convention
enforced by one test — no per-cube CASL gate, no second line of defence in the cube layer; the
compiler is rebuilt per request (4 cubes — cheap; `SemanticLayerCompiler` + cube sets is the
scaling path) and drizzle-cube's `MemoryCacheProvider` is per-isolate (a KV provider would be an
extension); fact refresh is a sequential full rebuild — fan tenants out through `JOBS_QUEUE` past a
few hundred — and two rebuilds of the SAME tenant must not overlap (the later DELETE misses the
earlier INSERT and trips the grain unique index, so that tenant is reported in `errors[]` and keeps
the older rows): don't run `db:refresh-facts` while the cron is due; no realtime nudge for facts or pages (a dashboard refreshes on the next fetch);
`mcp.allowedOrigins` unset; the bundle growth above; the `ANALYTICS_ENGINE` binding is deliberately
not wired; drizzle-cube's `rlsSetup` unused; reporting/export, AI dashboard generation, benchmarks
deferred.

## 9. AI layer

**Status: built (Phase 3; human-in-the-loop and live run progress, issues #17 and #7, built on top).**
Server: `apps/web/src/api/services/{ai/*,agents/**,prompts.ts}`,
`api/workflows/agent-run.ts`, `api/observability/*`, `api/middleware/tracing.ts`, seven routers under
`/api/ai/*`, `/api/chat`, `/api/agui`, `/api/agents`. Contracts: `packages/shared/src/ai/*`. UI:
`pages/chat`, `pages/agents/**`, `pages/settings/{AI,Prompts,Usage}`, `components/ai/`,
`lib/{sse,aguiStream,runAguiStream}.ts` — specifics in `apps/web/src/ui/CLAUDE.md`.

**Three tiers, one resolver (D17).** `resolveChat(db, cfg, env, tenantId, { promptKey? })` and
`resolveEmbeddings(...)` in `services/ai/resolve.ts` are the ONLY readers of `ai_configs` /
`agent_models` and the only place a credential is decrypted. Chat order: an `agent_models(tenantId,
promptKey)` assignment (a chat config id and/or a model override → `source: 'agent'`) → the tenant's
default `ai_configs(scope='chat')` row (`'tenant'`) → platform `ANTHROPIC_API_KEY` with
`DEFAULT_MODELS.anthropic` (`'platform'`) → **`workers_ai` with `WORKERS_AI_CHAT_MODEL`
(`@cf/zai-org/glm-4.7-flash`, zero key) when the `AI` binding exists**
(`'platform'`) → 503 `ai_not_configured` (`AiNotConfiguredError`). The two platform tiers are ONE
function, `platformChat(cfg, env)`, read by `resolveChat`, `readiness()` and the agent-models list,
so they cannot disagree. Because both tomls declare `[ai]`, chat is ready on a fresh workspace with
nothing configured — and every such call is billed to the Cloudflare account that owns the Worker
(10 000 free neurons a day, then metered); an operator who wants zero-spend comments the `[ai]`
block out of BOTH tomls, and one who prefers Claude sets `ANTHROPIC_API_KEY`, which ranks above it.
Embeddings order: tenant default `ai_configs(scope='embeddings')` → `workers_ai` (`@cf/baai/bge-m3`,
1024-dim, zero key) when the `AI` binding exists → `EMBEDDINGS_API_KEY` as `openai`
`text-embedding-3-small` → 503. `readiness()` mirrors both orders without building a client
(`GET /api/ai/config/readiness`; Settings → AI renders it). `ai_configs`: one row per (tenant, scope,
label) — **the label is the upsert key**; a partial unique index makes "two defaults" per (tenant,
scope) unrepresentable (the route clears the old default before setting the new one in one
transaction; the first row in a scope is always default); `apiKeyEnc` is AES-GCM under
`OAUTH_ENCRYPTION_KEY` and the API returns `hasCredential` only. `POST /api/ai/config/test` probes a
saved row or an unsaved candidate with the same client builders the runtime uses (10-token
completion / one embedding, 20 s timeout, 10 per minute per IP). Vars: `AGENT_MAX_OUTPUT_TOKENS`
(16384 — the per-call `max_tokens`) and `AGENT_MAX_TURNS` (30 — the tool-loop cap) in both tomls;
`LANGFUSE_BASE_URL` (Langfuse cloud) and `LANGFUSE_TRACING_ENVIRONMENT` (= `APP_ENV`) default in
`config.ts` and are not declared in the tomls.

**Providers v1** (`AI_PROVIDERS` in `@rocketflare/shared/ai/config`, append-only; `services/ai/providers.ts`
is the data catalog and its `scopes` is the "an adapter exists" gate): `anthropic` (chat,
`@anthropic-ai/sdk`), `anthropic_compatible` (chat; Anthropic wire format behind `Authorization:
Bearer` = the SDK's `authToken`, base URL required; Fireworks and Moonshot are `PROVIDER_PRESETS`
data, not enum values), `openai` and `openai_compatible` (chat **and** embeddings; a small fetch
client for `/chat/completions` SSE and `/embeddings`, base URLs include `/v1`), `workers_ai`
(chat **and** embeddings over `env.AI.run`, zero key: `{ messages, tools, max_tokens, stream }` in the
OpenAI shape, `{ response, tool_calls, usage }` or an SSE `ReadableStream` back; the catalog suggests
only chat models whose Cloudflare catalog entry lists function calling, and prices every one it
suggests so the Usage page does not report `unpricedCalls`; the list is hand-kept, and
`wrangler ai models list` / `… schema <model>` is the live source to check it against).

**The floor is `glm-4.7-flash`**, because the floor has to run the AGENTS, not just the chat box.
Chosen on measurements rather than reputation: it accepts `tool_choice` (so a forced tool is a real
constraint rather than an instruction the model may ignore), its event stream carries tool calls AND
keeps producing text, its context window is 131k rather than 24k, and it is CHEAPER than the 70B it
replaced ($0.06 / $0.40 against $0.293 / $2.253 per million input / output tokens). The 70B stalled:
asked a knowledge question with tools on and streaming, it looped the same search until the turn cap
and emitted no text at all.

**Workers AI answers in TWO shapes and the model decides which.** Older models return
`{ response, tool_calls }`; newer ones — the same ones that accept `tool_choice` — return the OpenAI
chat-completions envelope, `{ choices: [{ message | delta, finish_reason }] }`. `readWorkersAiPart`
reads either, for both a finished answer and a stream chunk. Reading only the first shape is why a
newer model looks like it answered with nothing at all. `env.AI.run` takes no `AbortSignal`, so the adapter races it against
`WORKERS_AI_TIMEOUT_MS` (120 s) and turns an unanswered call into a retryable `unavailable` error —
without that a stalled call holds a Workflow step until its 10-minute timeout and the run reads as
stuck. **Model schemas differ per model**: some accept the OpenAI tool extras in a transcript,
others declare `messages[].content` as a plain string and reject the request outright
(`5006 … oneOf at '/' not met`), which would kill a run mid-loop. The adapter therefore never sends
null content, and on a schema rejection retries ONCE with `flattenWorkersAiMessages` — the lowest
common shape, `{ role: system|user|assistant, content: <string> }`, with the tool call and its
result carried as text.
**`tool_choice` on Workers AI is per-model, and the picker only offers the models that have it.**
`WORKERS_AI_TOOL_CHOICE_MODELS` (`services/ai/providers.ts`) is every text-generation model whose
catalog entry declares `function_calling` AND whose input schema declares `tool_choice` — eleven of
them, checked with `wrangler ai models schema`. It is ONE list doing two jobs: the settings form's
Workers AI model list and the runtime's "can a forced tool really be forced here" predicate
(`workersAiSupportsToolChoice`), so a model somebody can choose is always a model the agent runtime
can constrain. `@cf/openai/gpt-oss-120b`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` and
`@cf/mistralai/mistral-small-3.1-24b-instruct` were dropped from the picker for failing the second
half; a stored config naming one keeps working, stays editable and stays priced, because the picker
is an affordance, not a validation rule.
For a model ON the list a forced tool is sent as `tool_choice` in the OpenAI shape the schema
declares, and that is the end of it. For anything off it — an older stored config — the fallback
stands: `forcedToolInstruction` turns `{ type: 'tool' | 'any' }` into a
system instruction the model is told to honour, and when the model still answers with the arguments
as a JSON object in prose (Mistral Small does, for short inputs — a fenced ```` ```json ```` block),
`recoverForcedToolCall` treats that object as the forced tool's call, so `callStructuredTool` sees a
real `tool_use` (both paths verified live with `summarize-text`). It also strips the CALL ENVELOPE
a model wraps its arguments in — `{"type":"function","name":…,"parameters":{…}}` (observed from
Llama 3.3 70B), `arguments` as a JSON string, or the whole thing nested under `function` — but only
when the object names the tool or declares itself a function call, so a tool whose own schema has a
`parameters` field is never unwrapped. **Streaming with tools is per-model and nothing documents it** — every Workers AI schema declares
its SSE branch as opaque `format: binary`, so the only way to know is to run it. Every model on the
one list was: driven through a real two-turn tool loop, each streams the tool call and then streams
its answer as text, so `workersAiStreamsTools` is that same list. A model off it — an older one a
stored config names — gets one non-streamed call replayed as deltas, and the chat surface says so
once with `CUSTOM kit.notice { workers_ai_no_token_streaming }`.
**Streamed tool calls arrive in FRAGMENTS.** Ten of the eleven follow the OpenAI streaming contract:
the first frame names the tool with empty arguments and later frames carry only argument fragments
keyed by `index`, which is the call's identity rather than its arrival order. `ToolCallAssembler`
concatenates per index; a call delivered whole in one frame (`glm-4.7-flash`) is the one-fragment
case of the same path. Reading a frame as a whole call yields one `tool_use` per fragment, each with
unparseable arguments.
Per-tenant request defaults are injected where the client is built,
never at call sites: `service_tier` verbatim, and extended `thinking` **off by default and sent
explicitly** (`{ type: 'disabled' }`) — a reasoning model otherwise bills for thinking the chat surface
discards; `reconcileThinking` drops it under a forced tool choice and lifts `max_tokens` above the
budget. Every failure becomes `AiError { code: auth | rate_limit | invalid_request | unavailable |
unknown }` (`normalizeAiError`); messages pass `redactSecrets` (a vendor body can echo the rejected
key) and `describeAiError` is the sentence a person sees. No Vercel AI SDK. Bedrock is not shipped
(its Node event stream does not run in Workers); the extension is a non-streaming `aws4fetch` SigV4
adapter behind the same `ChatClient` seam (`docs/ADAPTING.md` §3).

**Kit (`services/ai/kit.ts`)** — how to call the client, written against `ChatClient` so tests drive it
with `FakeChatClient`: `cachedSystem` / `withRollingCacheBreakpoints` (three of Anthropic's four
cache breakpoints: system + the last two turns), `Tool` (zod schema + optional handler; **no handler =
terminal — its input is the answer**), `callStructuredTool` (one forced tool call, zod-validated, one
retry with the issues fed back, then `StructuredOutputError`), `runToolLoop` (the agent engine;
returns the transcript), `runStreamingChat` (the chat engine; read tools only).

**Prompts.** `PROMPT_REGISTRY` in `services/prompts.ts` (`chat`, `summarize-text`, `research-topic`) is code; a tenant
override is a `prompt_overrides(tenant_id, key)` row — revert = delete, `PROMPT_MAX_LENGTH` = 20 000;
`{{var}}` placeholders are filled by `interpolatePrompt` (an unknown one stays visible so a typo
shows). `GET /api/ai/prompts` (member read), `PUT | DELETE /:key` (`manage Prompt`). A new prompt is
one registry entry, no migration; `agent_models` keys on the same registry.

**AG-UI is the wire protocol (D28).** Chat and agent runs both speak
[AG-UI](https://docs.ag-ui.com) rather than a shape only this repo understands, which is what makes
the app drivable by any AG-UI client SDK or front end. What we adopted: the event schemas
(`@ag-ui/core`, **pinned exactly** — its schemas ARE the wire format, so a bump is a protocol bump),
the reference transport (`@ag-ui/encoder` over `@ag-ui/proto`, so content negotiation and the
protobuf frame format are the spec's rather than ours), and the `RunAgentInput` endpoint. What we
deliberately did NOT adopt: `@ag-ui/client` (this app is a conformant AG-UI **server**; acting as a
client of a remote LangGraph/Mastra/CrewAI agent is separate work behind the `ChatClient` seam),
frontend tools, and `STATE_DELTA`.

The contract is `packages/shared/src/ai/agui.ts` — the ONE file allowed to import `@ag-ui/core`,
because a wire format has to be validated by the same runtime schema on the server and in the
browser (the amendment and its reason are in `packages/shared/CLAUDE.md`, and
`tests/config/shared-imports.test.ts` enforces the allow-list). It exports `kitAguiEventSchema`,
a discriminated union over **exactly the 15 events the kit emits** rather than `@ag-ui/core`'s full
set, and `KIT_CUSTOM_EVENTS` — the `kit.` CUSTOM namespace where every kit-specific semantic lives
(`kit.chat.ids`, `kit.usage`, `kit.agent.step`, `kit.agent.retry`, `kit.notice`, `kit.document`). A third-party
client ignores those for free; **an app adds its own under its own prefix, never `kit.`**.

Two consequences worth stating plainly. **Frames carry no `event:` line** — spec AG-UI SSE is
`data: <json>\n\n` and the type is inside the JSON — so nothing may key on the SSE event field, and
the route uses hono's generic `stream()` rather than `streamSSE`. And `EventEncoder.encodeBinary()`
covers both transports in one write path: `Accept: application/vnd.ag-ui.event+proto` gets
length-prefixed protobuf, anything else (including a garbage `Accept`) gets SSE.
`@ag-ui/proto@0.0.59` has no message for `TOOL_CALL_RESULT` and answers an EMPTY frame for one, so
`createAguiEncoder` drops an event the negotiated transport cannot carry rather than writing bytes
no client can decode; `tests/config/agui-contract.test.ts` round-trips every emitted event and
fails the day upstream gains the message.

**Chat.** `conversations` / `messages`; ownership is the `userId` filter on every query, so another
member's thread — an admin's too — is a 404. `POST /api/chat/conversations` resolves the client first
(the 503 arrives before any row exists) and records `provider`/`model` on the row. **Those are
refreshed every turn, not frozen**: the turn re-resolves its client, so a value fixed at creation
stops being true the moment a tenant changes provider — and `messages.provider`/`model` record what
answered each individual turn, which is the only way a thread whose model changed mid-way can be
priced or explained (both nullable: a turn written before those columns reads as unknown, never as
today's model).

**The chat inspector** is `GET /api/chat/conversations/:id/stats` (admin+ `manage AiConfig` ON TOP of
the ownership filter, so it widens what an owner sees about their own thread and never whose threads
are visible) plus a collapsible right-hand panel on `/chat`. Everything in it is DERIVED per request
— from the stored rows, the live config and the price table — so there is no second source of truth
to drift from the transcript, and a thread that predates a column reports less rather than wrong. It
answers what will answer next (`readiness()`, so no model call), the window the next turn will send
against `CHAT_HISTORY_MAX_CHARS`, what fell out of it, turns, tool calls, tokens, cache reads/writes,
and an estimated cost per model where `unpricedTurns` says how much of the thread the figure leaves
out. `context.composition` splits the next prompt into five disjoint parts summing to `totalChars` —
system prompt, tool schemas, summary, user messages, replies — because the system prompt and the
three tool schemas are sent on EVERY turn regardless of what was asked, and on a short thread they
are most of it. Compaction has **two distances and they happen in order**: the window has to fill before
anything is dropped (`context.headroomChars`), and enough has to be dropped before a summary is
worth a model call (`compaction.pendingChars` against `CHAT_COMPACTION_MIN_CHARS`). The summary
itself is shown, and `POST /:id/compact` enqueues one now with `force: true` on the `chat.compact`
payload — a 409 `nothing_to_compact` rather than a 202 for a job that is guaranteed to no-op.
`POST /conversations/:id/messages` is a wrapper around `services/ai/chat-turn.ts`, which is the ONE
implementation of the sequence below — `POST /api/agui/run` calls the same function.
`prepareChatTurn` does everything that can fail as JSON **before** the stream opens (resolve,
prompt, the last 40 turns, the user-message insert); `streamChatTurn` streams:

```
RUN_STARTED → CUSTOM kit.chat.ids { conversationId, userMessageId, assistantMessageId, provider, model }
            → STATE_SNAPSHOT { conversationId, provider, model, tools[] }
            → per model turn: TEXT_MESSAGE_START → CONTENT* → END
                              TOOL_CALL_START → ARGS → END → TOOL_CALL_RESULT
            -- persist the row, bump lastMessageAt, auto-title, recordUsage --
            → CUSTOM kit.usage → RUN_FINISHED { result: chatRunResult }
```

`kit.chat.ids` carries the ids because `RUN_STARTED` has nowhere to put them and
`RUN_FINISHED.result` is far too late: the UI swaps its optimistic bubble's id the moment the turn
starts. **Each model turn opens its own text message** with a fresh uuid — reusing one `messageId`
across several `START/END` pairs is what strict AG-UI consumers choke on — while the persisted row
keeps `assistantMessageId`; the UI accumulates deltas across the whole run regardless.

Two terminal conventions. A failure closes any open text/tool message and emits `RUN_ERROR`: no
`RUN_FINISHED` after it, and nothing is persisted. **A cancelled run emits nothing at all** — AG-UI
0.0.59 has no cancellation event, so the contract is *a run whose body closes with neither
`RUN_FINISHED` nor `RUN_ERROR` was cancelled by the client*, checked explicitly so a real write
failure still reports. Failures BEFORE the stream opens stay JSON envelopes (503
`ai_not_configured`, 404, 403), which is why the resolve/prompt/history/insert block sits above it.

Inside the stream, all awaited and on a **second DB client** (`streamDatabase(c)` — the request's
client is closed in `waitUntil` the moment the Response is returned, before the stream body runs):
persist the assistant message, bump `lastMessageAt`, auto-title from the first user turn (60 chars),
`recordUsage(feature: 'chat')`, flush the tracer.

**A long thread forgets deliberately (D17).** What overflows a conversation is the model's CONTEXT
WINDOW, which is characters — not a message count, which is why the budget is
`CHAT_HISTORY_MAX_CHARS` (24 000, a `[vars]` knob, because the right value tracks the model the
tenant chose) with `CHAT_HISTORY_MAX_MESSAGES` (40) kept only as a backstop. A count alone is not a
limit at all: forty messages at the 32 000-char per-message cap is 1.28M characters, more than any
supported model accepts, so such a thread fails on every turn with no way out but starting again.

`selectHistoryWindow` (`services/ai/chat-history.ts`, pure — the route and the compaction job both
call it, so their idea of "the window" cannot drift) keeps the newest messages that fit and reports
the rest as `dropped`. The dropped prefix is **not silently forgotten**: a `chat.compact` job folds
it into `conversations.summary`, and later turns replay that summary as the system prompt's
`volatile` half — which is also where prompt caching wants it, since the cacheable prefix is
`stable` and the summary changes underneath it. `summarisedThroughId` is the watermark AND the
compare-and-set key, so two concurrent compaction runs produce one summary and one no-op rather
than a lost update. `CHAT_COMPACTION_MIN_CHARS` (2 000) stops a model call per turn once the window
is full; `CHAT_SUMMARY_MAX_CHARS` (2 000) stops the summary becoming a slower version of the
problem it solves.

Compaction is a JOB rather than part of the turn because a chat reply is the latency a person
feels. The cost of that choice is bounded and stated in-band: the turn that FIRST crosses the
budget answers without a summary and emits `CUSTOM kit.notice { history_truncated }`; every turn
after it emits `history_summarised`. `messages` is never edited — the summary is derived data and
rebuilding it is always safe.

**Chat calls the knowledge tools.** `search_knowledge`, `get_document` and `list_documents` — the
same three every agent gets — are on by default, so the chat box answers from the workspace's own
material; `CHAT_KNOWLEDGE_TOOLS = "false"` in both tomls is the operator's way back to a tool-free
chat. The tools are built from the STREAM's database client, never the request's: that one is
already closing, so binding them to it fails every tool call after the first frame, intermittently,
only where `waitUntil` really runs. The loop is capped by `CHAT_MAX_TOOL_TURNS` (6), not
`AGENT_MAX_TURNS` (30) — that is a budget for a Workflow step with a ten-minute timeout, while a
chat turn is interactive and shares the Worker's CPU and subrequest budget. `TOOL_CALL_RESULT`
carries the tool's JSON unmodified, which is the AG-UI-native representation a third-party client
renders, and `messages.toolCalls` now fills for real (the column already existed).

**The documents a turn touched come back as `CUSTOM kit.document`, one per document, after the
`TOOL_CALL_RESULT` they were derived from.** Not by parsing `TOOL_CALL_RESULT` in the UI: that
result is `search-knowledge.ts`'s internal JSON, which that file explicitly reserves the right to
retune for context budgets, so a prompt change would silently break a React component. Not AG-UI's
generative-UI path either, which needs client-side tools (`POST /api/agui/run` refuses them) and
makes the card a *render* contract rather than a *data* one. A kit CUSTOM event is kit-owned,
versioned, zod-validated, and ignored for free by a third-party client — and an app adds its own
under its own prefix, never `kit.`. `documentCardsFromToolResult(toolName, result)` in
`@rocketflare/shared/ai/embeddings` is the mapper, and it is **pure**: it reads JSON the tool already
returned and never queries, so it cannot widen tenant scope, and it `safeParse`s, so a retuned tool
degrades to "no cards" rather than a crash. **Four callers, one function** — the chat stream (the
tool's JSON string), the agent-run projection (the summarised object on the event row, so a finished
run reads back with the cards a live chat showed), and the UI rendering a persisted message from
`messages.toolCalls`. That last one is why nothing about a card is stored: a reloaded thread derives
the same strip. A card built this way says `typeLabel: null` and `sizeBytes: null` rather than
guessing — a search hit knows the title and the passage count and nothing else. On `workers_ai`,
which has no documented tool-call event stream, the adapter runs one non-streamed call per turn and
replays it, so the reply arrives in bursts — the server says so once as `CUSTOM kit.notice
{ code: 'workers_ai_no_token_streaming' }` rather than letting it read as a stall.

**`POST /api/agui/run` (the `RunAgentInput` endpoint).** A separate mount beside `/api/chat`, not
under it: `api/index.ts`'s mount list is the enumerable auth surface. No new auth machinery —
`authMiddleware` already takes a session cookie or a tenant API key as Bearer, and `csrf.ts` already
exempts Bearer; a cross-origin browser client needs its origin in the CORS allow-list, which is
configuration, not code. **Conversation ownership is the `userId` filter, so every thread an API key
touches belongs to the user who created that key.**

The reconciliation rule is **"the server is the transcript; the client supplies only the tail"**:
`threadId` must be a UUID and is looked up as `(id, tenantId, userId)`; unknown, it is **adopted**
(a conversation created with that id, after `resolveChat`, so a 503 lands before any row) — which is
what lets a stateless client invent a `threadId`; an id that exists but is someone else's collides
on the primary key and is 404 `agui_thread_not_found`. The LAST message is the new user turn and
**every earlier message is ignored**; history comes from the DB (40 turns). A last message whose
UUID `id` already exists in this conversation is not re-inserted, so a client retry is safe (no
transaction spans a stream body). `MESSAGES_SNAPSHOT` goes out right after `RUN_STARTED` carrying
the server's transcript — the honest answer to divergence: the client is told in-band what the
server believes.

Its failure modes, stated rather than fixed: a client that edits or branches history gets the
server's history (the snapshot makes that visible, not resolved; branching needs a real thread
model); two concurrent runs on one `threadId` interleave (the fix is an `agent_runs`-style claim
row, never a `Map`); the client's `runId` is echoed but neither stored nor deduplicated on; adopting
a thread lets someone create an empty conversation in their OWN tenant, which is harmless. Inbound
`tools[]` is **refused** with 400 `agui_client_tools_unsupported` — a silently ignored tool leaves
the client waiting for a call that can never come. The real reason is that frontend tools need the
loop to suspend mid-turn and resume on a later `RunAgentInput`, and `runStreamingChat` has no
durable suspend point; the agent runtime already has that machinery (`agent_runs.checkpoint`), so
v2 is "reuse the checkpoint column on `conversations`". Inbound `state` is ignored; outbound state
is one read-only `STATE_SNAPSHOT`.

UI: `fetch`, not `EventSource` (`lib/sse.ts` — transport only, it imports no schema, which is what
keeps `@ag-ui/core` out of the eager shell — and `lib/aguiStream.ts`); Stop = abort, no toast; the
streaming text is local state written to the query cache on `RUN_FINISHED`; `react-markdown` +
`remark-gfm` live in `components/ai/` outside the shared barrel so they ship only in the lazy chat
chunk, and `@ag-ui/core` reaches the browser only through that chunk.

**Agents (D7).** `AGENTS` (`services/agents/registry.ts`) maps each `AgentKey` to the shared
`AgentMeta` (`@rocketflare/shared/ai/agents`: key, `inputSchema`/`outputSchema`, `promptKey`,
`exclusive`, `approvers`) plus a server-side `run(ctx)`. `POST /api/agents/runs` is the handoff —
routes enqueue, never run: `enqueueRun` validates against the agent's `inputSchema`, inserts
`agent_runs` `queued`, creates the Workflow instance with the run id, and answers 202 with the row.
**The instance id starts as the run id and does not stay that way**: a run parked on a human whose
instance is gone is restarted as `<runId>-r1`, `-r2`… , so `agent_runs.instance_id` is *the latest*
instance (still `unique()`, so a probe maps back 1:1). The partial unique index
`agent_runs_active_exclusive_idx (tenant_id, agent_key)` over `ACTIVE_RUN_STATUSES` (`queued`,
`running`, `awaiting_input`) IS the exclusive guarantee (every v1 agent is exclusive): a second
request gets the existing run back with `deduplicated: true` (409 `agent_run_active` only with
`?strict=1`), including while it is parked. No binding → 503 `agent_runs_not_configured` before any
write.

`AgentRunWorkflow` (`api/workflows/agent-run.ts`) is `claim` → `execute#N` (`retries: 2`,
exponential from 10 s, `timeout: '10 minutes'`) → `finish`, with a round loop between the last two:
an `execute#N` that returns `awaiting_input` is followed by `resume#N`
(`step.waitForEvent(AGENT_RESUME_EVENT, { timeout: AGENT_INTERRUPT_TIMEOUT })`) and then
`execute#N+1`, or by `expire#N` when nobody ever answers. **Every step name carries its round**,
because the platform treats a step name as that step's identity and replays a repeated one's
recorded result — reuse `execute` and the second attempt returns the first one's answer, which
reads exactly like "the agent ignored my approval". `MAX_INTERRUPT_ROUNDS` (32) bounds an agent
that never stops asking. Step bodies are plain functions (`claimStep`, `executeRun`, `finishStep`
in `services/agents/runtime.ts`), each opening and closing its own DB client. **The claim is the
row**: `UPDATE … SET running, attempt + 1 WHERE status IN (queued, running) RETURNING` —
`CLAIMABLE_RUN_STATUSES`, which is narrower than the index's list on purpose (§5), while every
terminal write uses the wider one, so a settled row is never rewritten and a retried step re-claims.
`executeRun` resolves the client for `meta.promptKey` (the per-agent model applies), wraps it in
`withAgentTrace` + `traceChatClient`, builds the `AgentContext` (`emit`, `checkCancelled`, `chat`,
`tools`, `prompt(vars)`, `step(...)`, plus `checkpoint`, `once`, `interrupt`, `steering`,
`artifact` and `approvals` below), runs the agent, validates `outputSchema`, `finishRun`.

**A retry is resumed, not replayed.** `execute` re-enters `run()` from the top, so two pieces of
`AgentContext` make that cheap and safe. `ctx.checkpoint` is the tool loop's resume point on
`agent_runs.checkpoint` (a `ToolLoopCheckpoint` = transcript + turns + usage): `runToolLoop` writes
one per turn through `onCheckpoint` and continues from it through `resume`, so a retried step pays
for the turns it still owes rather than all of them, `AGENT_MAX_TURNS` is a budget for the RUN
rather than per attempt, and the tokens a RETRIED loop used to lose are carried
forward instead — nothing can be billed twice, because a retry only ever follows an `AiError`
unavailable/rate_limit or a DB outage, both of which strike before an agent ledgers anything. (A
mid-loop *cancel* still loses its tokens: it settles the run, which clears the checkpoint.) Every terminal settle clears the column (the transcript is scratch space, not a record),
and a stored value that no longer parses reads as "no checkpoint", so a shape change costs one
replayed run and never a failed one. `ctx.once(key, fn)` is the durable-effect key: `fn` runs at
most once per `(run, key)` across attempts and later attempts replay the recorded jsonb result,
guaranteed by the unique index on `agent_run_effects (run_id, key)` — a database constraint, not a
memory map. It is what stops `summarize-text` with `index: true` leaving two copies of its summary
in the knowledge base, and what makes `research-topic`'s usage row appear once for the whole run.
The contract is at-least-once WITH a recorded result, not exactly-once: an isolate that dies
between `fn()` returning and the insert committing repeats the work. An agent that derives state
from tool results during the loop (`research-topic`'s document→title map) must rebuild it from the
resumed transcript, or citations earned before the retry are dropped as hallucinations.

**A run can stop and ask a person (issue #17).** This is what lets an agent do something
consequential: send this email, delete these rows, which of these three customers did you mean.
`ctx.interrupt({ key, spec })` writes an `agent_run_interrupts` row and raises `InterruptRequested`;
the runtime parks the run (`awaiting_input`), notifies the approvers and returns, and the Workflow
sits on `step.waitForEvent`. Answering flips the row and **then** nudges the instance — *the answer
is the transition*, which is why a lost instance can simply be restarted rather than reconciled.
`sendEvent` carries `{ interruptId }` only; `executeRun` re-reads the row, because a payload on the
wire would be a second source of truth that can disagree with the audit row.

Four things about it are load-bearing:

- **`key` is the agent's and must be stable across attempts.** A resumed `execute#N+1` re-enters
  `run()` from the TOP and reaches the same line again; `UNIQUE (run_id, key)` is what makes the
  second call find the ANSWER instead of asking again, forever. Derive it from the entity id, the
  step name or the question — never a counter or a clock.
- **Everything after an interrupt is on the far side of a park**, which may last days and span a
  Worker deploy. Side effects go behind `ctx.once`, exactly as they would after any retry — and
  tokens are a side effect, which is why `summarize-text` wraps its whole summarise phase in one.
- **Rejection differs by kind**, and the mapping lives in one place (`INTERRUPT_REJECTION`). An
  `approval` that is declined throws `InterruptDeclinedError` and settles the run `cancelled` with
  `error` NULL — a refusal is a status, not a fault. `choice` / `input` / `form` resolve with
  `{ status: 'cancelled' }` and hand the refusal back to the model, because declining to answer is
  an answer. One ask may override its own default with `onReject`.
- **`approvers` is per agent**, `'requester'` (whoever can see the run) or `'admin'`. Answering is
  `update AgentRun` *plus* that policy, and a compare-and-set on `status = 'pending'` is what makes
  two people answering at once one 200 and one 409 `interrupt_not_pending` rather than a lost
  decision. Neither shipped example sets `approvers: 'admin'` — no kit agent touches money — so it
  is exercised by tests.

**Four kinds, closed: `approval`, `choice`, `input`, `form`** (`@rocketflare/shared/ai/interrupts`),
each with a typed `spec` jsonb the panel draws from and a payload schema **the route and the UI
validate with the same function**, so a 400 is never a surprise. A fifth kind is one tuple entry,
one payload schema and one UI branch — deliberately cheaper than a JSON-Schema form generator,
which would put an unbounded renderer in the browser for a surface with four shapes.

**A tool the MODEL decides to call is gated on the tool, not in the agent.**
`Tool.requiresApproval` — or `requiresApprovalWhen(input)`, to gate only the calls that matter —
makes `runToolLoop` scan the WHOLE turn after the assistant message is pushed and **before any
handler runs**, checkpoint, and raise. So a turn with three calls, one of them gated, parks with
nothing executed, and resuming has only the approved call to make idempotent. The loop must be
passed `approvals: ctx.approvals` and `runApproved: ctx.once`: without the first an answered gate is
asked again, without the second an approved write repeats on a step retry — precisely the side
effect somebody was asked about. An ask may also be raised from INSIDE a handler (`runHandler`
rethrows `InterruptRequested` and only that), which is the natural place for "which of these did you
mean?"; swallowing it into an `isError` result would leave the model asking the same question again
forever. `allowEdits` lets the approver change the arguments, re-validated server-side against the
tool's own schema — a client that can edit tool arguments is a client that can call anything.

**Artifacts are a table; steering is an event row**, and the asymmetry is the design.
`ctx.artifact({ key, title, data })` upserts `agent_run_artifacts` on `(run_id, key)` — an artifact
is MUTABLE (a redraft replaces itself), queried across runs, and outlives the run with an id a card
links to; five kinds, `document | file | markdown | table | json`, where the first two carry **ids,
never content**, because the bytes already live behind routes that enforce tenancy and group
visibility. What goes in the log is a *thin* `artifact` event giving its position in the timeline.
A steering note — what somebody types at a run that is still working — is immutable, positional and
per-run, so it IS an `agent_run_events` row and needs no table; `ctx.steering()` delivers each note
exactly once across every attempt through the existing `agent_run_effects` ledger keyed
`steering:<eventId>`, and an agent folds them in through `runToolLoop`'s `beforeTurn`, which appends
them with `appendUserText` rather than opening a second consecutive user turn (Anthropic rejects
those, and a resumed transcript usually ends in a user turn of tool results).

`GET /api/agents/interrupts` is the tenant-wide inbox — "what is waiting on me" — ordered by
`(tenant_id, status, created_at DESC)` and returning `canAnswer` per item rather than filtering, so
a person sees the question they may not answer instead of a hole. `AGENT_INTERRUPT_TIMEOUT`
(`168 hours`, `[vars]` in both tomls) is the `waitForEvent` timeout **and** the row's `expiresAt`.

Errors are
classified: `AgentCancelledError` → `cancelled`; `AiError` `unavailable`/`rate_limit` or a DB outage
rethrow for a step retry while `attempt <= 2`; anything else → `failed` at once. **Neither interrupt
type is retryable** — `isRetryableRunError` answers false for both, or a step retry re-asks somebody
who has already been asked. Cancellation is cooperative, then forced: `POST /runs/:id/cancel`
settles a queued row outright and sets `cancelRequestedAt` on a running one, which
`ctx.checkCancelled()` polls between turns; a SECOND cancel on a row that already carries it
terminates the instance and settles the row, because a run stuck inside a model call cannot poll.
Cancelling also expires every pending ask. Reads reconcile: `GET /runs/:id` calls `instance.status()`
for an active row and settles it when the runtime says `not_found | errored | terminated |
complete` — **`not_found` is an answer**, not an error — but **only when the row has been quiet**: a
run that wrote a durable event inside `RECONCILE_LIVENESS_MS` (30 s) is alive by definition, and
spending a Workflow subrequest per reader per tick to be told so was the cost that guard removes. A
parked run is left alone by that path and settled by `expireParkedRun` instead, once every ask is
past its deadline — which is the net that matters on the Free plan, where **instance retention
(3 days) bounds a park long before the timeout does**. Progress is `agent_run_events (run_id, seq)`
(`step | tool.start | tool.end | text | status | error | interrupt | interrupt.resolved | steering |
artifact`, every one with a shared schema in `AGENT_RUN_EVENT_DATA`) plus an `entity.changed
{ entity: 'agent-run', id }` nudge, and a second nudge for a run's asks that feeds the nav badge —
DB is the truth, WS is a nudge.

**A run reads back as AG-UI: a projection, not a rewrite.** `agent_run_events` stays exactly as it
is — the durable record, written inside Workflow steps where every write is awaited and ordered by
`seq` — and `services/agents/agui-projection.ts` maps it at READ time for
`GET /api/agents/runs/:id/agui` (plain JSON, same `reconcileRun` and ownership rules as
`GET /runs/:id`). Nothing in the runtime knows AG-UI exists. The projection is pure and the event
row ids ARE the AG-UI message and tool-call ids, so two reads of one run match byte for byte;
`threadId = runId`, because an agent run is not a conversation.

| row | AG-UI |
|---|---|
| *(synthetic, always first)* | `RUN_STARTED { threadId: runId, runId }` then `STATE_SNAPSHOT { capabilities: { humanInTheLoop } }` — a client is told an approve/reject round-trip is possible BEFORE it renders anything |
| `step` running / done·error | `STEP_STARTED` / `STEP_FINISHED` + `CUSTOM kit.agent.step` (the label and detail `stepName` cannot carry) |
| `text` | `TEXT_MESSAGE_START → CONTENT → END` |
| `tool.start` | `TOOL_CALL_START → ARGS → END` |
| `tool.end` | `TOOL_CALL_RESULT`, paired back to its call |
| `error` `willRetry` | `CUSTOM kit.agent.retry` — a retry is not terminal |
| `interrupt` | `CUSTOM kit.agent.interrupt` — the ask as it was MADE, at its place in the timeline |
| `interrupt.resolved` | `CUSTOM kit.agent.interrupt.resolved` — who answered, and what |
| `steering` | `CUSTOM kit.agent.steering` — what a person said to the run mid-flight |
| `artifact` | `CUSTOM kit.agent.artifact` — the thin `{ artifactId, key, kind, title }` row |
| run `succeeded` | `RUN_FINISHED { result: run.output }` |
| run `awaiting_input` with pending asks | `RUN_FINISHED { outcome: { type: 'interrupt', interrupts[] } }` — AG-UI's own vocabulary, no `kit.` event needed |
| run `failed` / `cancelled` | `RUN_ERROR`, code `agent_run_failed` / `agent_run_cancelled` |
| `tool.end` naming knowledge documents | `CUSTOM kit.document` ×0..n, through the SAME pure mapper the chat stream uses |
| run still active | no terminal event |

The projector is **resumable** — `createRunProjector(run) → { head(), push(event), finish(run) }`,
with `projectRunToAgui` a fold over it, pinned by an equivalence test — because the live stream
(below) must not re-read the whole log every tick. `finish` takes the run as an ARGUMENT rather than
from the closure, since in a stream the row changes underneath you. It reads `(run, events,
{ interrupts, artifacts })`: an ask is mutable, so its CURRENT state cannot come from the log.

Two mappings the table could not settle by itself. A settled **cancelled** run is a coded
`RUN_ERROR` rather than the streaming convention ("closed with no terminal event"), because in a
finite array the absent terminal event is how an ACTIVE run reads. And there is **no `kit.usage`**:
`ai_usage` rows carry no run id, so a projection over `(run, events)` has no honest number — the
Usage page is the ledger. The interrupt outcome round-trips **intact over protobuf** on
`@ag-ui/proto@0.0.59` (verified by decoding, not by "encode did not throw" — a malformed event is
silently written as a 43-byte frame with the outcome dropped), so `PROTO_UNSUPPORTED_EVENTS` stays
a type list. One trap worth keeping: the outcome discriminator is **`'interrupt'`, not
`'interrupted'`**. Known fidelity loss: `ToolCallResultEventSchema` in 0.0.59 has no error
flag, so an errored tool result is projected with its JSON intact.

**A run reads back LIVE too: `GET /api/agents/runs/:id/agui/stream` (issue #7).** A run executes in
a Workflow, in a different isolate from any request, so the stream is a **poll of
`agent_run_events` held on one open connection** — `services/agents/run-stream.ts` tails
`WHERE (tenant_id, run_id) AND seq > $cursor LIMIT 200`, pushes each row through the resumable
projector and writes it as spec AG-UI. Measure it against what it replaces rather than against
zero: every 3 s the old poll did `getRun` + `reconcileRun` (*a Workflow subrequest*) +
`listEvents` returning every row unbounded, so this is **cheaper per unit of wall clock at six
times the resolution**. GET, so a third-party client can use a bare `EventSource`; `?afterSeq=`
beats `Last-Event-ID` when both arrive.

Carrying the payload on the WebSocket nudge instead was rejected on **tenant isolation**, not
taste: `NotificationsHub` fans out per tenant while run visibility is per run, so a nudge carrying
the payload would broadcast one member's assistant text, tool inputs and document excerpts to every
socket in the tenant — and "DB is the truth, WebSocket is a nudge" stays load-bearing. A per-run
Durable Object fan-out is the future seam for TOKENS, which are the one payload legitimately not
durable; a push can always be missed, so the `seq` tail would still be needed underneath it.

Four rules hold the stream together, and each is a bug if broken. **The SSE `id:` goes on the last
frame of a row's group and on no other frame in it** — one durable row is not one AG-UI event, and
a cursor on the first frame means a mid-group drop leaves the client holding a text message that
never closes. **A read-stream failure emits no `RUN_ERROR`**, a deliberate inversion of the chat
rule (there the stream IS the run; here it is a read of something durable), so closing with no
terminal event means *reconnect* — redeploy, idle cap, 10-minute duration cap, transport error,
abort. **`reconcileRun` runs once, before the first frame, never in the loop.** And **no `: ping`
comment frame on the protobuf wire**, which has no cursor either. A **parked** run needs no branch:
the projector already answers `awaiting_input` with the interrupt outcome, so the connection closes
and a seven-day park costs no connection, no query and no invocation — degrading exactly to the
architecture that was already there.

**Why not Cloudflare's Agents SDK — checked against the docs, not recollection.** Cloudflare's
canonical agent stack is the Agents SDK (a Durable Object per agent) for the LLM/tool loop, **plus**
Workflows for durable pipelines and HITL pauses. Its own guidance puts *background jobs, scheduled
sync, event-driven processing* in **Workflows alone**, and a Rocketflare run — started by
`POST /api/agents/runs`, executing with no connected client, read back from durable rows — is
exactly that; the HITL row puts the approval pause in the Workflow either way. So the kit is inside
the documented envelope, and `step.waitForEvent` + `sendEvent` is the blessed pattern (the docs name
"wait for human approval" as its use case; timeout 1 second to 365 days; `waiting` instances are
excluded from the concurrency cap, so parking millions is free). What the kit does not have is the
Agents-SDK half: a stateful DO owning the loop and streaming to a live client.

Adopting it was considered and rejected, and the reason is **tenancy, not taste**. Agent state is an
embedded SQLite database inside each instance, with no cross-instance query, no backup, no export
and no delete. That puts it outside every isolation guarantee this kit is built on: no Postgres
role and no policy to attach RLS to (D1); outside the `tenantRef` FK graph, so **deleting a tenant
would leave its agents' transcripts behind** — a retention problem, given the kit nulls a settled
run's transcript precisely so a verbatim copy does not sit there for the life of the row; no
`(tenant_id, status, created_at)` index for "what is waiting on me across every agent in this
organisation", which is a cross-instance query DOs do not do; and no path into the cubes or the
`ai_usage` ledger. Addressing is a smaller problem but the same kind: an agent's instance name is a
client-supplied string, and while `getAgentByName(env.X, \`${tenantId}:${runId}\`)` derived
server-side fixes it, that converts isolation from **structure into convention** —
`tests/config/unscoped-allowlist.test.ts` parses queries, and it cannot see a DO name string. The
decisive point: the fix for the inbox is to shadow the rows into Postgres, which is this design, so
the SDK would mean paying for a second state model **and still writing `agent_run_interrupts`**.

It remains the right tool for a different job — an app that is single-tenant, or that wants the
SDK's client-facing streaming, scheduling and per-agent state, should choose differently on purpose
rather than by default.

Members list and
cancel their own runs; admin+ every run in the tenant. The tool loop runs inside ONE `execute` step, and
**that is now a decision, not a gap** — one `step.do` per model turn was investigated and rejected
(see the Known gaps below for the evidence). Two examples ship, one per shape, and between them they exercise every
primitive above. `summarize-text` (the single-call shape): precheck (≤ 20 000 chars), one terminal
tool `submit_summary` through `callStructuredTool`, usage under `agent:summarize-text`, a `markdown`
artifact, and with `index: true` an `approval` interrupt keyed `approve-index` before the summary is
stored through `ingestText`. It uses `ctx.interrupt` rather than a gated tool **deliberately**: it
has no tool loop, so `requiresApproval` has nothing to attach to, and bolting a loop onto the file
every adopter copies purely to demonstrate a flag would make the simplest agent the most
complicated one. The whole summarise phase sits inside `ctx.once`, so a park is not a second bill.
`research-topic` (the agentic shape, D18) carries the rest: one question (≤ 2 000
chars) → `runToolLoop` over `[...ctx.tools, ask_human, index_finding, submit_answer]` capped by
`AGENT_MAX_TURNS`, the model choosing how often to `search_knowledge` / `get_document`, then the
terminal `submit_answer { answer (Markdown), citations }`. `ask_human` raises a `choice` interrupt
from inside its handler (keyed by the QUESTION, because a handler-raised ask parks before that
turn's checkpoint and the resumed loop may produce a fresh call id); `index_finding` is gated by
`Tool.requiresApproval` with `allowEdits` and `onReject: 'tell_model'`, and is the only shipped code
passing `approvals` / `runApproved`; `beforeTurn` folds in steering notes; the answer and its
sources are recorded as `markdown` and `table` artifacts. Also: `ctx.checkCancelled()` runs in the loop's `onStep` (the loop
takes no `AbortSignal`) and each turn's text / tool call / truncated tool result becomes an
`agent_run_events` row. Two deliberate behaviours: a loop that ends **without** the terminal call
(`no_tool_call` / `max_turns` — the live failure mode on Workers AI, which has no `tool_choice`) is
**salvaged** by ONE `callStructuredTool` over the transcript rather than failed, and **citations are
filtered to the document ids the tools actually returned** (titles come from the search hit), so a
hallucinated citation is dropped instead of persisted. Usage is the summed loop under
`agent:research-topic`.
**Every agent can read the knowledge base**: `ctx.tools` carries three built-in tools
(`services/agents/tools/`), all bound to the run's tenant and all answering JSON that says what to
do next. `search_knowledge` — the same hybrid `searchChunks` as `/search`, returning WHOLE passages
(≤ 4 000 chars each, ≤ 16 000 per answer; anything dropped is reported as `omitted`) grouped by
document and located inside it: `passage` n of `totalPassages` and `charOffset`, the exact offset to
hand `get_document`. Because dense retrieval has no relevance threshold — it always returns the
closest passages — every non-empty answer carries a `note` telling the model to judge relevance
itself; a tenant with nothing indexed gets `knowledgeBase` (what exists) and a `hint` instead, and
one with no embeddings provider gets `{ error: 'knowledge_search_unavailable', hint }` rather than a
failure. `get_document` — one document in full or as an `{ offset, maxChars }` window (≤ 50 000 per
call, with `totalChars` / `returnedChars` / `hasMore` / `nextOffset`); unknown, other-tenant,
unconverted or failed ids answer `{ error, hint }`, an unknown id with the documents that do exist.
`list_documents` — the indexed documents, newest first, paged, with titles, sizes and passage
counts: what a model needs to choose search wording or to say honestly that a topic is not covered.
An agent built on
`runToolLoop` passes `[...ctx.tools, …own tools, terminal tool]`; the forced single-tool example does
not use it. Everything indexed — pasted, uploaded, or written by an agent — is therefore available
to agents as well as to people.

**Embeddings and retrieval (D18).** `documents` (`content` kept for re-index and read back one
WINDOW at a time — never a whole column in one response; `fileId` → the uploaded original) and `chunks` (`embedding vector(1024)` — `EMBEDDING_DIM`
in `@rocketflare/shared/ai/config`; HNSW `vector_cosine_ops`). Two ways in, one path
(`services/ai/ingest.ts`): `ingestText` (`POST /api/ai/documents/ingest`, JSON, ≤ 500 000 chars)
and `ingestFile` (`POST /upload`, multipart `file` + optional `title`/`source`, ≤ `MAX_UPLOAD_BYTES`,
allowlist `DOCUMENT_UPLOAD_TYPES` in `@rocketflare/shared/ai/embeddings` — PDF, Word, Excel,
OpenDocument, HTML, XML, CSV, JSON, Markdown, text; extension decides when the browser declares no
type). Both resolve embeddings first (no provider → 503, no orphan row); an upload also checks the
converter (a binary type on a Worker without `[ai]` → 503 `conversion_not_configured`, nothing
written), stores the original in R2 as a `files` row (scope `documents`, downloadable at
`/api/files/:id`, deleted with the document), and inserts `pending` with the ORIGINAL media type.
Text-like uploads are decoded (UTF-8, CRLF normalised) and, like pasted text, chunked
paragraph-aware (~800 tokens, 100 overlap, 4 chars per token estimate) then indexed inline when ≤ 50
chunks, else through `document.index`; every other type stays `content: null` and a
`document.convert` job reads the object back, runs **Workers AI Markdown Conversion**
(`env.AI.toMarkdown({ name, blob })` — free for documents, the same binding as embeddings; no new
resource), stores the text and runs the same `indexDocument`. A `format: 'error'` answer, a missing
object or text over the cap is permanent → `failed` with the reason, acked; a thrown binding or
provider error → `failed` + retry with backoff (a missing `JOBS_QUEUE` throws, never a silent inline
fallback).
**Documents carry visibility (D29, §1).** `searchChunks(db, cfg, env, scope, request)` takes an
`AccessScope`, not a tenant id — the scope carries the tenant, and `visibleDocuments(scope)` is
ANDed onto BOTH halves of the hybrid query. Because a selective filter on an approximate HNSW scan
can exhaust its candidate list before filling the pool, the dense half sets
`hnsw.iterative_scan = relaxed_order` (pgvector ≥ 0.8) `SET LOCAL` in a transaction — but only when
a predicate is in play, so an admin's search still costs one statement. `document-content.ts`'s
three readers take the scope too, so `get_document` and the viewer cannot disagree about what is
readable; `AgentToolContext` carries `scope` rather than `tenantId`, and `executeRun` builds it at
EXECUTE time from `agent_runs.requestedByUserId` — current membership, never a snapshot taken at
enqueue — with a requester-less ("system") run getting tenant-visible documents only. A hidden id
is indistinguishable from an unknown one everywhere, including the `knowledgeBase` list
`get_document` offers back. `GET /api/files/:id` for a `documents`-scope object checks its owning
document's visibility, without which the restriction is one file id away from being nothing.

`searchChunks` (`POST /search`) is hybrid: dense `<=>` over the HNSW index plus lexical
`websearch_to_tsquery` / `ts_rank_cd` over `to_tsvector('english', text)`, each contributing a pool
of `min(max(limit·4, 50), 200)`, fused by Reciprocal Rank Fusion (`k = 60`); every hit carries
`denseRank` / `lexicalRank` and its place in the document — `seq` of `documentPassages`, plus
`charOffset`, the character position of the passage in the document's text (resolved with one
`position()` query over the returned hits, so nothing is stored), which is what lets a reader or an
agent jump straight to it with `get_document`. Vectors are pgvector rows under the tenant predicate and RLS, not
Vectorize; `apps/web/scripts/migrate.ts` runs `CREATE EXTENSION IF NOT EXISTS vector` before the
migrations.

**Reading a document (D18).** Three endpoints on `/api/ai/documents`, all `read Document`, all
tenant-predicated, and an unknown id and another tenant's id answering the SAME 404 body so the API
is not an existence oracle: `GET /:id/content?offset=&maxChars=` (one character window —
`documentContentSchema`, default 20 000 and hard cap 50 000, with `totalChars` / `hasMore` /
`nextOffset`), `GET /:id/passages` (the stored chunks by `seq`, paginated), `GET /:id/card`
(`documentCardSchema`). A document whose text is not there is a **409** — `document_not_converted`
while its job is pending, `document_conversion_failed` after — never an empty window, because "not
converted" and "empty" are different answers and the viewer renders a different thing for each.

`services/ai/document-content.ts` is the ONE implementation and `get_document` delegates to it, so
the tool and the viewer cannot disagree about what a document says (`agent-tools.test.ts` pins the
tool's JSON down to key order — the model reads it, so its shape is a contract). Every window is
cut in Postgres (`substring(content from $1::int for $2::int)` + `char_length`); before the
extraction the tool pulled the whole column into the isolate to slice 20 000 characters out of it.
The passages query names its columns so `chunks.embedding` — 1024 floats a row — can never reach the
wire through a later `select()` widening, and `chunkCharOffsetSql` is shared with `locateChunks` so a
search hit and the passage list agree on where a passage starts.

**The card is an EXCERPT, not a summary.** `documentCardSchema` carries the first 320 characters of
the text, whitespace-collapsed. There is no `documents.summary` column and **no server-side
rasterisation on Workers** (no canvas, no pdfium; `env.AI.toMarkdown` returns text, not an image), so
there is no thumbnail and will not be one without an external service. It is `null` while a document
is `pending` or `failed`, and for a converted PDF it is usually the cover page. The documented
extension is a `documents.summary` column filled by a `document.summarize` job reusing
`summarize-text`, preferred over the excerpt when present.

**The viewer (`/documents/:documentId`, guard `read Document`, no nav entry).** Two tabs
(`?tab=document|details`). The Document tab dispatches on `fileId`, the upload kind and the status:
a PDF embeds its ORIGINAL with `<object>` — whose CHILDREN are the fallback, so nothing tries to
detect failure (there is no reliable success event), and the panel header always carries **Download
original** and a **Converted text** toggle so a browser with a poor in-page viewer has a one-click
escape; an Office/HTML document renders its converted markdown; a pending one says so. Markdown
renders AS markdown, with a Plain toggle — highlighting is what gives way, since `<mark>` cannot be
threaded through react-markdown's AST. Deep links: `?offset=` is authoritative and is SNAPPED down to
a window boundary, so a link into the middle of a window and the reader's own paging share one cache
entry; `?chunk=` is the fallback when a passage's `charOffset` is null (re-chunked); `?q=` marks
matches as `<mark>` NODES, never `dangerouslySetInnerHTML` over text somebody uploaded. Because
`content` is capped at `INGEST_TEXT_MAX_CHARS` a document is at most 25 windows, so Previous/Next is
one query per snapped offset with nothing accumulating in local state. The Details tab is metadata,
chunking figures and the paginated passage list, each row linking back into the text at its offset.
`DocumentCard` is markdown-free by construction, which is what lets it live in the eagerly imported
`components/shared` barrel and be used by Search, by a citation, and by `Markdown` itself — a link
whose href matches `/documents/<uuid>` renders as a card rather than an external `<a>`.

**Usage (D18).** `recordUsage` writes one `ai_usage` row per model call (`feature`, `provider`,
`model`, four token counters, `costMicrocents` from the price table below):
the chat route after the stream (`feature: 'chat'`), agents from `callStructuredTool`'s `onUsage`
(`agent:<key>`). `GET /api/ai/usage/summary?from&to` (default last 30 days, `manage AiConfig`) groups
by (provider, model, feature) with grand totals. **Prices are ONE table**,
`@rocketflare/shared/ai/pricing` (`MODEL_PRICES`, USD per million tokens, longest-prefix match so a
dated id like `claude-sonnet-4-5-20250929` resolves, `PRICES_UPDATED` records when they were last
checked): `recordUsage` freezes a row's cost from it at write time — a later price edit cannot
rewrite history — and the summary prices rows that have no stored cost with the same helper, so
existing data is not half blank. A model the table does not know is `null`, never a guess, and its
calls are counted in `unpricedCalls` so a partial total says so. The Usage page labels the figure an
estimate and names the file; correcting the rates for your own account is editing that one file.

**Tracing (D16).** `Tracer` seam (`observability/tracer.ts`) with `noopTracer`; the only
implementation is `createLangfuseTracer` (`langfuse-fetch.ts`) — `trace-create` / `generation-create`
/ `span-create` events batched in memory and POSTed once to `/api/public/ingestion` with basic auth
`publicKey:secretKey`; errors are swallowed and logged. `tracerFor(cfg)` returns it only when BOTH
`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set; `tracerMiddleware` (mounted on `/api/*`) sets
`c.get('tracer')` and flushes in `waitUntil`; the chat stream and `executeRun` flush themselves.
`withAgentTrace(name, ctx, fn)` brackets a run or a turn; `traceChatClient(client, trace, meta)` wraps
the client so every `complete`/`stream` is one `generation` with usage. No OpenTelemetry dependency.

**Permissions.** `AiConfig`, `Prompt`, `Document`: admin+ `manage`, member `read` (plus `create
Document`; own-document delete is the route's `ownerUserId` check). `Conversation`, `AgentRun`: every
role `manage`, ownership enforced route-side (§1 matrix). `/api/ai/usage` and `/api/ai/agent-models`
writes require `manage AiConfig`.

**UI (Phase 3b-UI; specifics in `apps/web/src/ui/CLAUDE.md`).** Routes `/agents` and
`/agents/runs/:runId` (guard `read AgentRun`; nav "Agents"), `/documents` (guard `read Document`;
nav "Knowledge" — the paginated documents table, then `?tab=text|file` add tabs below it) and `/search` (same guard;
nav "Search" — hybrid search, `?documentId=` narrows, `?q=` prefills and runs the search on mount and
every submitted search is written back to the URL), Settings `?tab=agent-models` (`manage AiConfig`).

**A run is a PAGE, not a drawer**, because it is something a person is asked to *act* on: they
arrive from a notification, may need to read a document before deciding, and may leave and come
back. `RunPage` is the workspace — `ActionRequiredPanel` when the run owes an answer, then a header
carrying the elapsed time and Cancel, then the run's INPUT as labelled values (read from the
agent's own `inputJsonSchema` through the one field renderer, falling back to the JSON whole), then
the timeline and a right pane of `URLTabs` (`?tab=output|artifacts|usage`, default `output`) side by
side, with `SteerComposer` under the timeline while the run is still working. A failure is
`RunErrorAlert` above the tab bar, not a tab. **The split between the two columns follows the run's
state and then the reader's** (`runLayout`, pure): timeline-major while it works, output-major once
it settles, and an override that wins permanently — a run settling mid-read must not swap the
columns under somebody. The timeline is a bounded, viewport-relative scroller from `lg` up rather
than a panel that grows for ever. `ActionRequiredPanel` branches on the four interrupt kinds and shares its field
renderer with the generated input form, which is why a fifth kind is cheap. The Agents nav item
carries a badge from the interrupts inbox.

**An open run streams** (`useRunStream` over `GET /runs/:id/agui/stream`), and the stream is the
ONLY writer of `['agent-run-agui', id]` — a nudge must never invalidate that key or a live timeline
would be wiped by the thing telling it to refresh. Polling is the fallback, and its predicate is
`runOwesAnswer` (`queued | running`), deliberately **not** `isRunActive`: a run parked on a person
owes nothing, and polling it would mean every open tab re-reading it for the length of
`AGENT_INTERRUPT_TIMEOUT`. The list polls while any listed row owes an answer, and everything is
still refreshed by the server's `entity.changed { entity: 'agent-run', id }` nudge, because the runs
query-key root is `['agent-run']`. **Convention: the `entity` string of an `entity.changed` nudge IS
a `queryKeys` family root**, so `invalidationsFor()` covers a new resource with no UI socket code.
Documents poll every 5 s while a row is `pending` — nothing emits a document nudge yet.
Requested-by renders "You", a short id or "system" (no name resolution). An agent's input form has
three rungs: a registered `forms/<key>` entry, else one generated from the agent's own JSON Schema,
else a JSON textarea validated by the route's 400 `details`; the UI never sends `?strict=1`.

**Known gaps / not built yet:** Reading a document — the card's `excerpt` is the head of the text,
not a summary, and there is **no thumbnail** (no rasterisation on Workers); `charOffset` is an offset
into the CONVERTED markdown and does not map to a PDF page, so a passage deep link into a PDF opens
the converted text, and Chrome's `#page=` / `#search=` fragments are non-standard and used
best-effort only; a `?q=` on a markdown document highlights only in the Plain rendering; **a tenant
API key can now page a whole document's text**, where before it could extract only search passages —
the permission model already treated document text as readable by any member (`POST /search` returns
whole passages, `get_document` full windows), so this widens the convenience rather than the
audience, and an app that wants it closed should add a separate ability rather than narrow this one.
AG-UI — one text message PER MODEL TURN, so a client that expects
one message per run must accumulate (the persisted row's id is in `kit.chat.ids` and
`RUN_FINISHED.result`); no frontend tools in CHAT (`POST /api/agui/run` refuses `tools[]`) — the
agent runtime now has the durable suspend point that argument turned on (`step.waitForEvent` plus
`agent_run_interrupts`), so what is left is wiring a conversation to it, not inventing it; and
no `STATE_DELTA`, only a read-only `STATE_SNAPSHOT`; the protobuf transport drops `TOOL_CALL_RESULT`
because `@ag-ui/proto@0.0.59` has no message for it; `@ag-ui/core` is `0.0.x` and its published
docs already describe fields the installed version lacks, so a minor bump can rename a schema and
change the wire format for every adopted copy — the exact pin plus `agui-contract.test.ts` is the
mitigation and the residual risk is real; the agent projection has no `kit.usage` and no error flag
on a tool result; the run stream honours `Last-Event-ID` but **the protobuf transport has no
cursor at all** (it has no SSE framing), so a binary client must resume by `?afterSeq=`, and the
stream carries only durable ROWS — token-by-token text for a run would need the per-run Durable
Object fan-out, which is not built. Chat tools —
`CHAT_MAX_TOOL_TURNS` is a constant, not a var; a tool-calling chat costs more per turn and stops
streaming token by token on `workers_ai`; `get_document`'s window is capped by the CALLER
(`AgentToolContext.maxDocumentChars` — 50 000 for an agent run, `CHAT_GET_DOCUMENT_MAX_CHARS`
6 000 for a chat turn) but the chat figure is a constant, not a var, and nothing derives it from the
model. History — the budget is characters, not tokens (4 chars per token is the kit's estimate
everywhere); nothing derives it from the model's actual context window, because
`services/ai/providers.ts` carries no context-window field (Workers AI's catalog DOES publish one
per model, so that list is where it would come from); the sliding window means a long thread's
cached prefix moves every turn, so prompt caching stops paying exactly when the thread is long
enough to need it — trimming in batches rather than one message at a time is the fix, and it is not
built; a conversation's summary is never shown to the user and there is no "forget this thread"
control. `enqueueRun` does NOT pre-resolve the chat client — a tenant with no
provider gets a 202 and a `failed` row at `execute` (chat's `POST /conversations` does pre-resolve;
moot while the `[ai]` binding exists, since Workers AI is the floor); Workers AI forced tools are an
instruction plus prose-JSON recovery, not a guarantee — a model that answers in plain prose fails
`callStructuredTool` after its one retry, and the run's `error` event then carries `details` (the zod
issues, or `{ reason, stopReason, text }` with what the model said), which the Agents drawer renders
collapsed as "What the model returned"; `stream()` with tools on `workers_ai` is non-streamed; a Workers AI binding error carries no
HTTP status and classifies as `unknown` (agents do not retry it);
the connection test spends tokens but writes no `ai_usage` row; `GET /api/ai/config/providers` has
no shared schema (the UI keeps a permissive `passthrough` one in `hooks/useAiConfig.ts`);
`ai_configs.label` is the upsert key, so a rename is delete + re-add; `/settings` is admin-guarded,
so members hold `read AiConfig` / `read Prompt` with no nav path to the read-only views;
no document
nudge (`ingestText` / `ingestFile` / `indexDocument` emit nothing; the Knowledge page polls); runs
show a user id, not a name (a steering note is the one exception — it stores `authorName`); uploads: images are not accepted (their conversion runs two AI models
and bills — no OCR), converted text is capped at `INGEST_TEXT_MAX_CHARS`, there is no re-convert /
re-index action (`content` is kept for one), a converted document stores both the original and the
text, and `content` is the converted markdown — the UI never shows it; no rerank (a `RerankFn` seam is the documented extension) and no
generated `tsvector` + GIN — the lexical half computes `to_tsvector` at query time; no non-exclusive
agents (relax the partial unique index — noting that its predicate now also covers a parked run); HITL: an ask cannot be re-asked or amended once
written (cancel the run); there is no reminder or escalation as `expiresAt` approaches, and a park
is bounded in practice by **instance retention — 3 days on Free, 30 on Paid — not by
`AGENT_INTERRUPT_TIMEOUT`**, so on Free a longer park relies entirely on `expireParkedRun` and the
`not_found` restart; `MAX_INTERRUPT_ROUNDS` abandonment settles the run `failed` with no way to
raise the bound per agent; steering is delivered once and never acknowledged back to the sender;
artifact size caps live in the contract, so an oversized one is a write-time error rather than a
spill to R2; `approvers` has two values and no per-ask override; and nothing gates an interrupt on
a feature flag. **The tool loop is one `execute` step and stays that way** —
one `step.do` per model turn was investigated after the durable transcript landed and rejected,
because all three things it was supposed to buy turn out to be already delivered or one config line
away, while the cost is a rewrite of the agent contract. Cloudflare's own limits are the reason:
*wall-clock duration per step is **unlimited*** (the `timeout: '10 minutes'` on `execute` is the
kit's own policy, not a platform cap, so a slow run is fixed by raising it), *CPU per step is 30 s
by default and configurable to 300 s* via `[limits] cpu_ms` **and excludes network I/O and database
queries**, which is nearly all an agent run does, and *max steps per instance is 10 000 on Paid*, so
step count was never the constraint. Retrying one turn instead of the whole run is what the
checkpoint already achieves — a retry resumes at turn N rather than replaying 1…N-1. Against that,
the split needs `run()` to move OUTSIDE `step.do` (steps cannot nest — Cloudflare documents no
nesting, and `step` is only handed to `run()`), and Workflows replays everything outside a step:
*"the step logic will be preserved, but logic outside of the steps may be duplicated"*. So every
side effect in an agent — each `agent_run_events` emit, the cancel poll, `ctx.checkpoint.load`,
`ctx.once`, `recordUsage`, every tool handler — would have to be individually step-wrapped or the
timeline doubles on replay, and `runToolLoop`'s `max_turns` stop reason would misfire the
`research-topic` salvage on every non-final turn. Revisit only if an agent ever does heavy CPU
*between* model calls; no budgets or
quotas over `ai_usage` and no price table; prompt versioning, an evals harness, Bedrock/Azure/Gemini
adapters and a per-run Durable Object fan-out for live TOKENS are deferred; an orphan-run cron was
replaced by settle-on-read plus `expireParkedRun`, which between them cover a lost instance and an
abandoned park — but both need somebody to OPEN the run, so a run nobody looks at again stays
active-looking until they do; the demo seed's chunk vectors are deterministic hash vectors
(`services/ai/deterministic-embedding.ts`, `embeddingModel: 'seed:deterministic'` — a `tsx` script
has no embeddings provider), so against a query embedded by the real provider dense retrieval over
seeded documents is noise and the lexical rank is what carries the demo; never mix them with real
embeddings.

## 10. Deployment

**Status: tomls, CI, deploy workflow and scripts built (Phase 0); first real deploy in Phase 5.
Provisioning: `pnpm provision <phase>` (`apps/web/scripts/provision.ts` — REST over `fetch`, no
vendor CLIs: Neon project + `staging` branch with a password per branch, Hyperdrive / KV / Queue /
R2 through `cf-provision.sh --apply`, string-level toml patching, migrations per branch, GitHub
Environments + secrets, first deploy with `/api/health` + `/api/ready`, Worker secrets over stdin,
Resend domain + Cloudflare DNS records + verification; preflight resolves every custom host and the
sending domain to a zone the user has already put on the Cloudflare account — registered there or
nameservers moved; none → `workers.dev` hosts and `--skip-email`; `all` runs every phase, idempotent, one
`Verify:` line each; the vendor tokens come from the environment first, then the git-ignored
`apps/web/.provision.env` that `pnpm provision tokens` writes from hidden, vendor-verified prompts —
never `.dev.vars`) and the `/rf-provision` skill that drives it.**

Two standalone tomls (D6) in `apps/web` — `wrangler.toml` production, `wrangler.staging.toml` —
kept identical in everything code can observe by `apps/web/tests/config/wrangler-parity.test.ts`,
with account-scoped names suffixed `-staging`. Neon: one project, a branch and a role per
environment, Hyperdrive per environment on the **direct** host. The release dance: tag `X.Y.Z` →
staging; publish the GitHub Release → production, shipping the exact validated tag with
`RELEASE_VERSION` injected. **The tag must equal the root `package.json` version** — one tag ships
web and cli together; `apps/*` versions are informational. `ci.yml` is the single gate, run at the
workspace root (`pnpm lint`, `pnpm typecheck` + typegen diff of `apps/web/worker-configuration.d.ts`,
`pnpm test` on real Postgres for web plus the cli suite, `pnpm build`, gitleaks) and is *called* by
`deploy.yml`, not copied. Only `apps/web` deploys; `wrangler` runs inside that package
(`pnpm --filter @rocketflare/web exec wrangler …`). The CLI is built as a compile check and distributed via
the repo — publishing it is an app decision; the package is private by default. Full reference:
`docs/DEPLOY.md`.

**Known gaps / not built yet:** a root `release` script (bump-commit-tag helper) is optional and not
shipped; no per-PR previews; a CI check that every `apps/web/src/**/CLAUDE.md` exists and every
`docs/*.md` is linked is proposed, not implemented; no CLI publishing pipeline. Provisioning: no
automated Workers-plan check — a refused `wrangler hyperdrive create` IS the check (the script maps
it to the upgrade URL); the DKIM/MX records are created `proxied: false` and an existing proxied
record at the same name is left alone and only reported; the Resend region is permanent per domain
(delete and re-create to change it); the REST clients' pure helpers (`provision/{neon,resend,redact,patch-toml}.ts` — URL building,
endpoint/role pickers, DNS-record mapping, redaction, toml patching) are unit-tested in the `config`
project, but the HTTP calls themselves have not yet been run end to end against live accounts;
provisioning only staging cannot pass `REQUIRE_PROVISIONED=1` — the parity test checks BOTH tomls,
so it runs provisioned only once `cloudflare production` has patched the second file; the `tokens`
prompt path (hidden readline over a muted output, the per-vendor checks, the 0600 write) needs a TTY
and is not exercised by the suite — only its pure helpers (`provision/env-file.ts`: parse, upsert,
mask, resolution order, the redact registry) are.

## 11. CLI

**Status: built (Phase 1).** Package `apps/cli` (`@rocketflare/cli`), bin `rocketflare`. Dev: `pnpm cli
<command>` from the root (`tsx`); build: `tsc` → `apps/cli/dist/cli.js`. Stack: `commander` +
`chalk` + `open` (D26). Conventions: `.claude/rules/cli.md`.

**Every app — internal tool or B2B product — wants a CLI, and it must never own a second copy of the contract.** The CLI is a
thin client over the same `/api/*` routes the UI uses, authenticated with a tenant API key, parsing
every response with the same `@rocketflare/shared` zod schema the server validated with. Adding a command
is: schema in `packages/shared` (if new) → route → `apps/cli/src/commands/<name>.ts` calling
`apps/cli/src/api.ts` (the only `fetch` site: adds `Authorization: Bearer`, parses the envelope,
maps status → exit code).

**Login handoff.** `rocketflare login [--server <url>]` starts a loopback HTTP listener on the first free
port in `127.0.0.1:8765–8770`, opens the browser at
`<server>/auth/cli?redirect_uri=http://127.0.0.1:<port>/callback&hostname=<machine>`, and waits
(5 min timeout). The server side (§2) authenticates the user, asks for a tenant (skipped in `single`
mode), mints a tenant API key `cli:<hostname>` and redirects with `?key=&tenant_id=&tenant_name=`.
The listener answers a self-closing page, verifies the key with `GET /api/me`, stores it, shuts down.
`logout` deletes the local key; revoke it server-side in Settings → API keys (or `keys list` to find it).

**Config.** `~/.rocketflare/config.json` — directory `0700`, file `0600`, re-tightened on every write —
holding the server URL, API key, active tenant and signed-in user. `ROCKETFLARE_CONFIG_DIR` relocates the
directory (tests use a temp dir). **Env overrides win**: `ROCKETFLARE_API_KEY` and `ROCKETFLARE_URL` make the CLI
usable in CI with no browser and no file; `ROCKETFLARE_DEBUG` turns on debug lines. `rocketflare config` prints the
effective config with the key masked (prefix only) — no command ever prints a full key.

**Commands (Phase 1).** `login`, `logout`, `whoami` (`GET /api/me` + `GET /api/tenant` → user,
tenant, key prefix), `status` (`GET /api/health`, unauthenticated → reachability, environment,
release version), `members list`, `keys list`, `activity list` (`--page`, `--page-size`;
`paginationQuerySchema` in, `{ items, pagination }` out), `config`. `--server <url>` and `--json`
are global: with `--json` a command prints only the parsed response, so output pipes into `jq`.
Human output is `chalk` tables on stdout; diagnostics go to stderr.

**Exit codes (D26).** `0` ok · `1` error (API non-2xx other than 401/403, network, bad options,
unexpected) · `2` not logged in (no key, or 401 — hint: run `rocketflare login`) · `3` forbidden (403).
Commands throw `CliError`; `cli.ts` catches once, prints once and sets `process.exitCode`, so tests
run commands in-process with an injected `fetch`.

**Known gaps / not built yet:** no device-code flow for headless machines (use `ROCKETFLARE_API_KEY`); no
multi-profile config (one server + tenant at a time; `login` again to switch); `logout` does not
revoke the key server-side; no shell completion; no publishing pipeline — the package is private and
runs from the repo.

## 12. Shared package

**Status: built (Phase 0).** `packages/shared` (`@rocketflare/shared`), **private** (`"private": true`, no
`publishConfig` — never publish it).

**One contract, three consumers, zero build.** The zod schemas, inferred types, error envelope
(`errors.ts`), pagination (`pagination.ts`), permission vocabulary (`permissions.ts`: actions,
subjects, `AppAbility`, packed rules) and the AI contracts (`ai/*.ts` — config, prompts, chat, the
AG-UI contract (`agui.ts`), agents, agent-models, embeddings, usage; barrel `ai/index.ts`, deep imports
`@rocketflare/shared/ai/<file>`) live in `packages/shared/src/` and are consumed as
TypeScript source through the workspace link: `package.json` `exports` map `@rocketflare/shared` →
`./src/index.ts`, `./ai` and `./plugins` (D31, §16) to their barrels, and `@rocketflare/shared/*` →
`./src/*.ts` — a FILE, which is why a plugin's contracts are imported as
`@rocketflare/shared/plugins/<id>/index`. So `apps/web` (API and UI), `apps/cli` and
their tests import `@rocketflare/shared/<module>` and Vite / wrangler / tsx / vitest all resolve the `.ts`
directly. There is no `dist`, nothing to rebuild after an edit, and typecheck is one `tsc` per
package extending `tsconfig.base.json`.

**Contracts first (D13).** A new or changed API surface *starts* here: `<thing>Schema` for a
response/entity, `<thing>RequestSchema` for a body, `<thing>QuerySchema` for query params, `type
<Thing> = z.infer<…>` next to each; re-exported from `index.ts`. Then the route `validate()`s with
it, the UI parses with it (`api.get(..., { schema })`), the CLI parses with it (`api.ts`). jsonb
column types in the DB schema also come from here (`$type<>()`).

**Dependency rule.** `packages/shared` imports `zod`, its own siblings, type-only `@casl/ability`
and — in `src/ai/agui.ts` alone — the pinned, zod-only `@ag-ui/core`, because AG-UI is a wire format
and both sides must validate against the same runtime schema (§9;
`apps/web/tests/config/shared-imports.test.ts` enforces the list) — **never** `apps/web` (it must bundle for the browser and load in the CLI) and never `apps/cli`.
`apps/cli` in turn never imports `apps/web`. `src/plugins/**` carries one more rule of the same
kind (D31, §16): never a RUNTIME import of one of the five composers — `ai/agents.ts`, `jobs.ts`,
`permissions.ts`, `features.ts`, `realtime.ts` — because those read the plugin barrel, and two zod
modules in a cycle crash at module evaluation rather than failing to compile.
Biome and each package's `tsconfig` `include` keep the
direction honest; a violation shows up as a browser bundle pulling in `postgres` or `hono`.

**Known gaps / not built yet:** shared has no test suite of its own (its `test` script is a no-op) —
its contracts are exercised by the `apps/web` and `apps/cli` tests; no OpenAPI emitted from the
schemas; no runtime-versioning of contracts between a deployed web and an older CLI (both ship from
one tag).

## 13. Upgrading a copy

**Status: built.**

**A copy of the kit is detached and renamed, and it still absorbs later kit releases.** That is the
whole of this section, and it is the one part of the kit whose failure mode is other people's
repositories.

The shape of the problem: `docs/ADAPTING.md` §0 has adopters delete the kit's history (a shared one
only invites conflicts with a template that keeps moving), `scripts/rename.mjs` rewrites nine token
classes so nothing matches by name any more, and §2 tells them to delete the example agents, cubes
and CLI commands. So a raw kit diff matches nothing and, applied anyway, **recreates exactly what
they deliberately removed**. Three pieces fix that.

**Provenance: `.rocketflare.json` (D27).** Tracked, at the root, and the one file that keeps the
kit's name in a renamed app — because it describes the kit, and because a fixed path is what lets
the tooling find it. `kit.{repo,version,commit}` says where the copy came from (`scripts/install.sh`
stamps the commit, and `version` ships pre-set so a hand-clone knows it too); `app.{slug,display,
domain}` is written by `rename.mjs` at the end of its pass and re-derives the full token map through
`deriveNames()`; `history[]` records each upgrade. It is on `EXCLUDED_PATHS`, so the rename never
substitutes inside it. **`app === null` is the "am I the kit?" predicate**, and every kit-only check
early-exits on it — without that, a copy inherits the kit's release discipline and fails CI on its
own first commit. That question is now asked in exactly one place:
`readManifest()` (`scripts/lib/manifest.mjs`) returns `{ manifest, isKit, sidecar }`, having merged
the git-ignored `.rocketflare.local.json` sidecar that records a plugin installed into a kit
checkout (§16).

**The surface manifest.** `surfaces[]` lists what the kit ships that is meant to be replaced:
`kind: example` (the two example agents, the two example cubes and their fact table,
the `tenant-overview` template, the three read-list CLI commands, the demo seed),
`kind: optional-feature` (chat, agents, knowledge, analytics — whole features an app may remove) and
**`kind: plugin`** (D31, §16 — code that came from another repository, carrying the `source` block
that says which one). A plugin surface is also the one kind `classifyPath` answers
`skipped-plugin-owned` for: a kit diff never touches a byte a plugin owns, because that plugin has
its own release chain.
Each has an **anchor file, and presence is `existsSync` on it**: the adopter keeps no bookkeeping,
there is nothing to drift, and deleting the anchor is the entire act of opting out, forever. Beside
it, `neverPort` (the kit's identity — LICENSE, SECURITY.md, `install.sh`, the rename toolchain,
`CHANGELOG.md`, the tomls, `apps/web/migrations/**`), `manual` (README, CI workflows, every
`package.json`) and `core` path prefixes. `apps/web/tests/config/kit-manifest.test.ts` asserts every
anchor exists and is a file, and — the check that stops the whole thing rotting — that surfaces ∪
neverPort ∪ manual ∪ core cover **100%** of the repo's files, so a new top-level directory fails the
suite until somebody says what it is.

**Release notes written for an agent.** `docs/upgrades/X.Y.Z.md`, one per release, frontmatter
(`version`, `previous`, `breaking`, `migrations`, `areas`, `touches_surfaces`, `requires_surfaces`)
plus four fixed headings. `previous` makes an unbroken chain; `requires_surfaces` skips a whole
release that does not apply; `migrations` carries *descriptions*, never file names.
`docs/upgrades/unreleased.md` accumulates between releases and `CHANGELOG.md` is the human index.

**The mechanism (`scripts/upgrade.mjs`).** A git-ignored blobless bare mirror at `.upgrade/kit.git`
— never a remote on the app's repo, whose tags would collide with the kit's and whose objects the
adopter would push. Then: classify every changed path, drop everything under an absent surface,
translate the survivors through the **same** `applyReplacements()` the rename used, and write
`apply.patch`, whole translated files for additions, `reference/` copies for the manual decisions and
a `plan.json`. `--apply` writes the additions, `git apply`s the patch, and falls back to per-file
`--reject` so one stale file cannot block the rest. Two invariants make the translation safe and
`apps/web/tests/config/upgrade-lib.test.ts` asserts both: every substitution moves columns and never
lines, so `@@` headers stay valid (which is why `deriveNames` now refuses a newline in a display
name); and `index <sha>..<sha>` lines are **stripped**, because they name kit blobs that describe
nothing once the content is translated — their absence makes `--3way` fail loudly instead of merging
against the wrong preimage. A file the rename refuses to touch is never translated either, which is
how an app accumulates `docs/upgrades/*.md` still written in the kit's terms.

**What it will not do, and why each would be silent damage.** It never applies a kit migration:
every `meta/NNNN_snapshot.json` carries the *whole cumulative schema*, so dropping the kit's in
replaces drizzle's notion of current state with one that has never heard of the adopter's tables —
their next `pnpm db:generate` then emits `DROP TABLE` for their own data. It never writes a resource
id into a wrangler toml (a new binding arrives as a `<PLACEHOLDER>`, which is exactly what
`pnpm provision cloudflare <env>` fills). It never applies the kit's deletions unasked. It never
ports the root `package.json` version, which is the app's release version. And the version stamp is
written **last, only on a clean apply**, so an interrupted or rejected run re-runs from an unchanged
baseline (exit 4 means "work remains", not "failed").

**The discipline that keeps it true.** A behaviour change adds an entry to `unreleased.md` in the
same commit: a Claude Code `PreToolUse` hook nudges before `git commit` (advisory, and only inside a
session), `ci.yml` fails a PR that touches `apps/**` or `packages/**` without one, and `deploy.yml`
refuses a tag whose note, changelog section or version stamps are missing
(`scripts/release-check.mjs --tag`). `deploy.yml` also asks `--deployable` first and skips its two
deploy jobs for the kit itself, whose tomls keep their placeholders on purpose — an app always
deploys, and `isDeployable` defaults to deploying in every ambiguous case, because a false skip is
somebody's release quietly not happening. `pnpm kit:release <version>` writes all of it so the gate passes
by construction. The constraint under all of it: **released history is never rewritten**, because
every copy pins a kit commit.

**Known gaps / not built yet:** the wrangler tomls and `.dev.vars.example` are reported with a
rendered diff rather than semantically merged — the planned differ would emit typed ops through
`scripts/provision/patch-toml.ts` and insert a new binding as a placeholder; the reject rate scales
with how far an adopter has drifted from the kit's names and the report does not predict it; a copy
made before `.rocketflare.json` existed needs a one-off `--adopt <ref>`; there is no way to upgrade
only part of a release; `docs/upgrades/` has one entry per release, so a release that should never be
ported at all can only say so in prose; and nothing verifies that an adopter actually ran the
migration step — the report says it, the gate does not check it.

## 14. Definition of done for the kit

A fresh agent can copy the repository, run `bash scripts/bootstrap.sh` (or `/rf-setup`) with zero
external credentials and land in the browser signed in as the demo owner with the demo workspace
populated (`pnpm seed --demo`); `/rf-adapt <slug>` renames it (`docs/ADAPTING.md` §1 as one pass, the
six careful rows reported); log in via a logged magic link; `pnpm cli login` against the local
server and `pnpm cli whoami` with the minted key; invite a member, switch tenant, approve an access request;
run the same flow with `TENANCY_MODE=single`; watch the People page refresh live from a second
browser when an invitation is accepted and see the invitation email queued through `JOBS_QUEUE` and
delivered (or logged) by the consumer under `wrangler dev`; upload an avatar and fetch it back at
`/api/files/:id`; add an AI provider in Settings → AI (or set `ANTHROPIC_API_KEY`), pass the connection
test, hold a streamed chat whose turns and usage rows persist; start the `summarize-text` agent from
`POST /api/agents/runs`, watch its `agent_run_events` arrive through the nudge, cancel one, and see its
trace when Langfuse keys are set; ingest a text and get it back from the hybrid search, then ask
`research-topic` a question about it and read the answer with its citation; upload a PDF
on the Knowledge page, watch it go `Indexing → Indexed` and find a phrase from it in search, then
download the original; open a run's page and watch its timeline fill **live** (not in poll lumps),
and the Knowledge page list the ingested document; run **Summarise text** with *index the result*
on, watch it stop on "Add this summary to the knowledge base?", answer it from a second browser as
another member (one 200, one 409 rendered as "somebody else answered"), and see the run resume and
the document appear in `/documents` **exactly once** — then park one again, restart `pnpm dev`
before answering, and watch it resume across the restart (`SETUP.md` §2.5 is that walkthrough step
by step, and it is the only way to exercise `waitForEvent` — the Node suite cannot); create a Department group type with Finance and Operations under Settings → Groups, restrict a
document and a dashboard to Finance, and watch `member@example.test` lose them from Knowledge,
Search, Analytics and the chat box's answers while `owner@` keeps them — then move that person into
Finance from a second browser and watch them appear without a reload (D29);
query every cube as two tenants and see disjoint rows
(`tests/api/cubes/cube-isolation.test.ts`), run `pnpm web db:refresh-facts && pnpm web
db:check-facts` to a `fresh` fact table, `GET /api/analytics/pages` and find the seeded
`tenant-overview` page (and render it with live numbers once the analytics UI lands); and,
port a later kit release into a renamed copy with `pnpm kit:upgrade --apply` and watch it skip the
examples that copy deleted rather than recreating them (§13); turn the `example-feature` flag on
under Admin → Feature flags and watch the kit's reference PLUGIN (§16) appear whole — the nav item
and page, notes created and deleted at `/api/example-feature/notes` with tenant B unable to see
them, `rocketflare example-feature ping --json` enqueuing a job `wrangler dev` logs as
`example-feature.ping: pong`, and `pnpm db:generate` after its barrel lines were written producing
exactly one `example_notes` migration in the host's own journal; and,
run `/rf-provision` (or `pnpm provision all`) with three tokens (`CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID`, `NEON_API_KEY`, `RESEND_API_KEY` — or `--skip-email`) to a staging URL
whose `/api/ready` answers; and, following `SETUP.md` Part 3 by hand, deploy to a new Cloudflare
account changing only placeholders and secrets — with root `pnpm lint && pnpm typecheck && pnpm
test && pnpm build` green at every step and every behaviour described here still true.

---

## 15. Feature flags

**Status: built (D30).** Contracts: `packages/shared/src/features.ts` (+ `FEATURES` in
`permissions.ts`). Server: `apps/web/src/permissions/features.ts`, `api/middleware/feature.ts`,
`api/services/features.ts`. Schema: `db/schema/feature-flags.ts`, migration `0010`. UI:
`ui/lib/feature-guards.ts`, `pages/admin/FeatureFlags.tsx`.

**A feature flag is configuration, not a permission.** That sentence is the whole section, and it is
the one thing to get right. `globalAdmin` is `can('manage', 'all')` and `support` is granted
`access all`; in CASL both are wildcards covering `access` on every `Feature:<name>` subject. So a
gate that asks the ability answers "on" for platform staff whatever the deployment ships. An app
built on this kit shipped exactly that and had five routes open in production to platform staff,
while its cube and dashboard gates — which read `AuthContext.features` — stayed dark: two sources of
truth, disagreeing, in the design that set out to have one. **Every gate therefore reads the ARRAY**
(`hasFeature(auth.features, name)` on the server, `session.features` in the browser).
`applyFeatureFlags` still populates `Feature:<name>` for an app that genuinely wants
permission-style entitlements, and nothing that hides an unreleased surface may depend on it.

**Two layers, because there are two questions.** *Does this surface exist in this deployment?* is a
deploy-time release gate; *which organisations have it yet?* is an admin-controlled rollout.
`evaluateFlag` composes them as one total order:

```
environmentGated && key not in FEATURES_ENABLED  -> false     layer 1, the release gate
a tenant override row exists                     -> override.enabled
state 'on' / 'off'                               -> true / false
state 'rollout'                                  -> featureBucket(key, unitId) < rolloutPercent
no row                                           -> the registry default
```

Layer 1 is `FEATURES_ENABLED` in `[vars]`, **fail-closed**: blank means none, so a deployment that
forgets the var stays dark — the right direction, because this gate's failure mode is an unreleased
surface appearing in production. It is one key rather than one per flag, so an ordinary rollout flag
needs no toml edit; only a dark-ship (`environmentGated`) flag does, which is the deliberate
per-environment release decision. `wrangler dev` reads `[vars]` from `wrangler.toml`, which holds
the production value, so `.dev.vars.example` carries the key too — without it a feature shipped dark
in production is dark on every developer's laptop.

The override beats the rollout because that is what it is *for*: the design-partner allow-list and
the "this customer must never get it" block-list. Its `enabled` column is the decision and the row's
presence is the exception — the same "a column, not the presence of rows" rule `visibility` follows
(§1) — so the admin UI offers three choices (On / Off / Default), never a checkbox.

**Flag keys are code**, following `PROMPT_REGISTRY` and `AGENT_KEYS`: `FEATURES` in
`permissions.ts` plus metadata in `features.ts`. Adding a flag needs no migration, and
`requireFeature('new-reprots')` is a type error rather than a route that 404s for ever. Evaluation
iterates the registry, so a row whose key has gone is inert by construction — there is no
`archivedAt` and no create endpoint. Retiring a flag is: remove the gate from the code, deploy,
delete the registry line. The cost of that choice, stated: an admin cannot invent a key without a
deploy. Deliberate — a flag no code reads does nothing, and the code and its registry line ship
together.

**The kit itself ships no flag**, and that is a contract, not an omission. `CORE_FEATURES` is empty:
the demonstration flag moved into the `example-feature` plugin (§16), and a feature an app builds
usually ships as a plugin too. So `FEATURES` may legitimately be `[]`, `FeatureName` may be `never`,
and `featureNameSchema` can no longer be a `z.enum` (which needs a non-empty tuple) — it is
`z.string()` refined against `FEATURES`. Same runtime check, same output type, and it validates
against what is INSTALLED rather than against what was compiled in. `FeatureName` itself still names
the keys — it is derived from `[...CORE_FEATURES, ...plugin keys]` — so `requireFeature` and
`{ feature }` guards keep their compile-time check; it is only the wire-level schema that widened.

**`featureBucket` is a wire format.** FNV-1a 32-bit over `"<key>:<unitId>"`, mod 100, enabled when
`bucket < rolloutPercent`. Changing the hash, the separator or the modulus reshuffles every live
rollout, so `tests/config/features.test.ts` pins golden vectors. Three properties it guarantees:
**monotonic** — the bucket ignores the percentage, so raising one only ever ADDS units and nobody is
dropped from a rollout that grows (this is why the percentage must never be hashed in);
**independent across flags** — the key is in the hashed string, so flag A's 10% cohort is
uncorrelated with flag B's, where hashing the unit alone would inflict every early rollout on the
same unlucky few; and a **modulo bias** of ~2.3e-8, noted so nobody "fixes" it by swapping the hash.

**Resolution costs no extra round trip on the cookie path.** `resolveSession` carries a third
`LEFT JOIN LATERAL` beside the groups one, returning the stored state as jsonb; `resolveFeatures`
evaluates it in TypeScript, so one frozen hash serves the server, the admin preview and the `config`
test project, which has no database. The Bearer path reads its rows alongside `listUserGroups` under
one `Promise.all` — so a rollout reaches API-key callers on their next request, with no cache to go
stale. `resolveFeatures` is the single seam: a third source (a per-plan entitlement, say) unions in
there and no consumer changes.

**A feature ships dark on EVERY door**, and three of them have no nav entry:

| Door | How |
|---|---|
| API mounts | an optional third element in the mount table of `api/index.ts` — `requireFeature('x')` 404s `feature_disabled` beneath the whole prefix. **404, not 403**: a 403 confirms the feature exists. Declared once per surface, like auth |
| the cube registry | `cubesFor(features)`, filtered per request in `routes/cube-api.ts`. `allCubes` stays whole so `cube-isolation.test.ts` still proves every cube's tenant scoping — a cube's isolation must be proven whether or not its feature is on today |
| dashboard templates | `DashboardTemplate.feature` + `listTemplates(features)`. The sharpest one: `ensureDefaultDashboards` runs lazily on EVERY `GET /api/analytics/pages`, so an ungated template seeds itself into every organisation on the first load after a deploy — a gate that creates rows, not one that reveals them. `createTenantForUser({ features })` covers the other end, at all four call sites |
| nav, routes, settings tabs | `NavGuard` gains `{ feature }` and a list meaning AND, so the flag and the permission stay two readable facts rather than one conflated subject |

**Administering flags** is `/admin/feature-flags` behind `globalAdminMiddleware`; `FeatureFlag` is a
platform CASL subject reached only by `manage all`, like `AccessRequest` and `User`. A per-tenant
override change nudges that one organisation with `features.changed` (invalidating `['auth']`,
because flags ride the session); a platform change does not, because the hub is one Durable Object
per tenant and fanning out would be one RPC per organisation — it reaches open tabs on their next
`GET /auth/session`. `GET /api/features` is the tenant-scoped effective list for every member, and
what `rocketflare features list` reads: a tenant API key cannot reach `/api/admin/*` at all, since
`globalAdminMiddleware` resolves the session cookie only.

**Single-tenant mode.** `/admin/feature-flags` is not behind `requireMultiTenant` — flags are not a
multi-tenancy concept, and single mode always has a global admin by construction (`onNoTenant`
returns null unless `isGlobalAdmin`, so only the bootstrap admin can create the one organisation).
The override sub-routes ARE behind it, because with one organisation the platform state already IS
that organisation's answer. And a rollout counted in organisations is refused there with a 400: over
one organisation a percentage is all-or-nothing decided by an opaque hash, which reads as a bug.
Counting people is the useful unit in single mode, and works unchanged.

**Known gaps / not built yet:** **the gated code still ships in the browser bundle** — client-side
hiding is cosmetic and the server is the protection, as everywhere in the kit; no per-user targeting
beyond the rollout unit (no "force on for this person") and no scheduling; the audit trail is the
two `*_by_user_id` columns plus the request log, because `activity_events` is tenant-scoped and a
platform flip has no tenant; a platform change reaches open sessions only on their next session
fetch (past a few hundred active organisations, fan the nudge out through `JOBS_QUEUE` rather than
looping in the request); no cache on the Bearer path — fine while the registry is small, but past
~200 live flags memo `listFeatureFlagRows` per isolate and accept a flip taking that long to reach
API-key callers; and `features` is empty for a session with no organisation, so a flag can never
gate a pre-tenant surface.

**Cloudflare Flagship was considered and rejected**, and the reasons should be read before anyone
proposes it again. It is a real product (public beta since May 2026) with a `[[flagship]]` binding,
an OpenFeature provider, good targeting and consistent hashing on a configurable attribute. But its
tenancy model is *your Cloudflare account → apps → flags*: it has no notion of your customers, so
per-tenant state is expressible only as targeting-rule DATA, and mutating targeting rules is an
operator action rather than an application write path. A toggle is a full-object `PUT` (partial
updates silently drop rules) with no documented ETag, so two concurrent admin clicks are a lost
update; the audit trail records the API token, not the person; and there is no local flag store, so
`wrangler dev` would read the live app and break the kit's clone-and-run promise. Its browser SDK
needs a Cloudflare token shipped to the client, which a multi-tenant app cannot do. **It remains the
right tool for a different job** — rolling out the kit's OWN code across deployments, one app, a few
flags, edited by us. Do not conflate that with per-tenant entitlements. Also not a fit: *gradual
deployments* (a percentage split across two deployed Worker VERSIONS — a deploy concern that cannot
condition on request attributes), Zaraz, and `[vars]`/Secrets alone (baked into a version; editing
one is a redeploy). Workers KV is the only endorsed alternative substrate, but at ≤60 s propagation
and one write per second per key it is a slower, eventually-consistent, un-audited version of the
Postgres table the Worker already holds a connection to.

---

## 16. Plugins

**Status: the seam and the reference plugin built (D31, Phase A).** Types:
`packages/shared/src/plugins/types.ts`, `apps/web/src/plugins/types.ts`,
`apps/cli/src/plugins/types.ts`. Barrels: `packages/shared/src/plugins/index.ts`,
`apps/web/src/plugins/{server,ui,schema}.ts`, `apps/cli/src/plugins/index.ts`. Provenance:
`scripts/lib/manifest.mjs` + `.rocketflare.json` / `.rocketflare.local.json`. Tests:
`apps/web/tests/config/plugins.test.ts` (+ `helpers/plugins.ts`), `manifest-lib.test.ts`,
`shared-imports.test.ts`. Reference plugin: `apps/web/src/plugins/example-feature/**`,
`packages/shared/src/plugins/example-feature/`, `apps/cli/src/plugins/example-feature/`.

**A plugin is a git repository COPIED into an app, never installed from npm — exactly like the kit
itself.** That is the whole premise. npm would mean a published package, a compiled surface and a
version of the kit's internals frozen into someone else's build; copying means the plugin's code is
ordinary source in the app, readable, debuggable, editable, and translated into the app's own
vocabulary by `applyReplacements()` on the way in (§13) like every other line the kit ships. The
price is that an upgrade is a patch rather than a version bump, which is a machine the kit already
owns. **First-party only for now**: a plugin gets full Worker and database access, so installing one
is as trusting as merging a pull request, and there is no sandbox that would make it otherwise.

A plugin repo **mirrors the host tree exactly** — `apps/web/src/plugins/<id>/`,
`packages/shared/src/plugins/<id>/`, `apps/cli/src/plugins/<id>/`, `docs/plugins/<id>/` — so path
classification, the diff translator, `git apply -p1` and a reader's mental model all work unchanged.
It ships no migration, no toml and no `package.json`: those three are the host's, always.

**Four published entries, and nothing else is API.** `apps/web/src/plugins/<id>/index.ts` (server),
`.../ui/index.ts`, `packages/shared/src/plugins/<id>/index.ts` and
`apps/cli/src/plugins/<id>/index.ts` are what the plugin's own semver covers; everything else under
those directories is private. Core reaching into a plugin's internals, or one plugin reaching into
another's, is a config-test failure rather than a convention — otherwise the version number promises
nothing. (The shared entry is imported as `@rocketflare/shared/plugins/<id>/index`: the package's
`./*` export maps to a FILE, so the `/index` is load-bearing.)

**Five barrels, one line per plugin each**, and `pnpm plugin add|remove` writes them — an import
and a tuple entry in four, one `export *` in the fifth. That, the surface entry and one
`db:generate` are the whole of an install.

| Barrel | Exports | Read by |
|---|---|---|
| `packages/shared/src/plugins/index.ts` | `SHARED_PLUGINS` / `sharedPlugins` | `jobs.ts`, `ai/agents.ts`, `permissions.ts`, `features.ts`, `realtime.ts`, `config.ts` |
| `apps/web/src/plugins/server.ts` | `SERVER_PLUGINS` / `serverPlugins` | `api/index.ts`, `utils/routes/api-prefixes.ts`, `queues/jobs.ts`, `scheduled.ts`, `agents/registry.ts`, `agents/tools/index.ts`, `prompts.ts`, `permissions/abilities.ts`, `utils/db/tenant-helpers.ts`, `services/access.ts`, `scripts/seed.ts`, `rls-coverage` and the unscoped allow-list |
| `apps/web/src/plugins/schema.ts` | `export *` of each plugin's tables | one `export *` line in `db/schema/index.ts` — the single surface drizzle-kit, `typeof schema` and `rls-coverage` read (a name exported twice is TS2308, never a silent shadow) |
| `apps/web/src/plugins/ui.ts` | `UI_PLUGINS` / `uiPlugins` | `App.tsx`, `SideNav.tsx`, `SettingsLayout.tsx`, `lib/query-keys.ts`, `pages/agents/forms/index.ts` |
| `apps/cli/src/plugins/index.ts` | `CLI_PLUGINS` / `cliPlugins` | `cli.ts` |

**Every barrel exports two names for one list, and the reason is not style.** The `as const` tuple
(`SERVER_PLUGINS`) is what type-level derivations index; an EMPTY tuple indexes to `never`, and
`never.mounts` is a compile error — so everything that merely iterates reads the widened list
(`serverPlugins`) beside it. A bare kit has empty barrels and must still typecheck.

**Opening a closed set is one pattern: the kit's literal becomes `CORE_X`, and
`X = [...CORE_X, ...plugins]`.** The public name never changes, so nothing that READS a registry
moves; what moves is where you ADD to it.

| Slot | Kit registry it feeds |
|---|---|
| `SharedPlugin.jobs` | `CORE_JOB_VARIANTS` → `jobInputSchema` / `jobEnvelopeSchema`; `JobType` and `JOB_TYPES` are DERIVED from the schema |
| `SharedPlugin.agentKeys` · `promptKeys` · `subjects` · `features` | `CORE_AGENT_KEYS` · `CORE_PROMPT_REGISTRY` keys · `Subjects` · `CORE_FEATURES` / `CORE_FEATURE_FLAGS` |
| `SharedPlugin.config` · `realtimeRoots` | `coreConfigSchema.extend(...)` in `config.ts`; the `access.changed` invalidation roots |
| `ServerPlugin.mounts` · `apiPrefixes` | the mount table of `api/index.ts`; `API_PREFIXES` |
| `ServerPlugin.jobHandlers` · `agents` · `prompts` · `agentTools` · `scheduledTasks` | `coreHandlers` · `CORE_AGENTS` · `CORE_PROMPT_REGISTRY` · `buildAgentTools` · `CORE_SCHEDULED_TASKS` |
| `ServerPlugin.grants` · `rlsExcludedTables` · `unscopedAllowlist` · `visibilityResources` | `buildAbility` after the kit's matrix · `RLS_EXCLUDED_TABLES` · `CORE_UNSCOPED_ALLOWLIST` · `VISIBILITY_RESOURCES` |
| `ServerPlugin.hooks` · `extensions` | `onTenantCreated`, `seed --demo`; whatever another plugin reads |
| `UiPlugin.routes` · `nav` · `settingsTabs` · `queryKeys` · `agentForms` | `App.tsx` per tier · `composeNav(CORE_NAVIGATION, …)` · the settings tabs · `CORE_QUERY_KEYS` · `CORE_AGENT_FORMS` |
| `CliPlugin.register(program, action)` | the commander chain, after the kit's own commands |

`ServerPlugin<S>` and `UiPlugin<S>` are generic over the plugin's own `SharedPlugin`, so
`jobHandlers`, `agents`, `prompts` and `agentForms` are checked for EXHAUSTIVENESS against the keys
that same plugin declared: a missing handler is a type error in the plugin rather than a dispatch
failure in the host. That is also why `runHandler`'s `switch` is gone — the mapped handler table
already proves completeness, and it proves it for a set the kit cannot enumerate.

**`DeclaredBy<P, K>` is why those derivations survive an optional slot.**
`(typeof SHARED_PLUGINS)[number]['agentKeys']` reads a property off `as const` LITERALS, and a
plugin that omits an optional field genuinely has no such property — so the indexed access is a
compile error, not `undefined`, and installing one plugin with no agents would break the agent-key
derivation for every other plugin. `DeclaredBy` narrows the union to the members that DO declare the
field first; with none it is `never`, which is exactly the empty contribution these derivations
want. All six derivations use it.

**Namespacing is the rule that lets two plugins share one app.** The id matches
`^[a-z][a-z0-9-]*$` and never contains `rocketflare` (the rename translator would rewrite it, and
`index`/`server`/`ui`/`schema`/`types` are reserved because they are barrel filenames). Everything
keyed carries it: tables `<id>_*`, job types `<id>.x`, query-key roots and demo-seed ids `<id>:…`,
the API prefix `/api/<id>`, the CLI's top-level command, feature/prompt/agent keys, and AG-UI CUSTOM
events under `<id>.` — **never `kit.`**, which is the kit's own namespace and the one a third-party
client is entitled to ignore.

**A plugin is a SURFACE, so §13's machinery covers it for free.** The record is a
`kind: 'plugin'` entry in `.rocketflare.json` carrying `source: { repo, subdir, version, commit }`
(`repo` is never null — a plugin you cannot fetch again cannot be upgraded), `installedAt`,
`requires` and `history[]`. Presence is still `existsSync` on the anchor (`plugin.json`), so
deleting the directory IS uninstalling and there is no bookkeeping to drift. Two additions:

- **The git-ignored `.rocketflare.local.json` sidecar.** A plugin installed into the KIT
  (`app === null`) or anywhere with `--local` is an authoring convenience, not part of what the kit
  ships — committing it would push wiring for files a copy does not have into every copy made from
  that commit. `readManifest()` in `scripts/lib/manifest.mjs` returns the merged view plus `isKit`
  and `sidecar`, and is now **the one kit-vs-app predicate**: four scripts and two test files used to
  re-parse the manifest and each decide for themselves what "this is the kit" meant.
- **`classifyPath` gains `skipped-plugin-owned`.** A kit diff never touches a byte an installed
  plugin owns, because the plugin has its own repository and its own release chain.

**A plugin tests its behaviour; the host tests that it is a well-formed plugin.** A plugin's own
tests live inside its directory and run in the host's projects (`vitest.config.ts` discovers
`src/plugins/*/tests/{api,ui,config}`). `tests/config/plugins.test.ts` checks only what no plugin
author can verify for the combination a particular app installed: ids are namespaces and never the
kit's; query-key roots carry the id; nothing reaches into a plugin except through its four entries;
and a plugin's `ui.ts` imports only from a small allowlist (`react`, the heroicons set,
`@rocketflare/shared/*`, `@/plugins/types` and the three kit UI modules a nav item needs) with every
page reached as `lazy(() => import(...))` — that file ships in the MAIN bundle, for every reader,
including the ones who never open the plugin. Each check is a pure function over strings exercised
against fixtures as well as against what is installed, so the suite still means something with zero
plugins.

**Two constraints were measured rather than assumed, and both are load-bearing.**

- **Nothing under `packages/shared/src/plugins/` imports one of the five composers at RUNTIME** —
  `ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts`, `realtime.ts`. Those five read the
  plugin barrel, so importing one back closes a cycle, and two zod modules in a cycle do not fail to
  compile: they crash at module evaluation with one side holding `undefined`. A whole-declaration
  `import type { X } from` is fine (erased, and it is how `SharedPlugin.features` is typed against
  the ONE `FeatureDefinition` instead of a copy that drifts); `import { type X } from` is not,
  because eliding every specifier leaves an empty import clause whose fate is the bundler's.
  `shared-imports.test.ts` checks all three spellings.
- **A plugin declares `relations()` for its OWN tables only.** On drizzle-orm 0.45.2 a second
  `relations()` for a core table merges at runtime but NOT at the type level:
  `ExtractTableRelationsFromSchema` unions the two configs and `BuildRelationResult` then keys over
  their INTERSECTION, so adding one silently strips `with:` from that table's query results
  app-wide. The `one()` side on the plugin's own table expresses the FK fully; only the `many()`
  back-reference is unavailable. Re-measure before relaxing it.

**Visibility became a registry (D29).** `services/access.ts` exports `VisibilityResource`
(`{ key, noun, usageKey, predicate, setGroups, grantRows, countGrants }`) and
`VISIBILITY_RESOURCES`; documents and analytics pages are two entries in it and a plugin adds its
own through `visibilityResources`, so `setResourceGroups`, `grantsForResources` and the 409
`group_in_use` count are one dispatch instead of a two-value branch.

**Hooks are post-commit, idempotent and best-effort**, exactly like the kit's own:
`onTenantCreated` runs after the create transaction commits, each plugin in its own try/catch (a
plugin must never break sign-up), and `seedDemo` runs after the kit's `--demo` block with fixed ids
and `onConflictDoNothing`, its `demoId(key)` already namespaced.

**Migrations are never shipped and always generated by the HOST.** A plugin's schema files arrive,
the `export *` line is written, then `pnpm db:generate --name plugin-<id>-<version>` numbers the DDL
in the host's own journal. This is the same rule §13 states for kit upgrades and for the same
reason: a snapshot describes a whole cumulative schema, and importing a foreign one teaches drizzle
a current state that has never heard of the app's tables. Uninstalling is the mirror — the barrel
line goes, `db:generate` emits the `DROP TABLE`s, and orphaned tables are not a stable state.
`rls-coverage` treats a plugin table exactly like a kit table: `tenantIsolation()` or an entry in
`rlsExcludedTables` with a reason.

**`example-feature` is the reference, and it exists to be deleted.** It was the kit's demonstration
feature flag; it is now a plugin, and it gained the parts a flag alone could not demonstrate. In
three directories and five barrel lines it exercises every slot: the `example-feature` flag; a
tenant-scoped `example_notes` table (`tenantRef` + `timestamps` + `tenantIsolation`, indexes led by
`tenant_id`); a CRUD mount at `/api/example-feature` behind `requireFeature` (404
`feature_disabled`, gated at the MOUNT); the `example-feature.ping` job variant and its handler; the
`ExampleNote` subject with additive `grants`; a `list_example_notes` agent tool on every run's
`ctx.tools`; `onTenantCreated` and `seedDemo`; a lazy page with a nav item whose guard is the same
object the route uses; and `rocketflare example-feature ping|notes list`. Its own tests sit under
`src/plugins/example-feature/tests/` and pin that **tenant B can neither list, read nor delete
tenant A's notes** — so schema migration and tenant isolation are proven on something removable
before anything bigger moves out. Its surface's `source.repo` is the kit repo with `subdir: ""`
(vendored), which is why upgrading it defers to `kit:upgrade`.

**The decisions, in one place.**

| # | Decision | Choice |
|---|---|---|
| 1 | Who writes plugins | First-party only for now; full Worker and DB access, so installing is as trusting as merging a PR. The install plan is always shown and waits for a human |
| 2 | Fresh clone | The kit becomes bare; `defaultPlugins` in `.rocketflare.json` and a bootstrap step install a default set, so a fresh clone is unchanged (Phase C) |
| 3 | Reference plugin | `example-feature`, grown to carry a table, a route, a tool, both hooks and a CLI command |
| 4 | Record of installed plugins | A `kind: 'plugin'` surface — committed in an app, in the git-ignored sidecar in the kit or with `--local`; `readManifest()` is the one predicate |
| 5 | Compatibility | A declared `requires.kit` range PLUS proof both ways in CI — **built**: `ci.yml` installs every `defaultPlugins` entry and runs the whole gate on it, `.github/workflows/plugin-ci.yml` is the reusable workflow a plugin repository calls to do the mirror image against the oldest and newest kit in its range, and `kit:release` refuses a version its default plugins do not resolve at or admit. No separate plugin-API version: untyped imports are the real exposure and only the gate catches them |
| 6 | Cubes, fact tables, dashboards | Plugin-owned registries through `extensions: Record<string, readonly unknown[]>`; the owning plugin narrows with zod and fails loudly. Core stays ignorant of drizzle-cube |
| 7 | The extraction boundary | No compatibility path: analytics moves out under the `<id>_*` rule and the release note says its tables are dropped |
| 8 | Bundle safety | `LazyExoticComponent` for pages, plus a source-level structural test in the host |
| 9 | Public surface | Four entry files are the API; a deep import across a plugin boundary is a test failure |
| 10 | Cutting the work | Phase A is four PRs on one branch and one kit release |
| 11 | Uninstall data | Drop by default, `--archive` on request. Orphaned tables are not a stable state |
| 12 | Plugin bindings | Provisioning learns them: `provision cloudflare <env>` reads each plugin's `bindings[]`, and the parity test applies the `-staging` rule to them |
| 13 | Where a plugin comes from | Every manifest carries a required `repo` (+ optional `subdir`), so a surface's `source.repo` is never null |

Decisions 11 and 12 arrived with `scripts/plugin.mjs` and `provision/plugin-resources.ts` (below),
and 5's CI half with `.github/workflows/{gate,ci,plugin-ci}.yml` (next paragraph); 6 and 7 land with
the analytics extraction in Phase C. The rest are true today.

**Compatibility is proved from both ends, by two workflows and one refusal (decision 5).** The
gate's steps live in `.github/workflows/gate.yml` and `ci.yml` calls it TWICE — plain, and again
with every `defaultPlugins` entry installed at its pinned ref, `pnpm db:generate` run per plugin and
`db:migrate:ci` applied — because a second copy of those steps would prove nothing about the copy
nobody ran. `defaultPlugins` entries are objects (`{ id, repo, ref?, subdir? }`): a bare id says
nothing about where a plugin comes from, which is the same reason decision 13 made `repo` required.
The mirror image belongs to the plugin, but the FILE stays here —
`.github/workflows/plugin-ci.yml` is a `workflow_call` template a plugin repository invokes in three
lines, and it resolves the oldest and the newest kit release inside the plugin's own `requires.kit`
(with the kit's own `satisfies`, so the answer matches `plugin add`'s), clones each, installs the
plugin from the checkout under test and runs the gate. Both ENDS of the range rather than a
midpoint: the floor an adopter may still be on, and the ceiling the kit has just reached.
`pnpm kit:release` adds the stop at the other end — it refuses a version whose default plugins no
longer resolve at their pin or whose declared range excludes it (`--skip-plugin-check` is the loud
escape hatch) — and it is honest about its reach: a release script can prove a pin, not somebody
else's tests. The `plugins` job on the release commit is what proves those green.

**The lifecycle is `scripts/plugin.mjs` (`pnpm plugin`).** `add` mirrors a plugin repository (or
reads a local path — that is the authoring loop), checks its `requires` three ways, refuses any
file outside the plugin's own four roots, **prints the plan and stops unless `--apply`**, and on
apply copies the trees through `applyReplacements`, writes the five barrel lines, installs the
declared dependencies and appends the surface. `upgrade <id>` is the kit-upgrade pipeline pointed
at the plugin's own repository, reading ITS notes (`requires_kit`, `requires_plugins`,
`migrations`, `data_migrations`, `touches_registries`) and stamping `source` and `history[]` only
on a clean apply. `remove` deletes the trees, the lines and the surface — `--archive` first copies
each table into schema `archive`, which `rls-coverage` cannot see because every one of its catalog
queries is scoped to `public`. `list` and `check` are the audit; `export <id> <dir>` writes a
plugin back out as a repository. Exit codes: 0 · 1 error · 2 usage · 3 unreachable · 4 rejects ·
5 no manifest · 6 requirement unmet · 7 target exists.

Three rules it enforces that nothing else can. **It never copies a migration** — the host runs
`pnpm db:generate` once the schema barrel line exists. **It never edits a toml or writes a resource
id** — a declared `bindings[]`, `crons[]`, `apiPrefixes[]` or `vars[]` entry becomes one numbered
step in the plan: `pnpm provision cloudflare <env>` per environment, which reads those same
declarations off the installed surface and writes the blocks into BOTH tomls (decision 12), or, for
a var marked `secret: true`, a `.dev.vars.example` key plus `pnpm provision secrets <env>`. A
binding whose `type` is outside `kv | queue | r2` is refused at INSTALL, naming the type, rather
than surfacing as a 503 after a deploy that silently skipped it.
And **a VENDORED plugin is the kit's**: `source.repo` equal to the kit's own repository with no
subdirectory means `plugin upgrade` defers to `kit:upgrade`, and `requires.kit` is not checked at
all, because the same release cut both and the range describes the kit it shipped inside rather
than a compatibility claim. `kit:upgrade` learned the other half: it prints the installed plugins,
exits 6 when the target kit version leaves one's `requires.kit` range (`--force` to proceed), and
flags a kit change to a file in a plugin's `registries[]` as `touches-plugin-registry`.

**Known gaps / not built yet:** No third-party trust model (no sandbox, no review process, no signature —
"first-party only" is the whole of it). No rename migrations: expand/contract only, because
drizzle-kit's rename prompt has no non-interactive answer. No cross-plugin FK tooling, and no
`many()` back-reference onto a core table (the type-level finding above). The shared entry must be
imported as `@rocketflare/shared/plugins/<id>/index` — the `./*` export maps to a file, which reads
as a typo and is not one. `api-prefixes.ts` imports the server barrel, so the module that both the
SPA catch-all and the parity test read is now downstream of every installed plugin.
`CORE_FEATURES` is empty, so `FeatureName` is `never` in a bare kit and `featureNameSchema` had to
become a refined `z.string()` rather than a `z.enum`, which needs a non-empty tuple (§15).
`grants` is additive by documentation only: CASL can take a rule back with `cannot`, and nothing
stops a plugin doing so. Provisioning creates a plugin's resources but never DELETES one, so
`plugin remove` prints the toml blocks and the Cloudflare resources to remove rather than removing
them. The CI half of decision 5 is written but **has never been executed by GitHub Actions**: the
workflows parse and every shell step is syntax-checked, and with `defaultPlugins` empty the second
gate is skipped, so the install-and-gate path first runs for real when the first default plugin is
pinned (Phase C) — and `plugin-ci.yml` first runs when a plugin repository exists to call it.
`kit:release`'s refusal reads a plugin's `requires.kit` from the INSTALLED surface or not at all —
`git ls-remote` proves a ref exists but cannot read a file out of it — so a default plugin that is
not installed in the release checkout reports an unreadable range rather than being waved through.
Neither workflow proves a MIDDLE version of a range, and neither proves two plugins installed
together: the kit's job installs whatever `defaultPlugins` lists, which is the only combination
anybody has declared. Analytics has not been extracted (Phase C), so the kit is
not yet bare, and the website's plugin pages are Phase D.

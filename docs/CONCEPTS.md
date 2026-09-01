# CONCEPTS — what is built, and why

The reference for someone about to change something: what each subsystem does, the invariant it
protects, and the decision behind it (recorded as D-numbers in `docs/analysis/00-SYNTHESIS.md`).

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
| 8 | [Analytics](#8-analytics) | Phase 4 |
| 9 | [AI layer](#9-ai-layer) | Phase 3 — built |
| 10 | [Deployment](#10-deployment) | Phase 0 / 5 |
| 11 | [CLI](#11-cli) | Phase 1 |
| 12 | [Shared package](#12-shared-package) | Phase 0 |
| 13 | [Definition of done](#13-definition-of-done-for-the-kit) | |

Provenance: extracted from two internal GM applications — one supplied the structure, docs system,
auth/tenancy/AI layer; the other the Cloudflare substrate and analytics. Nine subsystem analyses
(`docs/analysis/01–09`) and the synthesis are the decision record.

**Layout (D26).** The repo is a pnpm workspace: `apps/web` (`@gmgo/web` — the Worker: Hono API +
React UI, everything in §§1–10), `apps/cli` (`@gmgo/cli`, §11) and `packages/shared` (`@gmgo/shared`,
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
`Conversation`, `AgentRun`, `Document`, plus an `access` hook over an injected `features: string[]`.

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

`*` Deleting a tenant and assigning/changing `owner` additionally require an explicit
`role === 'owner'` check — CASL conditions are not used anywhere, so don't pretend they are. A new
app subject defaults to owner/admin/support `manage`, member `read` with route-scoped writes.

**Admin area.** `/admin` (UI) and `/api/admin/*` behind `globalAdminMiddleware` is the only place
with cross-tenant queries by design, so the blast radius is one file. "Entering" a customer tenant
inserts a real `support` membership; `authMiddleware` keeps its single "must be a member" invariant.

**Isolation = predicates + inert RLS (D1).** Every query filters by `tenantId` from the auth
context; every tenant table also carries an RLS policy that is not enforced until `TENANT_SCOPE_MODE
= enforce` — see §4 and `docs/RLS.md`.

**The CLI is a tenant API key.** `gmgo login` ends with a tenant-scoped key (§11), so every CLI call
is already inside one tenant and goes through the same `authMiddleware` Bearer path and CASL
abilities as the UI; in `single` mode the tenant-select step of the login handoff is skipped.

**Known gaps / not built yet:** no audit log of admin actions beyond `activity_events`; the domain
allow-list is new code with no production history; feature-flag source for `access` is undecided
(inject `features`, keep it open); personal API keys are not in v1 (tenant keys only).

## 2. Auth

**Status: built (Phase 1).**

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
router over `ProviderDefinition`s (`apps/web/src/api/auth/providers/`), v1 = Google + Microsoft via arctic
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

**Contracts (D13, D26).** zod schemas in `packages/shared/src/` (`@gmgo/shared`, §12) are the API
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

**Status: built — jobs and realtime (Phase 2), the `AgentRunWorkflow` (Phase 3).**

**A route never runs long work; it enqueues (fire-and-forget, < 30 s total) or creates a workflow
(multi-step, retries, minutes+). Cron only dispatches.** (05 §1.4, D7)

| Need | Primitive | Kit shape |
|---|---|---|
| plain job | `JOBS_QUEUE` (one queue) — **built** | `enqueueJob(queue, input)` (`services/jobs.ts`) → `processJobsBatch(batch, { env, config, logger })` (`queues/jobs.ts`) dispatched on `type` to `queues/handlers/*`; `queue.ts` routes `batch.queue` by prefix |
| durable multi-step | `AGENT_RUN_WORKFLOW` (one class) — **built** | `AgentRunWorkflow` (`api/workflows/agent-run.ts`): `claim → execute → finish`, bodies in `services/agents/runtime.ts`; the agent runtime *is* the example workflow — no throwaway second one (§9) |
| periodic | `[triggers] crons` | `scheduled.ts` dispatch table on `event.cron`; each task try/caught; `0 4 * * *` prune, `15 * * * *` fact refresh (Phase 4) |

**Jobs (D7) — one queue, typed envelopes, poison never loops.** The contract is
`@gmgo/shared/jobs`: a discriminated union on `type` (`email.send`, `activity.record`,
`example.ping`) wrapped in an envelope `{ id, type, payload, enqueuedAt, attempt? }`. The `type`
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
'gmgo-starter-jobs'`) because queue names are account-scoped and staging's carries `-staging`; an
unknown queue is `ackAll()`ed so a stray binding can never retry forever.

What is queued today: the invitation email (create, bulk, resend) and the access-request decision
email, so those routes answer as soon as the row exists — the `email.send` payload carries the
optional `link` so the `[email:dev]` console fallback still prints the accept URL. **The magic-link
email stays inline** (a person is waiting on it; latency beats offloading). `example.ping` is the
smoke job (logs and acks — enqueue it from any route to prove the pipeline under `wrangler dev`).
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
`@gmgo/shared/realtime`: `{ type, tenantId, at, payload? }` with `type` ∈ `notification.created |
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
agent) is the partial unique index `agent_runs_active_exclusive_idx (tenant_id, agent_key) WHERE
status IN ('queued','running')` — a second enqueue returns the existing run (`deduplicated: true`).
**Concurrency has no Cloudflare primitive** — it is a DB claim row: `UPDATE agent_runs … SET running,
attempt + 1 WHERE status IN ('queued','running') RETURNING`; a retried step re-claims, a settled row
is never rewritten. The Workflow instance id is the run id (`AGENT_RUN_WORKFLOW.create({ id: runId })`
after the row exists). Never fake either in an in-memory `Map` — isolates are many and short-lived.
Cancellation is cooperative: flip `cancelRequestedAt`, the run polls between turns. There is no orphan
sweep cron: an active row is reconciled against `instance.status()` on read. Progress is durable in
`agent_run_events`; the DO only wakes viewers.

**Known gaps / not built yet:** `/api/admin` paths do not nudge — `decideAccessRequest` writes the
`access_request_decided` notification without a `Realtime`, so the approved user's bell and the
tenant's member list refresh on the next fetch, not live; `notification.read` is in the event enum
and the invalidation map but nothing emits it yet; the `activity.record` handler ships with no kit
producer (routes still `defer(recordActivity)` inline — enqueue it when an audit write is on a hot
path); the DO's 101 branch cannot run under Node (undici rejects status 101) and is proven by
`wrangler dev`, not the suite; `dead_letter_queue` is commented out in both tomls; SSE
`Last-Event-ID` replay for run progress is deferred; `@cloudflare/vitest-pool-workers` smoke project
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
['avatars', 'uploads']`, declared in `@gmgo/shared/files` and mirrored in the DB enum.

`/api/files` (`routes/files.ts`, behind `authMiddleware`, contract in `@gmgo/shared/files`):

- `POST /api/files?scope=` — multipart with one `file` field; `create File`. The route mounts its
  own transport cap (`MAX_UPLOAD_BYTES + 64 KB` for multipart overhead) and the JSON `bodyLimit`
  skips `/api/files`; the handler then enforces the exact per-file limit: empty → 400 `file_empty`,
  > 5 MB → 413 `payload_too_large`, `avatars` with a type outside `AVATAR_MIME_TYPES` (png, jpeg,
  gif, webp) → 415 `unsupported_media_type`. Object first, row second; if the insert fails the
  object is deleted (no orphans). `scope=avatars` also sets `users.avatarUrl = /api/files/<id>`.
  201 with the `fileSchema` row; `file.uploaded` activity in `defer`.
- `GET /api/files/:id` — `read File`, tenant-scoped lookup (another tenant's file is a 404),
  `Cache-Control: private, max-age=3600`, `ETag` from R2 and `If-None-Match` → 304. Only the avatar
  MIME allowlist renders `inline`; **everything else — SVG included — is `Content-Disposition:
  attachment`** so stored HTML/SVG never executes on this origin.
- `DELETE /api/files/:id` — the uploader may always delete their own file; anyone else needs
  `delete File` (admin+). Deleting the file behind your own `avatarUrl` nulls it. 204.

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

**Design tokens, not raw colours.** `apps/web/src/ui/index.css` holds two DaisyUI themes (`gm-light`,
`gm-dark`) whose brand hexes live in one header block, plus semantic surface/border/text tokens,
shape/motion tokens, a base layer (focus ring, reduced motion, tabular numerals) and component
primitives (`.surface-panel`, `.data-table`, `.status-badge`). `apps/web/tests/ui/contrast.test.ts` gates the
emitted tokens; the palette *pipeline* is documented, not shipped (D20). Tailwind v4 scanning is
opted out globally (`@import "tailwindcss" source(none)`) and re-enabled with explicit `@source`
lines scoped to `apps/web/src/ui` — auto-detection scanned the whole repo (docs, API code) and
DaisyUI emitted components for stray words; the safelist exists only for classes built from props.

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
`apps/web/tests/api/cubes/cube-isolation.test.ts` (two tenants, same query, disjoint rows) is mandatory.

**Ship set.** Cubes `Users` + `TenantUsers` (both scoping patterns), `ActivityEvents` (event stream
over the generic `activity_events` table) and `TenantActivityDaily` over one fact table
`tenant_activity_daily_facts` — grain `(tenant_id, day, user_id)`, refreshed per tenant by
DELETE+INSERT from a registry at `:15`, with a freshness check (lag vs `MAX(created_at)` on the
source). One dashboard template, `tenant-overview`; `analytics_pages` are created lazily per tenant
from templates with "reset to template". drizzle-cube React components; **recharts only**.

**Frozen measure names.** Stored dashboards reference `Cube.measure` strings in JSONB. Renaming a
measure silently breaks every saved dashboard — `apps/web/tests/dashboards/all-templates.test.ts` checks
templates structurally, and reset-to-template is the user-facing repair.

**Known gaps / not built yet:** cube access is authentication + tenant scope only (no per-cube CASL
gate); per-request compiler cost is fine for a kit (cube sets are the scaling path); drizzle-cube's
cache is per-isolate (a KV provider would be an extension); `rlsSetup` unused; reporting/export,
AI dashboard generation, benchmarks deferred.

## 9. AI layer

**Status: built (Phase 3).** Server: `apps/web/src/api/services/{ai/*,agents/**,prompts.ts}`,
`api/workflows/agent-run.ts`, `api/observability/*`, `api/middleware/tracing.ts`, seven routers under
`/api/ai/*`, `/api/chat`, `/api/agents`. Contracts: `packages/shared/src/ai/*`. UI: `pages/chat`,
`pages/settings/{AI,Prompts,Usage}`, `components/ai/`, `lib/{sse,chatStream}.ts` — specifics in
`apps/web/src/ui/CLAUDE.md`.

**Three tiers, one resolver (D17).** `resolveChat(db, cfg, env, tenantId, { promptKey? })` and
`resolveEmbeddings(...)` in `services/ai/resolve.ts` are the ONLY readers of `ai_configs` /
`agent_models` and the only place a credential is decrypted. Chat order: an `agent_models(tenantId,
promptKey)` assignment (a chat config id and/or a model override → `source: 'agent'`) → the tenant's
default `ai_configs(scope='chat')` row (`'tenant'`) → platform `ANTHROPIC_API_KEY` with
`DEFAULT_MODELS.anthropic` (`'platform'`) → 503 `ai_not_configured` (`AiNotConfiguredError`).
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

**Providers v1** (`AI_PROVIDERS` in `@gmgo/shared/ai/config`, append-only; `services/ai/providers.ts`
is the data catalog and its `scopes` is the "an adapter exists" gate): `anthropic` (chat,
`@anthropic-ai/sdk`), `anthropic_compatible` (chat; Anthropic wire format behind `Authorization:
Bearer` = the SDK's `authToken`, base URL required; Fireworks and Moonshot are `PROVIDER_PRESETS`
data, not enum values), `openai` and `openai_compatible` (chat **and** embeddings; a small fetch
client for `/chat/completions` SSE and `/embeddings`, base URLs include `/v1`), `workers_ai`
(embeddings only, `env.AI.run`). Per-tenant request defaults are injected where the client is built,
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

**Prompts.** `PROMPT_REGISTRY` in `services/prompts.ts` (`chat`, `summarize-text`) is code; a tenant
override is a `prompt_overrides(tenant_id, key)` row — revert = delete, `PROMPT_MAX_LENGTH` = 20 000;
`{{var}}` placeholders are filled by `interpolatePrompt` (an unknown one stays visible so a typo
shows). `GET /api/ai/prompts` (member read), `PUT | DELETE /:key` (`manage Prompt`). A new prompt is
one registry entry, no migration; `agent_models` keys on the same registry.

**Chat.** `conversations` / `messages`; ownership is the `userId` filter on every query, so another
member's thread — an admin's too — is a 404. `POST /api/chat/conversations` resolves the client first
(the 503 arrives before any row exists) and freezes `provider`/`model` on the row.
`POST /conversations/:id/messages` does everything that can fail as JSON **before** `streamSSE`
(resolve, prompt, the last 40 turns, the user-message insert), then streams `event: <type>` +
`data: <ChatStreamEvent JSON>` frames: `message.start → text.delta* → usage → message.end`
(`tool.start` / `tool.end` between when an app adds tools), or a terminal `error { message, code }`.
Inside the stream, all awaited and on a **second DB client** (`streamDatabase(c)` — the request's
client is closed in `waitUntil` the moment the Response is returned, before the stream body runs):
persist the assistant message, bump `lastMessageAt`, auto-title from the first user turn (60 chars),
`recordUsage(feature: 'chat')`, flush the tracer. Zero default tools. UI: `fetch`, not `EventSource`
(`lib/sse.ts`, `lib/chatStream.ts`); Stop = abort, no toast; the streaming text is local state
written to the query cache on `message.end`; `react-markdown` + `remark-gfm` live in
`components/ai/` outside the shared barrel so they ship only in the lazy chat chunk.

**Agents (D7).** `AGENTS` (`services/agents/registry.ts`) maps each `AgentKey` to the shared
`AgentMeta` (`@gmgo/shared/ai/agents`: key, `inputSchema`/`outputSchema`, `promptKey`, `exclusive`)
plus a server-side `run(ctx)`. `POST /api/agents/runs` is the handoff — routes enqueue, never run:
`enqueueRun` validates against the agent's `inputSchema`, inserts `agent_runs` `queued`, creates the
Workflow instance with **id = run id**, and answers 202 with the row. The partial unique index
`agent_runs_active_exclusive_idx (tenant_id, agent_key) WHERE status IN ('queued','running')` IS
the exclusive guarantee (every v1 agent is exclusive): a second request gets the existing run back
with `deduplicated: true` (409 `agent_run_active` only with `?strict=1`). No binding → 503
`agent_runs_not_configured` before any write. `AgentRunWorkflow` (`api/workflows/agent-run.ts`) is
three steps — `claim` → `execute` (`retries: 2`, exponential from 10 s, `timeout: '10 minutes'`) →
`finish` — whose bodies are plain functions (`claimStep`, `executeRun`, `finishStep` in
`services/agents/runtime.ts`), each step opening and closing its own DB client. **The claim is the
row**: `UPDATE … SET running, attempt + 1 WHERE status IN (queued, running) RETURNING`; every terminal
write carries the same predicate, so a settled row is never rewritten and a retried step re-claims.
`executeRun` resolves the client for `meta.promptKey` (the per-agent model applies), wraps it in
`withAgentTrace` + `traceChatClient`, builds the `AgentContext` (`emit`, `checkCancelled`, `chat`,
`prompt(vars)`, `step(...)`), runs the agent, validates `outputSchema`, `finishRun`. Errors are
classified: `AgentCancelledError` → `cancelled`; `AiError` `unavailable`/`rate_limit` or a DB outage
rethrow for a step retry while `attempt <= 2`; anything else → `failed` at once. Cancellation is
cooperative: `POST /runs/:id/cancel` settles a queued row outright, sets `cancelRequestedAt` on a
running one, and `ctx.checkCancelled()` polls it between turns. Reads reconcile: `GET /runs/:id`
calls `instance.status()` for an active row and settles it when the runtime says `not_found |
errored | terminated | complete` — **`not_found` is an answer**, not an error. Progress is
`agent_run_events (run_id, seq)` (`step | tool.start | tool.end | text | status | error`) plus an
`entity.changed { entity: 'agent-run', id }` nudge — DB is the truth, WS is a nudge. Members list and
cancel their own runs; admin+ every run in the tenant. The tool loop runs inside ONE `execute` step in
v1; one `step.do` per model turn with the transcript persisted between them (`runToolLoop` already
returns `messages`) is the scaling path. The example, `summarize-text`: precheck (≤ 20 000 chars),
one terminal tool `submit_summary` through `callStructuredTool`, usage under
`agent:summarize-text`, and with `index: true` the summary is stored through `ingestText`.

**Embeddings and retrieval (D18).** `documents` (raw `content` kept for re-index, never returned by
the API) and `chunks` (`embedding vector(1024)` — `EMBEDDING_DIM` in `@gmgo/shared/ai/config`; HNSW
`vector_cosine_ops`). `ingestText` (`services/ai/ingest.ts`) is the one way in
(`POST /api/ai/documents/ingest`, ≤ 500 000 chars): resolve embeddings first (no provider → 503, no
orphan row), insert `pending`, chunk paragraph-aware (~800 tokens, 100 overlap, 4 chars per token
estimate), then index inline when ≤ 50 chunks, else enqueue `document.index`, which runs the same
`indexDocument` from the stored text (a missing `JOBS_QUEUE` throws, never a silent inline fallback).
`searchChunks` (`POST /search`) is hybrid: dense `<=>` over the HNSW index plus lexical
`websearch_to_tsquery` / `ts_rank_cd` over `to_tsvector('english', text)`, each contributing a pool
of `min(max(limit·4, 50), 200)`, fused by Reciprocal Rank Fusion (`k = 60`); every hit carries
`denseRank` / `lexicalRank`. Vectors are pgvector rows under the tenant predicate and RLS, not
Vectorize; `apps/web/scripts/migrate.ts` runs `CREATE EXTENSION IF NOT EXISTS vector` before the
migrations.

**Usage (D18).** `recordUsage` writes one `ai_usage` row per model call (`feature`, `provider`,
`model`, four token counters, `costMicrocents` **null** — the kit counts tokens, an app prices them):
the chat route after the stream (`feature: 'chat'`), agents from `callStructuredTool`'s `onUsage`
(`agent:<key>`). `GET /api/ai/usage/summary?from&to` (default last 30 days, `manage AiConfig`) groups
by (provider, model, feature) with grand totals.

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

**Known gaps / not built yet:** `enqueueRun` does NOT pre-resolve the chat client — a tenant with no
provider gets a 202 and a `failed` row at `execute` (chat's `POST /conversations` does pre-resolve);
the connection test spends tokens but writes no `ai_usage` row; `GET /api/ai/config/providers` has
no shared schema (the UI keeps a permissive `passthrough` one in `hooks/useAiConfig.ts`);
`ai_configs.label` is the upsert key, so a rename is delete + re-add; `/settings` is admin-guarded,
so members hold `read AiConfig` / `read Prompt` with no nav path to the read-only views; the agents
(`/agents`), documents (`/documents`) and Settings → Agent models pages are documented in
`apps/web/src/ui/CLAUDE.md` (they consume the contracts above; nothing in this section depends on
them); no rerank (a `RerankFn` seam is the documented extension) and no
generated `tsvector` + GIN — the lexical half computes `to_tsvector` at query time; no non-exclusive
agents (relax the partial unique index); the tool loop is one step, not one per turn; no budgets or
quotas over `ai_usage` and no price table; prompt versioning, an evals harness, Bedrock/Azure/Gemini
adapters, SSE `Last-Event-ID` replay for run progress and an orphan-run cron (reconcile-on-read
replaced it) are deferred.

## 10. Deployment

**Status: tomls, CI, deploy workflow and scripts built (Phase 0); first real deploy in Phase 5.**

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
(`pnpm --filter @gmgo/web exec wrangler …`). The CLI is built as a compile check and distributed via
the repo — publishing it is an app decision; the package is private by default. Full reference:
`docs/DEPLOY.md`.

**Known gaps / not built yet:** a root `release` script (bump-commit-tag helper) is optional and not
shipped; no per-PR previews; a CI check that every `apps/web/src/**/CLAUDE.md` exists and every
`docs/*.md` is linked is proposed, not implemented; no CLI publishing pipeline.

## 11. CLI

**Status: built (Phase 1).** Package `apps/cli` (`@gmgo/cli`), bin `gmgo`. Dev: `pnpm cli
<command>` from the root (`tsx`); build: `tsc` → `apps/cli/dist/cli.js`. Stack: `commander` +
`chalk` + `open` (D26). Conventions: `.claude/rules/cli.md`.

**Every GM app wants a CLI, and it must never own a second copy of the contract.** The CLI is a
thin client over the same `/api/*` routes the UI uses, authenticated with a tenant API key, parsing
every response with the same `@gmgo/shared` zod schema the server validated with. Adding a command
is: schema in `packages/shared` (if new) → route → `apps/cli/src/commands/<name>.ts` calling
`apps/cli/src/api.ts` (the only `fetch` site: adds `Authorization: Bearer`, parses the envelope,
maps status → exit code).

**Login handoff.** `gmgo login [--server <url>]` starts a loopback HTTP listener on the first free
port in `127.0.0.1:8765–8770`, opens the browser at
`<server>/auth/cli?redirect_uri=http://127.0.0.1:<port>/callback&hostname=<machine>`, and waits
(5 min timeout). The server side (§2) authenticates the user, asks for a tenant (skipped in `single`
mode), mints a tenant API key `cli:<hostname>` and redirects with `?key=&tenant_id=&tenant_name=`.
The listener answers a self-closing page, verifies the key with `GET /api/me`, stores it, shuts down.
`logout` deletes the local key; revoke it server-side in Settings → API keys (or `keys list` to find it).

**Config.** `~/.gmgo/config.json` — directory `0700`, file `0600`, re-tightened on every write —
holding the server URL, API key, active tenant and signed-in user. `GMGO_CONFIG_DIR` relocates the
directory (tests use a temp dir). **Env overrides win**: `GMGO_API_KEY` and `GMGO_URL` make the CLI
usable in CI with no browser and no file; `GMGO_DEBUG` turns on debug lines. `gmgo config` prints the
effective config with the key masked (prefix only) — no command ever prints a full key.

**Commands (Phase 1).** `login`, `logout`, `whoami` (`GET /api/me` + `GET /api/tenant` → user,
tenant, key prefix), `status` (`GET /api/health`, unauthenticated → reachability, environment,
release version), `members list`, `keys list`, `activity list` (`--page`, `--page-size`;
`paginationQuerySchema` in, `{ items, pagination }` out), `config`. `--server <url>` and `--json`
are global: with `--json` a command prints only the parsed response, so output pipes into `jq`.
Human output is `chalk` tables on stdout; diagnostics go to stderr.

**Exit codes (D26).** `0` ok · `1` error (API non-2xx other than 401/403, network, bad options,
unexpected) · `2` not logged in (no key, or 401 — hint: run `gmgo login`) · `3` forbidden (403).
Commands throw `CliError`; `cli.ts` catches once, prints once and sets `process.exitCode`, so tests
run commands in-process with an injected `fetch`.

**Known gaps / not built yet:** no device-code flow for headless machines (use `GMGO_API_KEY`); no
multi-profile config (one server + tenant at a time; `login` again to switch); `logout` does not
revoke the key server-side; no shell completion; no publishing pipeline — the package is private and
runs from the repo.

## 12. Shared package

**Status: built (Phase 0).** `packages/shared` (`@gmgo/shared`), **private** (`"private": true`, no
`publishConfig` — never publish it).

**One contract, three consumers, zero build.** The zod schemas, inferred types, error envelope
(`errors.ts`), pagination (`pagination.ts`), permission vocabulary (`permissions.ts`: actions,
subjects, `AppAbility`, packed rules) and the AI contracts (`ai/*.ts` — config, prompts, chat + the
SSE frame union, agents, agent-models, embeddings, usage; barrel `ai/index.ts`, deep imports
`@gmgo/shared/ai/<file>`) live in `packages/shared/src/` and are consumed as
TypeScript source through the workspace link: `package.json` `exports` map `@gmgo/shared` →
`./src/index.ts` and `@gmgo/shared/*` → `./src/*.ts`, so `apps/web` (API and UI), `apps/cli` and
their tests import `@gmgo/shared/<module>` and Vite / wrangler / tsx / vitest all resolve the `.ts`
directly. There is no `dist`, nothing to rebuild after an edit, and typecheck is one `tsc` per
package extending `tsconfig.base.json`.

**Contracts first (D13).** A new or changed API surface *starts* here: `<thing>Schema` for a
response/entity, `<thing>RequestSchema` for a body, `<thing>QuerySchema` for query params, `type
<Thing> = z.infer<…>` next to each; re-exported from `index.ts`. Then the route `validate()`s with
it, the UI parses with it (`api.get(..., { schema })`), the CLI parses with it (`api.ts`). jsonb
column types in the DB schema also come from here (`$type<>()`).

**Dependency rule.** `packages/shared` imports `zod`, its own siblings and type-only `@casl/ability`
— **never** `apps/web` (it must bundle for the browser and load in the CLI) and never `apps/cli`.
`apps/cli` in turn never imports `apps/web`. Biome and each package's `tsconfig` `include` keep the
direction honest; a violation shows up as a browser bundle pulling in `postgres` or `hono`.

**Known gaps / not built yet:** shared has no test suite of its own (its `test` script is a no-op) —
its contracts are exercised by the `apps/web` and `apps/cli` tests; no OpenAPI emitted from the
schemas; no runtime-versioning of contracts between a deployed web and an older CLI (both ship from
one tag).

## 13. Definition of done for the kit

A fresh agent can copy the repository, follow `docs/ADAPTING.md` → `SETUP.md` Part 1 with zero
external credentials and log in via a logged magic link; `pnpm cli login` against the local server
and `pnpm cli whoami` with the minted key; invite a member, switch tenant, approve an access request;
run the same flow with `TENANCY_MODE=single`; watch the People page refresh live from a second
browser when an invitation is accepted and see the invitation email queued through `JOBS_QUEUE` and
delivered (or logged) by the consumer under `wrangler dev`; upload an avatar and fetch it back at
`/api/files/:id`; add an AI provider in Settings → AI (or set `ANTHROPIC_API_KEY`), pass the connection
test, hold a streamed chat whose turns and usage rows persist; start the `summarize-text` agent from
`POST /api/agents/runs`, watch its `agent_run_events` arrive through the nudge, cancel one, and see its
trace when Langfuse keys are set; ingest a text and get it back from the hybrid search; render the
`tenant-overview` dashboard with live numbers (planned, Phase 4); and,
following `SETUP.md` Part 3, deploy to a new Cloudflare account changing only placeholders and
secrets — with root `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green at every step and
every behaviour described here still true.

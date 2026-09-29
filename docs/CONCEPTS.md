# CONCEPTS — what is built, and why

One section per subsystem: what it does, the invariant it protects, the decision behind it
(D-numbers), and its **Known gaps**. Check here before assuming a capability exists; update it when
you change one. **Keep it short** — a section states the rule and points at where the detail lives.
Conventions and mechanics belong in `.claude/rules/*.md` and the per-directory `CLAUDE.md` files;
setup in `SETUP.md`; Cloudflare topology in `docs/DEPLOY.md`; RLS in `docs/RLS.md`.

| § | Section | § | Section |
|---|---|---|---|
| 1 | [Tenancy](#1-tenancy) | 9 | [AI layer](#9-ai-layer) |
| 2 | [Auth](#2-auth) | 10 | [Deployment](#10-deployment) |
| 3 | [API shell](#3-api-shell) | 11 | [CLI](#11-cli) |
| 4 | [Database](#4-database) | 12 | [Shared package](#12-shared-package) |
| 5 | [Background work and realtime](#5-background-work-and-realtime) | 13 | [Upgrading a copy](#13-upgrading-a-copy) |
| 6 | [Email and storage](#6-email-and-storage) | 14 | [Definition of done](#14-definition-of-done-for-the-kit) |
| 7 | [UI shell](#7-ui-shell) | 15 | [Feature flags](#15-feature-flags) |
| 8 | [Analytics](#8-analytics) | 16 | [Plugins](#16-plugins) |
|  |  | 17 | [Connectors](#17-connectors) |

**Layout (D26).** A pnpm workspace: `apps/web` (the Worker — Hono API + React UI, §§1–10),
`apps/cli` (§11), `packages/shared` (zod contracts, §12), and `apps/evals` (developer-run eval
suites on vitest 4, §9 — never part of the gate).

---

## 1. Tenancy

**Every row of domain data belongs to a tenant, and the schema is the same for one tenant or many.**

- **`TENANCY_MODE = multi | single` (D25)** is configuration, not a fork. `multi`: users join many
  tenants via `tenant_users`, the session carries the current one. `single`: one tenant, every
  admitted user auto-joins as `member`; multi-only surface is 404 `tenancy_mode_single`
  (`requireMultiTenant`) and hidden via `useTenancyMode()`. Switching to `multi` needs no migration.
- **`SIGNUP_MODE = open | invite_only | approval` (D9)**, default `invite_only`. Uninvited logins
  land on `/pending`; `approval` also files an `access_requests` row at *verify* time;
  `open` gives a personal tenant through `onNoTenant`. Invitations are handled first on every login
  path, and every fallback gates on "has no memberships", not "is new".
- **Roles (D10).** `owner | admin | member` plus `support` (minted from `/admin`, visible to the
  customer); `users.isGlobalAdmin` is a platform flag. Default for a new subject: owner/admin/support
  `manage`, member `read` with route-scoped writes. "Own row" is always a route predicate — **CASL
  conditions are used nowhere**. Deleting a tenant and changing `owner` need an explicit
  `role === 'owner'` check. The matrix lives in `apps/web/src/permissions/` (+ its `CLAUDE.md`).
- **Admin area.** `/admin` + `/api/admin/*` behind `globalAdminMiddleware` is the only cross-tenant
  surface. A global admin with no membership can still reach it, so there is always someone to
  approve the first request. Entering a tenant creates a real `support` membership.
- **Deleting a tenant has two halves.** The `tenantRef()` FK cascade removes everything in
  Postgres; the **`tenant.purge`** job (§5) removes the R2 prefix and runs each plugin's
  `onTenantDeleted`. The queue binding is checked *before* the `DELETE`.
- **Groups and visibility (D29).** Tenants declare group types → groups → members;
  `AuthContext.groups` is resolved with the membership (a Bearer key uses its **creator's** groups, looked up on
  every request). A restrictable resource has an explicit `visibility` column (`tenant | groups`)
  plus a junction table. **The column decides and the rows only grant**, so an empty grant list
  means "owner and admins only". It never falls back to "public". The predicate is SQL in
  `services/access.ts` (`accessScopeOf` → `visibleDocuments` / plugin predicates), **ANDed with the
  tenant predicate, never substituted for it**. Admin-level roles bypass it. Groups grant READ only.
  Deleting a group that still grants something is 409 `group_in_use` (`?force=1` narrows).
  `access.changed` nudges the affected users.
- **Isolation = predicates + inert RLS (D1)** — §4, `docs/RLS.md`.

**Known gaps:** no IdP group sync (SCIM/SAML claims); no group hierarchy or per-group roles;
conversations, runs, prompts and non-Knowledge files have no visibility; agent-written documents
are always `tenant`; no audit log beyond `activity_events`; no personal API keys (tenant keys only).

## 2. Auth

- **Sessions are rows**: `user_sessions`, 30-day sliding TTL (`SESSION_TTL_MS`), cookie `__Host-session` (`HttpOnly`,
  `SameSite=Lax`, `Secure` outside development). `authMiddleware` resolves session → user →
  membership → groups → features in one query. The second strategy is a Bearer tenant API key
  (hashed, expiry, soft revoke).
- **Magic link** is the zero-credential path: a 256-bit, 15-minute, single-use, SHA-256-hashed
  token. With no `RESEND_API_KEY` the URL is logged. Opening the link consumes nothing: `GET /verify`
  redirects to `/magic-link/confirm`, and only its "Sign in" button (`POST /verify`) spends the
  token, so mail security scanners that fetch every link on delivery (Defender Safe Links,
  Mimecast) cannot. Dev-login exists and 404s in production.
- **OAuth is a registry** (D11): one generic `/auth/:provider` router over `ProviderDefinition`s
  (Google, Microsoft via arctic). Redirect URIs come from `APP_URL`, accounts link by verified email,
  and tokens are AES-GCM encrypted under `OAUTH_ENCRYPTION_KEY`. The return path is `?returnUrl=`
  (`?redirectTo=` still accepted); the flow cookie carries state, PKCE verifier and a nonce.
- **Any OIDC issuer** (`providers/oidc.ts`): set `OIDC_ISSUER` + `OIDC_CLIENT_ID` (+ optional
  `OIDC_CLIENT_SECRET`) and an `oidc` provider appears, labelled `OIDC_LABEL`. Endpoints come from
  discovery (cached per isolate, refused unless its `issuer` matches exactly); code + PKCE S256 +
  `nonce`; the `id_token` is verified with jose against the issuer's JWKS (`iss`, `aud`, `exp`,
  `nonce`; an unknown `kid` refetches the set — rotation). The identity key is `${iss}|${sub}` in
  `oauth_providers.provider_user_id`, so no migration; a changed issuer falls back to
  verified-email linking. The issuer must assert `email_verified: true`: a missing flag is
  unverified (refused as `email_unverified` — no email linking, no admission) unless
  `OIDC_TRUST_EMAIL=true` opts in an issuer that controls the claim (single-tenant Entra); an
  explicit `false` is always refused. `AUTH_OIDC_ONLY=true` sends the login page straight to the issuer and
  refuses `/auth/google|microsoft` — it **hides** magic link, it does not disable it (invitations
  still use it). With an `end_session_endpoint`, `POST /auth/logout` answers
  `200 { endSessionUrl }` (RP-initiated logout back to `/login?signedOut=1`, which never
  auto-redirects); otherwise 204. Setup: `SETUP.md` → "Sign in with any OIDC issuer".
- **Hardening (D12)**: random tokens hashed with SHA-256, a required encryption key, CSRF by origin
  allow-list (Bearer is exempt), and a KV sliding-window rate limit on login routes that no-ops
  without `RATE_LIMIT_KV`.
- **CLI handoff (D26)**: `GET /auth/cli?redirect_uri=http://127.0.0.1:<port>/callback` only allows
  loopback redirects. It mints a revocable tenant key `cli:<hostname>` and 302s back with it.
  Details: `.claude/rules/api.md`.

**Known gaps:** no provider token refresh; the rate limit is approximate; no session management UI
beyond "log out everywhere"; CLI keys differ from other keys only by name. OIDC: one issuer per
deployment; the `groups` claim is read into the profile but **not stored or mapped** to kit groups
or roles; no `id_token_hint` on logout (id_tokens are not kept, so the issuer may ask to confirm);
no back-channel or front-channel logout; `OIDC_TRUST_EMAIL=true` trusts every email the issuer
sends (no per-domain rule) — set it only for an issuer that controls the `email` claim; the client secret
is sent as `client_secret_basic` only (no `private_key_jwt`).

## 3. API shell

- **One Worker, one app** (D5): `src/worker.ts` exports `{ fetch, queue, scheduled }` plus the
  DO/Workflow classes; `api/index.ts` exports `app` so tests call `app.request(req, env, ctx)`.
- **Config (D3/D4)**: `loadConfig(env)` validates `Cloudflare.Env` with zod once per isolate.
  Routes read `c.get('config')`. `APP_ENV` replaces `NODE_ENV`, and `process.env` is banned in `src/`.
- **Middleware order is deliberate** (error envelope → logger → config → security headers → body
  limit → CORS → CSRF → DB → tracing → mounts). Auth is per mount. The ASSETS catch-all 404s every
  API prefix, so a missing route never returns `index.html`. Order and exceptions:
  `.claude/rules/api.md`.
- **Contracts (D13)**: zod schemas from `@rocketflare/shared` are used by the server, UI and CLI.
  There is no `hono/client` RPC. Errors are `{ error, statusCode, code?, details? }` everywhere,
  and success bodies are bare.
- **Routes are thin** and never run long work (§5).
- **Local dev ports**: Vite :3000 proxies to `wrangler dev` :3001, both `strictPort`, unless
  `DEV_UI_PORT` / `DEV_API_PORT` are set (shell, then `.dev.vars`; `scripts/lib/dev-ports.mjs` is the
  one reader). `APP_URL` follows the UI port by hand — the Worker cannot read the shell — and
  outside production CORS/CSRF also allow the loopback twin of `APP_URL` and of the request's own
  loopback origin. `SETUP.md` 1.6.

**Known gaps:** `pnpm dev:tunnel` always targets :3000 (cfld reads `package.json`); `pnpm dev:api`
alone reads `DEV_API_PORT` from the shell only, not `.dev.vars`; no `/api/ready` smoke step against a preview; no OpenAPI (`@hono/zod-openapi` is the
path); no per-PR previews.

## 4. Database

- **Two drivers, one client per request (D35, replacing D2's "postgres.js only")**:
  `DATABASE_DRIVER` picks Drizzle over the Neon serverless driver (`neon`: neon-http per query, a
  WebSocket `Pool` opened for `db.transaction`) or over `postgres.js` (`postgres`, through
  Hyperdrive — any Postgres). A missing var means `postgres`; the kit's tomls say `neon`;
  `.dev.vars` says `postgres`, so local work and the gate never need the deployed driver.
  `openDatabase(env)` (`db/client.ts`) is the one resolver — URL `PREVIEW_DATABASE_URL ??
  DATABASE_URL` under `neon`, `?? HYPERDRIVE.connectionString ??` in between under `postgres` — and
  the client is built per request / consumer message / step / cron run and closed in `waitUntil` or
  `finally`. No LISTEN/NOTIFY, advisory lock or PREPARE on the request path under either.
  Why two: Hyperdrive caps an account at 25 configs (a fleet of apps cannot each have one) and
  sandboxes have no TCP out, but Hyperdrive is also how a copy reaches a Postgres that is not Neon.
  Detail and the switch: `docs/DEPLOY.md` § Database driver, `docs/NEON-DRIVER.md`.
- **Code never sees the driver.** `Database` is drizzle's `PgDatabase` base, so a raw
  `db.execute()` is `unknown`: its rows are read with `rows()` and an unreturned write's count with
  `affected()`, because postgres.js returns an array with `.count` and Neon `{ rows, rowCount }`.
  `tests/config/driver-results.test.ts` fails a cast, an index or a `.rows`/`.count` read on a raw
  result, and a driver import, anywhere in `src/` (installed plugins included). Raw SQL returning a
  list uses `json_agg` / `to_jsonb` — postgres.js leaves a raw array as `"{a,b}"`.
- **Tested both ways.** The gate runs `postgres`; the `driver` vitest project (the code that
  differs) runs there too, and CI's `test-neon` job runs it plus the whole api suite under `neon`
  through a local Neon proxy (`pnpm test:neon`, ~30 s). Locally `pnpm dev:db:up --neon` runs the
  deployed driver on the local database.
- **Ephemeral test database** (`pnpm test:ephemeral`): the whole gate's tests where there is no
  Docker and only 443 out — a coding sandbox, whose orchestrator (Launch) creates a throwaway Neon
  branch per gate attempt and passes its owner connection string. The script sets
  `TEST_DATABASE_EPHEMERAL=1`, `DATABASE_DRIVER=neon`, an empty `APP_DATABASE_URL` (the app role
  stays NOLOGIN) and runs every web project. `safetyCheck()` (`tests/helpers/db-safety.ts`) still
  refuses any non-local `DATABASE_URL` unless ALL hold: that profile, the `neon` driver, a
  `*.neon.tech` host, `TEST_DATABASE_BRANCH` matching `^gate-[a-z0-9]+-\d+$`, and
  `TEST_DATABASE_ENDPOINT` equal to the `ep-…` id in the URL. The branch name is not in a Neon
  connection string, so the name alone is only a claim; the endpoint id is, and binds the claim to
  that URL (a stale opt-in in a shell cannot bless another database). The profile runs 2 forks
  (`TEST_MAX_WORKERS` overrides; a small Neon compute allows ~100 connections, the local sizing
  assumes 300), a 60 s test and 120 s hook limit (real round trips, a cold-starting compute), and
  skips `db-roles.test.ts` (postgres.js over TCP, and a superuser to make owner roles). Global setup
  is unchanged: role → migrate → grants → truncate → seed, as the connecting role. `migrate.ts`,
  `db-roles.ts` and `seed.ts` `process.exit` when done, as `db:check` does: Cloudflare's container
  egress interceptor never ends a closed database WebSocket's stream, so Node would never exit.
- **Conventions**: one file per table, `tenantRef()` + `timestamps()` (`timestamptz`), append-only
  enums, `vector(1024)` (a new dimension means a new table). `migrate.ts` creates the `vector`
  extension first. Detail: `.claude/rules/database.md`.
- **Local port is chosen** (`scripts/dev-db.mjs`): each checkout gets its own compose project and
  port, written back to `DATABASE_URL`, so two copies never share a database.
- **Or an existing database** (`pnpm bootstrap --db-url <url>`): for a machine with no Docker (a
  coding sandbox on a Neon branch). The URL goes into `DATABASE_URL` and nothing is started; a
  `*.neon.tech` URL also sets `DATABASE_DRIVER=neon` there (HTTPS + WebSocket only, which is what a
  sandbox allows; `--driver` overrides). An
  off-box `DATABASE_URL` (not loopback) is left alone by `dev-db.mjs` and skips preflight's Docker
  checks. The seed runs there with `SEED_ALLOW_REMOTE=1`.
- **Migrations**: `db:generate` → read the SQL → `db:migrate` (role → migrations → grants).
  Migrations are forward-only.
- **Cross-tenant allow-list**: `tests/config/unscoped-allowlist.test.ts` fails a function that
  queries a `tenant_id` table without naming a tenant. Each exception carries a reason. It does
  not prove `admin.ts` is the only cross-tenant surface.
- **RLS** ships inert: every tenant table has `tenantIsolation()` (enforced by `rls-coverage`),
  and `TENANT_SCOPE_MODE=enforce` waits on the spike in `docs/RLS.md`.

**Known gaps:** the RLS spike has not been run; no read replicas; the local Neon proxy is a
community image, mirrored to `ghcr.io/rocketflare-dev` and rebuilt with our start script (pinned by digest) — Neon's official "Neon Local"
needs a cloud account; `neon` in deployment has no read cache and pays a round trip per query
(p95 is measured per app when it switches, not gated); `test-neon` installs no plugins, so a
plugin's own tests run under `neon` only in a local `pnpm test:neon`; the TEST database is pinned to
5433, so two checkouts cannot run `pnpm test` at once (each app has its own Compose project,
`<slug>-test`, so switching checkouts no longer recreates the other's container). `--db-url` with a loopback URL (a native
Postgres) still looks like this checkout's Docker database to preflight and `dev:db:*`, and a
re-run of the bootstrap without the flag checks for Docker again. `pnpm test:ephemeral` is proven
in the kit only through the local Neon proxy: against a real Neon branch, the owner role's
`ALTER ROLE`s on an app role someone else created, the connection count and the time limits are
the caller's to prove.

## 5. Background work and realtime

**A route never runs long work (D7).** Anything under 30 s total goes to `JOBS_QUEUE`, multi-step
work goes to `AGENT_RUN_WORKFLOW`, and cron only dispatches.

- **Jobs**: one queue, envelope `{ id, type, payload, enqueuedAt }`, variants are DATA
  (`CORE_JOB_VARIANTS` + plugin `jobs`). A mapped handler table proves completeness, so there is no
  switch. `type` is the version seam (`x.v2`). An invalid envelope is acked; a handler error retries
  with backoff up to `max_retries`. A missing binding throws. Consumers await everything and never
  use `waitUntil`. Queued today: `tenant.purge`, invitation and access-decision emails,
  `document.index`/`document.convert`, `chat.compact`. The magic link stays inline.
  Detail: `.claude/rules/api.md`.
- **Workflow**: `AgentRunWorkflow` (§9). **Concurrency is a DB claim row, never a `Map`**:
  `ACTIVE_RUN_STATUSES` (exclusive index, includes parked runs) ⊃ `CLAIMABLE_RUN_STATUSES`
  (the claim). Keep those two lists separate. A lost instance is settled on read, and there is no
  sweeper cron.
- **Cron**: `scheduled.ts` looks up the task by expression. `0 4 * * *` prunes; plugins add their
  own tasks, and each expression must appear in both tomls.
- **Realtime (D8)**: `NotificationsHub` DO, one per tenant, stateless, using the hibernation API
  with RPC publish. `GET /ws` resolves the cookie itself. **"DB is the truth, WebSocket is a
  nudge"**: events carry ids, and the UI invalidates the query-key roots from
  `REALTIME_INVALIDATIONS`. The `entity` of `entity.changed` IS the query-key root. All nudges go
  through `services/realtime.ts` inside `defer`, after commit.

**Known gaps:** `/api/admin` paths do not nudge; `notification.read` is never emitted;
`activity.record` has no producer; the DO 101 upgrade is untestable under Node; no dead-letter
queue; no vitest-pool-workers smoke project.

## 6. Email and storage

- **Email**: Resend over `fetch`, `sendEmail(...)`, neutral templates. With no key, messages are
  logged (`[email:dev]`), never errors. The magic link is sent inline; other email is `email.send`
  jobs.
- **Storage (D23)**: the `StorageService` seam over the `FILES` R2 binding. Keys are
  `tenants/<tenantId>/<scope>/<uuid>-<name>`. Bytes stream through the Worker (no presigned
  URLs). The `files` table is the immutable index and the only thing the browser can name. Writes
  go object first, then row, and a failed insert deletes the object.
- **`/api/files`**: upload with per-scope type/size checks (413/415); tenant-scoped read (another
  tenant's file is 404) with ETag/304; **only allowlisted types render inline, everything else is
  an attachment**. Uploaders can delete their own files, admins any. A document-owned file is 409
  `owned_by_document`.
- **Framing is opt-in per response**: only a route that proved the type (`isEmbeddableMimeType`, PDF)
  sets `embeddable`, which relaxes `DENY` to `SAMEORIGIN` for that one response. It is set before
  the 304 early return. Never use a path allowlist for this.
- A missing `FILES` binding is 503 `storage_not_configured`. `tenant.purge` pages through the
  tenant prefix and is idempotent.

**Known gaps:** `avatarUrl` is global but the object is tenant-scoped (initials fallback elsewhere);
re-uploads leave the old object; no listing endpoint, quotas or presigned URLs; unbranded templates.

## 7. UI shell

- **Design tokens (D20)**: two DaisyUI themes in `ui/index.css`, where the brand hexes are the only
  hex values; `contrast.test.ts` gates them. Tailwind scanning is `source(none)` + explicit
  `@source` lines. A plugin's pages get the `../plugins/**/ui/**` line, and precompiled dependency
  CSS gets none.
- **Providers**: ErrorBoundary → QueryClient → Auth → Ability → WebSocket → Router. A global 401
  clears the cache and redirects to `/login?returnUrl=`.
- **Guards**: one `RequireGuard` primitive; nav items use the same guard as their page.
  `/login?as=` dev sign-in only works when the server reports `devLogin` and the email is a seeded
  account.
- **Data**: `api-client.ts` parses with shared schemas, there is one hook file per resource, and
  keys come from `queryKeys`. zustand holds only websocket state. Detail: `.claude/rules/ui.md`,
  `apps/web/src/ui/CLAUDE.md`.

**Known gaps:** no route preloading; no "system" theme or cross-tab sync; the dev quick-login list
is hard-coded.

## 8. Analytics

**The `analytics` PLUGIN, the one `defaultPlugins` entry (D31, since 0.6.0).** Repository
`rocketflare-dev/rocketflare-plugin-analytics`. Once installed, its docs are its own `CLAUDE.md`
files. drizzle-cube cubes scope every `sql()` by tenant, dashboards are jsonb `DashboardConfig`s
restrictable to groups, fact tables rebuild on the `:15` cron, and its cube-isolation test is
mandatory. The kit core knows nothing about drizzle-cube, and other plugins extend it through
`analyticsExtensions({...})`. `bootstrap --no-plugins` gives a kit without it.

The kit still owns `activity_events`, the catch-all/`run_worker_first`/Vite-proxy files its
prefixes must be added to, and the visibility registry it registers into.

**Known gaps (kit side):** `activity_events` has no retention; nothing proves a plugin's cron reached
the tomls beyond parity between the two files; fact refresh/check need a running server and CLI.

## 9. AI layer

Server: `api/services/{ai,agents}/**` (read their `CLAUDE.md`), `services/prompts.ts`,
`api/workflows/agent-run.ts`. Contracts: `packages/shared/src/ai/*`. Rules: `.claude/rules/api.md`
§ AI services.

- **One resolver (D17)**: `resolveChat` / `resolveEmbeddings` are the only readers of `ai_configs`
  / `agent_models` and the only place credentials are decrypted. Chat order: per-agent assignment →
  tenant default → platform `ANTHROPIC_API_KEY` → **Workers AI `glm-4.7-flash` via `[ai]`** → 503
  `ai_not_configured`. Embeddings order: tenant → Workers AI `bge-m3` (1024-dim) →
  `EMBEDDINGS_API_KEY` → 503. Workers AI calls are **billed** to the account; removing `[ai]` from
  both tomls makes the kit zero-spend. Credentials never leave the server (`hasCredential`); every
  error is normalised to `AiError` with secrets redacted.
- **Providers**: `anthropic`, `anthropic_compatible`, `openai`, `openai_compatible`, `workers_ai`.
  There is no Vercel AI SDK and no Bedrock (a SigV4 adapter behind `ChatClient` is the extension).
  Workers AI quirks — two response shapes, per-model `tool_choice`/streaming lists, fragmentary tool
  calls, schema-flattening retry — are in `services/ai/CLAUDE.md`. The floor model was chosen
  because it can run the *agents*.
- **Kit** (`services/ai/kit.ts`): `runStreamingChat`, `runToolLoop`, `callStructuredTool`, prompt
  caching helpers. Prompts are code (`PROMPT_REGISTRY`) with per-tenant override rows.
- **AG-UI is the wire protocol (D28)**: `@ag-ui/core` is pinned exactly and imported only by
  `shared/src/ai/agui.ts`. The kit emits 15 events plus a `kit.` CUSTOM namespace (apps use their
  own prefix). It supports SSE (`data:` only, no `event:` line) or protobuf.
  `POST /api/agui/run` is the `RunAgentInput` endpoint. The server owns the transcript, the client
  supplies only the new message, and client `tools[]` are refused.
- **Chat**: owned by `userId`; `chat-turn.ts` is the one implementation behind `/api/chat` and
  `/api/agui`. Everything that can fail as JSON runs before the stream opens, and stream writes use
  `streamDatabase(c)`. A cancelled run emits no terminal event. Chat can call the three knowledge
  tools (`CHAT_KNOWLEDGE_TOOLS`), capped at 6 turns. **Long threads are compacted**: a
  character-budget window (`CHAT_HISTORY_MAX_CHARS`), with the dropped prefix folded into
  `conversations.summary` by the `chat.compact` job (compare-and-set). Document cards come from
  `kit.document` events produced by a pure mapper, so nothing about a card is stored. The admin
  inspector (`/stats`) is derived per request.
- **Agents (D7)**: `POST /api/agents/runs` enqueues (row → Workflow instance → 202); the exclusive
  index dedupes. The Workflow runs `claim → execute#N → (resume#N | expire#N) → finish`, and
  **every step name carries its round**, because a repeated name replays the recorded result.
  A retry resumes: `ctx.checkpoint` keeps the tool-loop transcript and `ctx.once(key, fn)` gives
  once-per-run effects (a DB unique index; at-least-once with a recorded result).
- **Human-in-the-loop (#17)**: `ctx.interrupt({ key, spec })` parks the run on
  `step.waitForEvent`. The key must be stable across attempts. Answering is a compare-and-set on the
  row, *then* a nudge to the instance (`not_found` → restart as `<runId>-rN`). There are four
  closed interrupt kinds (approval/choice/input/form). Model-called tools are gated on the tool
  (`requiresApproval`) before any handler runs. Artifacts are an upserted table, and steering notes
  are event rows delivered once.
- **Reading runs**: `agent_run_events` is the durable log, and AG-UI is a pure read-time
  projection (`/agui`), also streamed live by tailing `seq` (`/agui/stream`, #7). A read-stream
  failure emits no `RUN_ERROR` (clients reconnect); `id:` goes on the last frame of a row's group,
  and reconciliation runs once before the first frame. Payloads never go over the tenant-wide DO,
  because run visibility is per run.
- **Knowledge (D18)**: `documents` + `chunks` (pgvector HNSW). Text is ingested inline or by job;
  uploads go to R2, then `AI.toMarkdown`, then the same indexer. Search is hybrid dense + lexical
  with RRF, scoped by `AccessScope` (§1). `document-content.ts` is the one text reader behind both
  the viewer and `get_document`. Agent tools resolve the requester's access at execute time.
  **External ids (D34)**: `documents.external_id` is unique per `(tenant_id, source)` (partial
  index, `0016`); an ingest carrying one is an upsert — one `ON CONFLICT` statement, grants
  replaced, chunks rebuilt, a replaced original removed from R2 — so a connector's re-sync never
  duplicates. Plugins reach it through `ingestDocument` (§16).
- **Usage**: one `ai_usage` row per call, costed at write time from the one price table
  (`shared/ai/pricing`; an unknown model gets `null` and is counted as unpriced).
- **Tracing (D32, supersedes D16's Langfuse ingestion client)**: `api/observability/`. Every AI call
  site talks to the `Tracer` seam; the recorder batches ended spans and flushes (in `waitUntil`, or
  awaited at the end of a stream, step or job) to two sinks: our own **OTLP/HTTP exporter**
  (`otlp-fetch.ts` — JSON by default, hand-encoded protobuf for backends that take nothing else,
  e.g. Phoenix; no dependency, no Node API) and the **local `ai_spans` table**, written whether or
  not a backend is configured (the request path opens its own short-lived client per non-empty
  flush). Attribute names — OTel GenAI semconv, OpenInference, Langfuse aliases — live in ONE module,
  `genai-attributes.ts`. Handles nest, and the active span rides `AsyncLocalStorage`, so a tool
  span (recorded by the kit's single tool runner — every tool, kit or plugin, chat or run),
  retrieval and embeddings nest without signature changes. **Workflow continuity**: a run's trace
  id is its uuid's hex and its root span id is derived from it, so each `execute#N` (a separate
  invocation) is a child of a root the `finish` step records once the run has settled. Covered:
  chat turns, agent runs, tools, retrieval, embeddings, the `chat.compact` / `document.index` /
  `document.convert` jobs. `OBSERVABILITY_PRESET` (`langfuse|phoenix|generic`) fills endpoint and
  auth — existing `LANGFUSE_*` keys migrate with no new secret; `OBSERVABILITY_CAPTURE_CONTENT=false`
  strips prompts, completions and tool I/O from both sinks; `pruneAiSpans` on the nightly cron keeps
  `OBSERVABILITY_SPAN_RETENTION_DAYS` (14). Read back through `GET /api/traces[/:id]` (`read
  Trace`, admin+ — spans hold other people's prompts) and `rocketflare traces list|show`; the
  `rf-traces` skill teaches an agent to debug from the span tree. Switch recipes: `docs/DEPLOY.md`
  § Tracing.

  **D32 decisions** (design grilling, 2026-09-25): our own OTLP exporter behind the existing seam —
  not Cloudflare's native tracing, not the Langfuse SDK · the backend is platform-wide only ·
  content capture is on by default, with a flag to disable · agent context comes from the CLI
  reading our own Postgres, not a backend REST adapter.
- **Evals (D33)**: `apps/evals`, its own workspace package because vitest-evals needs vitest 4 and
  the kit's suites are on vitest 3. `pnpm eval [suite] [--model x] [--judge-model y] [--compare]`
  runs `suites/**/*.eval.ts` against the TEST database with real models (the platform
  `ANTHROPIC_API_KEY` from `.dev.vars`; no key → every suite skips and says why). **Targets are
  in-process and go through the product's own code**: the chat target drives the real
  `POST /api/chat/conversations/:id/messages` route (so `prepareChatTurn` decides prompt, history and
  tools, as in production); the agent target runs `enqueueRun` → `claimStep` → `executeRun` →
  `finishStep` inline. Each case gets a tenant of its own with its `context` documents ingested, so
  retrieval can only find what the case put there. Everything a target does runs in
  `withEvalScope` (`observability/context.ts`), which marks its traces `rocketflare.eval=true`.
  **The harness input IS the `EvalCase`** (`shared/ai/evals.ts`: input, messages, context,
  expected `{ output, rubric, tools, toolsMatch, contains }`, tags, source), so judges read each
  case's own expectations; `describeCases` attaches to a case only the judges it declares something
  for, because vitest-evals averages a `null` score as 0. Deterministic judges (`Contains`,
  `Matches`, `Schema`, `Trajectory` with agentevals' strict/unordered/subset/superset, `Budget`)
  come first; LLM judges (`Rubric`, `Faithfulness` against what retrieval actually returned,
  `Reference` = vitest-evals' `FactualityJudge`) run through ONE judge harness that calls the kit's
  resolver on the `evals-judge` prompt key — so `agent_models` can pin it, `--judge-model` overrides
  it, and every call is an `ai_usage` row under `evals.judge`. `--provider` / `--judge-provider
  fireworks|gemini` put the target or judge on a real encrypted tenant `ai_configs` row
  (Fireworks through the kit's own `fireworks` preset, Gemini as `openai_compatible`), so vendor
  comparisons also exercise the tenant-config tier. A run is a vitest JSON report in
  `.evals/runs/<ts>-<sha>.json` (git-ignored), stamped with the sha, models and prompt hashes;
  baselines are committed per suite (`baselines/<suite>.json`, `pnpm eval:baseline`) and
  `--compare` exits 1 on a per-case, per-judge drop past `--threshold` (0.1). `pnpm eval:view`
  prints the score diff between two runs, then serves the vitest-evals report UI (runs, cases,
  transcripts, judge rationales). The optional `evals.yml` workflow runs it on manual dispatch or a
  `run-evals` label, outside the gate. How-to: `docs/EVALS.md`; the `rf-evals` skill drives it.
- **Feedback and promotion (D33)**: thumbs on assistant messages and run output
  (`POST /api/feedback`, `create Feedback` for every member, on an answer they can READ — another
  member's thread is a 404, admins included). One row per `(tenant, target, user)` in
  `ai_feedback`; voting again replaces, the same thumb twice withdraws. Each vote is also a
  zero-length `feedback` span under the answer's trace root (`rocketflare.feedback.rating`), shown by
  `rocketflare traces show`. AG-UI capabilities now declare `feedback: true` for chat and runs.
  Admins (`read Feedback`) list the queue (`rocketflare feedback list --rating down`) and
  `GET /api/evals/export?messageId|runId` drafts an `EvalCase` — question, history, the passages
  retrieved, the tools called, the OBSERVED answer as `expected.output`, the feedback — which
  `rocketflare evals promote <id> --dataset <name>` appends to a dataset after warning that it is
  tenant data (it will not write without `--yes` or a confirmed prompt).

  **D33 decisions** (design grilling, 2026-09-25, issue #21): vitest-evals as the runner, in its
  own vitest-4 package rather than a workspace-wide vitest upgrade or a home-grown runner · targets
  in-process, through the real route and runtime · no in-app eval UI (JSON runs + the report UI) ·
  datasets are code; promotion from real traffic and thumbs · the judge goes through the resolver,
  with a `--judge-model` override · in core, not a plugin · the `rf-evals` skill is a first-class
  deliverable. The prompt key is `evals-judge` (keys are kebab-case); the ledger feature is
  `evals.judge`.
- **Rejected**: Cloudflare's Agents SDK. Per-instance SQLite sits outside RLS, the tenant FK cascade
  and cross-tenant indexes, and the inbox would need Postgres anyway. One `step.do` per model turn
  was also rejected: steps are unlimited in wall-clock time, and splitting would force every side
  effect outside a step to replay.

**Known gaps:** no document summary or thumbnail (the card is an excerpt; Workers cannot rasterise);
`charOffset` does not map to PDF pages; no frontend tools in chat, no `STATE_DELTA`; protobuf drops
`TOOL_CALL_RESULT` and has no stream cursor; `@ag-ui/core` is 0.0.x (pin + contract test are the
mitigation); no token-level streaming for runs (would need a per-run DO); char-based history budget
not derived from the model; sliding window defeats prompt caching on long threads; `enqueueRun`
does not pre-resolve the client; Workers AI forced tools on off-list models are best-effort; no
rerank, no generated `tsvector`; no non-exclusive agents; HITL asks cannot be amended, have no
reminders, and parks are bounded by instance retention (3 days Free / 30 Paid); runs nobody opens
stay active-looking; no budgets/quotas over `ai_usage` or prompt versioning; the demo seed's
vectors are deterministic, so dense search over seeded docs is noise. Tracing: no per-tenant
backends (BYO keys via `sealSecret`), no native `tracing.enterSpan`, no metrics export, no
Langfuse/Phoenix MCP; inline ingest from `POST /api/ai/documents/ingest` is untraced (no active
span); the backend receives a run's root only at `finish`, so an in-flight run has no root there;
exported content is capped at 32 000 chars per value. Evals: no in-app eval UI or dataset editor;
the report UI has no side-by-side view (the diff is `eval:view`'s terminal table); no HTTP targets
against a deployed instance, no red-teaming, no push to Langfuse datasets; a run that parks on a
person scores as a miss (an eval cannot answer it); run faithfulness sees each passage's
600-character event preview; without `EMBEDDINGS_API_KEY` retrieval in evals leans on the lexical
half of hybrid search; `--provider` knows three vendors (anthropic, fireworks, gemini) and the
latter two are unpriced; a thumbs vote is a
zero-length span, not an OTLP span event, and is not traced when the answer's root was pruned.

## 10. Deployment

Two standalone tomls (D6) kept identical in everything code can see by `wrangler-parity.test.ts`.
Account-scoped names carry `-staging`. Neon uses one project with a branch and role per
environment; under `postgres` Hyperdrive points at the direct host, under `neon` the Worker's
`DATABASE_URL` secret holds the pooled one (D35). Tagging `X.Y.Z` (which must equal the root
version) deploys staging; publishing the Release deploys production. `ci.yml` (→ `gate.yml`) is the
single gate, which `deploy.yml` calls (`deploy: true`: no `test-neon`) only when the commit has no
successful CI run yet — a commit is gated once. Its default-plugins and renamed passes are kit-only
(guarded on the kit's repository name, which a rename keeps), so a copy runs one gate. `pnpm provision <phase>` / `/rf-provision` automates
accounts → resources → secrets → deploy over REST. Reference: `docs/DEPLOY.md`, `SETUP.md` Part 3.

**External deployer (opt-in).** A Cloudflare token that can deploy a Worker can bind any resource in
the account into it, so a CI job holding one can reach other apps' data. With the repository
variable `DEPLOYER_URL` set, `deploy.yml` holds no Cloudflare token and no database credential: it
proves who it is with a GitHub OIDC token and hands the dry-run build to a deployer that checks the
bindings, stores an undeployed version, issues short-lived migration credentials, then activates
(`scripts/deployer.mjs`; the v1 contract is `docs/DEPLOYER.md`). Unset, the default path is unchanged.

**Known gaps:** no release helper beyond `kit:release`; no per-PR previews; no CLI publishing;
provisioning HTTP calls have not been run end-to-end against live accounts; no automated
Workers-plan check. The kit ships no deployer, only the client and the contract; the job waits for
approval on a runner (fine for minutes, wasteful for hours — there is no re-dispatch). A deploy
dispatched while the pushed commit's CI run is still in progress gates again rather than waiting
for it, and the deploy path does not run `test-neon` (a PR/push check).

## 11. CLI

A thin client over `/api/*` using a tenant API key. It parses with shared schemas and never keeps
a second copy of the contract (D26). `api.ts` is the only `fetch` site. Config lives in
`~/.rocketflare/config.json` (0600); `ROCKETFLARE_API_KEY`/`ROCKETFLARE_URL` override it for CI.
`--json` is available on every read. `traces list|show` reads the local AI trace store (D32);
`feedback list` is the thumbs queue and `evals promote <id> --dataset <name>` appends a draft eval
case to `apps/evals/datasets/` (D33, both admin+). Exit codes: 0 ok · 1 error · 2 not logged in ·
3 forbidden.
No command prints a full key. Plugins register top-level commands named after their id.
Detail: `.claude/rules/cli.md`.

**Known gaps:** no device-code flow; one profile at a time; `logout` does not revoke the key; no
shell completion; not published.

## 12. Shared package

`packages/shared` is private and has no build step: `@rocketflare/shared/<module>` resolves to
`src/<module>.ts` (so a plugin entry is `…/plugins/<id>/index`). Contracts come first (D13): a new
API surface starts here. Allowed imports: `zod`, siblings, type-only `@casl/ability`, and
`@ag-ui/core` only in `ai/agui.ts` (`shared-imports.test.ts`). It never imports `apps/*`, and
`src/plugins/**` never imports one of the five composers at runtime (that would create a module
cycle). Detail: `packages/shared/CLAUDE.md`.

**Known gaps:** no own test suite; no OpenAPI; no contract versioning between web and CLI.

## 13. Upgrading a copy

**A renamed copy with deleted examples still absorbs later kit releases (D27).**

- **`.rocketflare.json`**: kit `{repo, version, commit}`, the app's names (`app === null` means
  "this is the kit", asked only through `readManifest()`), `history[]`, `retiredSurfaces`
  (never deleted), and the **surface manifest**. Surfaces are `example`, `optional-feature` and
  `plugin`, each with an anchor file whose existence is its presence (delete the anchor to opt
  out). Every other path is `neverPort`, `kitOnly`, `manual` or `core`; `kit-manifest.test.ts`
  requires 100% coverage.
- **Kit-only tests** (`kitOnly`, `apps/web/tests/kit-only/**`, vitest project `kit-only`): the tests
  true of the kit repository and of nothing made from it — porting notes and the root version being
  the kit's, the release/rename machinery, the maintainer hooks, plugin CI, the manifest's kit-state
  claims. The kit's gate runs them; `scripts/rename.mjs` deletes them and unwires the project when a
  copy is born; `classifyPath` never ports one (the TARGET kit's list too, and `KIT_ONLY_PATHS` is the
  floor for a pre-0.15.8 manifest); `tests/config/kit-manifest.test.ts` fails a copy that carries
  one, and CI's renamed-copy gate asserts none survive and passes at an app version (`1.2.3`).
- **Porting notes**: one `docs/upgrades/X.Y.Z.md` per release (frontmatter + four headings), with
  `unreleased.md` accumulating. CI fails a PR touching `apps/**`/`packages/**` without an entry,
  and the tag gate refuses a release without one. `pnpm kit:release` writes everything.
- **`scripts/upgrade.mjs`**: a blobless mirror in `.upgrade/`. It classifies paths, drops absent
  surfaces and plugin-owned files, translates through the same `applyReplacements()` as the rename,
  then patches with `--reject` as a fallback. It **never** applies kit migrations (snapshots are
  cumulative), writes resource ids into tomls, applies deletions unasked, or ports the root
  version. The version stamp is written last, only on a clean apply.
- **A copy hears about releases on its own**: a Claude Code `SessionStart` hook
  (`scripts/kit-update-check.mjs`, in `.claude/settings.json`) compares `kit.version` with the
  newest tag at `kit.repo` (`git ls-remote`, cached a day in the git-ignored
  `.claude/kit-update-check.json`; a failed check an hour) and hands Claude one message to relay
  once per session, with the CHANGELOG summaries and a pointer to `/rf-upgrade`. Copies only, a
  fresh `startup` only, never in CI, `ROCKETFLARE_UPDATE_CHECK=0` to silence; any failure is
  silence.
- **The kit reminds its own maintainers too**: two `PreToolUse` hooks on `git commit` —
  `changelog-nudge.mjs` (source changed, no `unreleased.md` entry) and `release-site-nudge.mjs`
  (root `package.json` version changed → update rocketflare.dev after tagging). Both answer with
  `hookSpecificOutput.additionalContext`, because a `PreToolUse` hook's plain stdout reaches only
  the debug log. Silent in a copy.
- **Released history is never rewritten** — every copy pins a commit.

**Known gaps:** a copy pinned before 0.10.1 has no update hook until it upgrades (and
`.claude/settings.json` is `manual`, so that upgrade must add the hook entry by hand); summaries
only for a GitHub-hosted kit; tomls and `.dev.vars.example` are diffed, not merged; the reject rate is not
predicted; pre-manifest copies need `--adopt`; no partial upgrades; nothing checks the adopter ran
migrations; lockstep plugin releases bump every plugin in a monorepo; a copy on 0.15.7 or older deletes
its kit-only tests by hand once (its upgrader predates `kitOnly`); the release and rename SCRIPTS
still ship to copies (they refuse to run in an app), only their tests are kit-only.

## 14. Definition of done for the kit

A fresh agent can clone and run `bash scripts/bootstrap.sh` with zero credentials and land signed in
on a populated demo workspace. From there it must be able to:

- rename the copy (`/rf-adapt`)
- log in by magic link and through the CLI
- invite a member, switch tenants, approve an access request, including under `single` mode
- see live refresh from a second browser and queued email
- upload an avatar
- stream a chat with persisted usage
- run, watch live, cancel and HITL-answer agents across a dev restart, with the approved document
  indexed exactly once
- ingest, upload a PDF and search it
- restrict content by group and watch it disappear and reappear live
- see analytics installed by default, removable cleanly with `--no-plugins` or `plugin remove`
- port a later kit release skipping deleted examples
- toggle the `example-feature` plugin's flag
- provision and deploy to staging

The full gate stays green at every step. `SETUP.md` is the walkthrough.

## 15. Feature flags

**A feature flag is configuration, not a permission (D30).** Every gate reads the `features`
**array** (`hasFeature`, `requireFeature`, `{ feature }` nav guards), never CASL. A global admin's
`manage all` would satisfy `access Feature:x` and expose unreleased surfaces.

- **Two layers**: `FEATURES_ENABLED` in `[vars]` is the fail-closed release gate, consulted only for
  `environmentGated` flags. Then the admin rollout: tenant override → `on`/`off` → `rollout`
  percentage → registry default.
- **Keys are code** (`FEATURES` + metadata). No migration is needed to add one; orphaned rows are
  inert. The kit ships **no** flag — `example-feature`'s belongs to its plugin — so
  `featureNameSchema` is a refined string.
- **`featureBucket` is a wire format**: FNV-1a over `"<key>:<unit>"` mod 100, with golden vectors
  in `features.test.ts`. It is monotonic (the percentage is never hashed) and independent across
  flags.
- Resolved inside the session query, with no extra round trip. Gate every door: API mounts (404
  `feature_disabled`, not 403), plugin registries, **hooks that create rows**, and nav/routes.
- Admin UI at `/admin/feature-flags`; a tenant override nudges that tenant.
  `GET /api/features` / `rocketflare features list` show effective state.
- **Rejected**: Cloudflare Flagship. It has no notion of your tenants, whole-object `PUT` loses
  updates, it has no local store, and the browser SDK needs a token. It fits the kit's own
  cross-deployment rollouts, not per-tenant entitlements.

**Known gaps:** gated code still ships in the bundle (the server is the protection); no per-user
forcing or scheduling; platform flips reach open tabs only on their next session fetch; no cache on
the Bearer path; flags cannot gate pre-tenant surfaces.

## 16. Plugins

**A plugin is a git repository COPIED into an app, never an npm package (D31)**, translated through
`applyReplacements()` like kit code. Only first-party plugins for now: installing one is as trusting
as merging a PR. A plugin repo mirrors the host tree and ships **no migration, no toml and no
`package.json`**. Working guide: `apps/web/src/plugins/CLAUDE.md`, `/rf-plugin`,
`docs/plugin-api.md`.

- **Outbound**: four published entries (server, UI, shared, CLI). Nothing reaches past them, in
  either direction between core and plugins.
- **Inbound**: a plugin imports the host only through **declared entries** and receives everything
  else as **injected context** (`RequestCtx`, `JobCtx`, `CronCtx`, `ToolCtx`, `AgentCtx`,
  `WorkflowCtx`, `HookCtx`, `SeedCtx`, `DetachedCtx` — thin adapters over kit internals). Two things
  cannot be injected and are entries instead: `@/db/schema/kit` (module-scope table helpers,
  imported by relative path) and the split UI kit (`ui-wiring` for the eager entry, `ui` for lazy
  pages). Tests use `@testkit/{integration,unit}`, whose builders refuse a database handle not
  created by `setupTestDatabase`. `tests/helpers/plugins.ts` enforces all of this, and every
  diagnostic names the replacement import.
- **Six barrels**, one line per plugin each, written by `pnpm plugin add|remove`: shared, server,
  schema, ui, worker-exports (DO/Workflow classes reach `worker.ts`), cli. Each exports an `as const`
  tuple plus a widened list, so an empty kit still typechecks. **Opening a closed set** always
  follows one pattern: `X = [...CORE_X, ...plugins]`. `ServerPlugin<S>` checks handlers, agents and
  prompts exhaustively against the plugin's own keys.
- **Namespacing**: the id is `^[a-z][a-z0-9-]*$` and namespaces jobs (`<id>.x`), query keys
  (`<id>:`), `/api/<id>`, CLI commands and CUSTOM events. Never `kit.`. Table prefixes are a human
  convention; **two plugins declaring the same table is a `plugin check` failure**.
- **Record**: a `kind: 'plugin'` surface (`source: {repo, subdir, version, commit}`). In the kit or
  with `--local` it goes in the git-ignored `.rocketflare.local.json`. A kit diff never touches
  plugin-owned files. A vendored plugin (`example-feature`) upgrades with the kit.
- **Compatibility is OBSERVED (decision 5c)**: the kit emits a `## Surface ledger` in
  `docs/plugin-api.md` (generated, diff-checked). A plugin's `uses` is **derived** from its imports
  by `pnpm plugin export`, and compatibility is the set difference `uses \ ledger`, checked before
  any file is copied. The one surviving number is a top-level `minKit` floor. `requires.kit` /
  `requires.pluginApi` are refused by name. CI proves both ends: `ci.yml` runs the gate with
  `defaultPlugins` installed (in the kit's own repository only), and plugin repos call
  `plugin-ci.yml` (floor + newest kit), which installs a plugin's `requires.plugins` from the
  same checkout first and takes the highest `minKit` across the set as the floor.
- **Lifecycle** (`scripts/plugin.mjs`): `add` (plan, then `--apply`), `upgrade`, `remove`
  (`--archive`), `list`, `check`, `export`. Every plan step is **declarative, agent (with its
  assertion) or human** — a printed instruction is not a mechanism. The host generates the
  migration (`db:generate --name plugin-<id>-<version>`). `pnpm provision cloudflare <env>` writes
  a plugin's bindings (`kv|queue|r2|workflow|durable_object`), crons, prefixes and vars into BOTH
  tomls. DO migration tags `plugin-<id>-vN` are append-only.
- **`plugin check` is an exhaustive oracle**: manifest fields, `minKit`, ledger diff, barrel lines,
  `*.rej`, migration tag, host dependencies, worker exports, a tenant-isolation test for tenant
  tables, `onTenantDeleted` for DOs, table collisions, declared skills. Each finding names file, line and exact edit.
  Structural checks read comment-free code. CI runs the same command.
- **Agent tools**: `agentTools(ctx)` may be async and may return `[]`. That is how a tool reaches
  only the tenants that turned it on: the plugin reads its own settings row for `ctx.scope.tenantId`.
  A builder that throws is logged and skipped. `buildAgentTools` is therefore async.
- **Credentials**: a plugin stores a tenant's key with `sealSecret` / `openSecret` from
  `@/plugins/api`. That is the kit's AES-GCM under `OAUTH_ENCRYPTION_KEY`, with a 503 when the key
  is unset. Store the sealed value in a `*_enc` column and answer `hasCredential`.
- **Public mounts (D34)**: `publicMounts` are routes a third party calls with no session — an
  admin-consent callback, a webhook. Only under `/api/hooks/<id>` (so no toml edit and one
  enumerable prefix per plugin), mounted before the authed table with no `authMiddleware` and no
  gate; `tests/config/plugins.test.ts` refuses one anywhere else and any authed mount there. The
  handler gets `publicCtx(c)` — no tenant, no auth fields, `enqueue`, `features(tenantId)` — and
  proves the caller before naming a tenant. `signState` / `verifyState` are the proof for a
  round-trip the plugin started: HMAC-SHA256 under a key HKDF-derived from
  `OAUTH_ENCRYPTION_KEY`, a `purpose` that is part of the signed body, an absolute expiry
  (default 10 min), `null` for every failure. Signed, not encrypted.
- **Background feature checks (D34)**: `JobCtx`, `CronCtx` and `PublicCtx` carry
  `features(tenantId)` — the same resolution as `auth.features`, with no user, so a cron that fans
  out across tenants can skip the ones whose flag is off.
- **Knowledge ingest (D34)**: `ingestDocument` / `ingestDocumentFile` / `deleteIngestedDocument`
  over the kit's ingest paths (§9). With an `externalId`, the same `(tenant, source, externalId)`
  UPDATES the row — text, owner, visibility, grants, chunks, the stored original — so a sync can
  replay safely. Group ids are checked against the tenant first. This file belongs to the
  `feature-knowledge` surface; a plugin that ingests requires it.
- **Skills**: a plugin ships agent skills at `skills/<dir>/` in its own tree and declares them in
  `"skills"`; `add` copies each to `.claude/skills/<dir>/` (the one place outside its roots a
  plugin may write) and records it on the surface, `upgrade` REPLACES it (never patches — an agent's
  instructions are the plugin's outright), `remove` deletes it. `<dir>` is `<id>` or `<id>-*` and
  its SKILL.md `name:` equals it, so a plugin skill can never shadow a kit `rf-*` one; an existing
  directory is a refusal. `plugin check` fails a declared skill that is missing, misnamed or
  undescribed, and a directory in the plugin's namespace it does not declare. `.claude/` in a
  plugin repository stays that repository's own tooling. `example-feature` ships one.
- **Hooks** (`onTenantCreated`, `onTenantDeleted`, `seedDemo`) run post-commit, are idempotent,
  and are try/caught. DO state is purgeable only through instance names **derived** from the tenant
  id.
- **Traps measured, now rules**: registries a plugin composes into are FUNCTIONS, not consts
  (module-evaluation order); a value a plugin needs moves to a leaf module; browser-read registries
  are separate files from composing ones; plugins declare `relations()` for their own tables only
  (drizzle type intersection); annotate `const ctx: RequestCtx` so `never` narrows.
- **`example-feature`** is the vendored reference that exercises every slot. It exists to be
  deleted.

**D31 decisions** (cited by number in code comments):

| # | Choice |
|---|---|
| 1 | First-party only; the install plan waits for a human |
| 2 | The kit is bare; `defaultPlugins` + a bootstrap step keep a fresh clone unchanged |
| 3 | `example-feature` is the reference plugin |
| 4 | A plugin is recorded as a `kind: 'plugin'` surface; `readManifest()` is the one kit-vs-app predicate |
| 5 | Compatibility is proved in CI from both ends (`ci.yml` with defaults installed; `plugin-ci.yml`; `kit:release` refusal) |
| 5b | *(reversed)* a `PLUGIN_API` integer beside `requires.kit` |
| 5c | Compatibility is observed: derived `uses` against the emitted ledger, plus a `minKit` floor |
| 6 | Cubes/fact tables/dashboards are plugin-owned registries via `extensions`, narrowed by the owner |
| 7 | Analytics extracted with no compatibility path (tables become `analytics_*`) |
| 8 | Pages are `lazy()`, proved by a source-level test |
| 9 | Four published entries; deep imports fail in either direction |
| 10 | Phase A shipped as four PRs, one release |
| 11 | Uninstall drops tables by default, `--archive` on request |
| 12 | Provisioning writes plugin bindings into both tomls (`kv`/`queue`/`r2` created; `workflow`/`durable_object` declared) |
| 13 | Every manifest has a required `repo` |
| 14 | The inbound surface is injected context (the `*Ctx` family), not imported symbols |
| 15 | What cannot be injected is a declared entry (`@/db/schema/kit`, split UI kit, `@testkit/*`) |
| 16 | A printed instruction is not a mechanism — hence the worker-exports barrel |
| 17 | DO migration tags are append-only and host-owned |
| 18 | Out-of-Postgres tenant state is purged via `onTenantDeleted` over derived DO names |
| 19 | Test builders refuse a fake database |
| 20 | Every plan step is declarative, agent or human (`kind` in `--json`) |
| 21 | `plugin check` is an exhaustive, untiered oracle that reads comment-free code |
| 22 | Table prefixes are convention; collisions are the check |
| 23 | A plugin ships agent skills: `skills/<dir>/` → `.claude/skills/<dir>/`, namespaced by id, replaced on upgrade |

**Known gaps:** no sandbox, review or signing; no rename migrations (expand/contract only); no
cross-plugin FK tooling or `many()` onto core tables; `grants` is additive by convention only;
provisioning never deletes resources; `d1`/`vectorize`/`analytics_engine` bindings are refused;
the ledger judges only ledgered entries, ignores namespace imports, truncates types over 300
chars, and `uses` is only as fresh as the last export; table collisions are caught by `check`, not
refused at `add`; the isolation check proves a test exists, not that it is right; no database-free
test of data-touching handlers; one DO per row is unpurgeable (purge-intent ledger not built);
`plugin-ci.yml` input changes reach callers only via `main`, and nothing tests versions between
floor and ceiling. Public mounts (D34) get no rate limit of their own and no `@testkit` builder
(test them through `request()`); `verifyState` has no replay ledger — a token is reusable until it
expires, so a plugin whose callback must run once records that itself; an ingested document's
upsert reads the previous row before writing, so two racing re-ingests of a FILE may leave one
replaced original behind in R2; a plugin skill edited in place is overwritten by the next
`plugin upgrade` (copy it to a skill of your own first), and `check` validates a skill's name and
description, not what it says — a stale command in a SKILL.md is caught only by reading it.

---

## 17. Connectors

An **organisation connection** to Microsoft 365 or Google Workspace (D34): an org admin grants an
operator-registered app access to the whole directory, calendars and — later — mail and files, and
Rocketflare syncs them into the tenant. It is **not login** (§2): a different app, a different
grant (admin consent / domain-wide delegation, app-only tokens), a different subject (the
organisation, not the signer). The design, operator and customer-admin setup, phases and the MCP
assessment are in `docs/CONNECTORS.md`.

It ships as plugins, not core: the `connectors` base plugin (installations, connections, sync
cursors, the settings tab, the sync job and cron) and one provider plugin each (`m365` first,
`google-workspace` next), registered through `extensions.connectorProviders`. The kit's part is
four generic seams on the plugin surface (§16): public mounts at `/api/hooks/<id>`, `signState` /
`verifyState`, `ingestDocument` with an `externalId` upsert (§9), and `features(tenantId)` off the
request.

| # | Choice |
|---|---|
| 1 | Login and connection stay separate apps, even in production |
| 2 | One operator-registered app per deployment by default; a per-customer BYO app is the escape hatch |
| 3 | The data model covers all three usage models from day one: installation → connection with `ownerType` `tenant` or `user` |
| 4 | Org-wide app-only ships first; per-user delegated is phase 4 |
| 5 | Directory + calendar by delta polling first — no restricted scopes, so no Google CASA gate |
| 6 | Webhooks only ever trigger a delta fetch; polling stays the backstop |
| 7 | Every synced row carries its owner; tenant isolation alone is not enough inside one organisation |
| 8 | Vendor MCP servers are not a data plane (delegated only, no delta or webhooks) — at most a later chat-tool adapter |

**Known gaps:** no webhooks yet (phase 2); no mail or file ingestion (phase 3); no per-user
delegated connections or refresh-token rotation (phase 4); Google Workspace provider not built;
M365 uses a client secret, not a certificate assertion; no Exchange RBAC-for-Applications scoping
script; synced private rows are still readable by tenant admins (D29 owner-and-admins); the kit has
no MCP client; directory sync does not provision kit users or groups (it only matches by email).

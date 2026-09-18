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

**Layout (D26).** A pnpm workspace: `apps/web` (the Worker — Hono API + React UI, §§1–10),
`apps/cli` (§11), `packages/shared` (zod contracts, §12).

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

- **Sessions are rows**: `user_sessions`, 7-day sliding TTL, cookie `__Host-session` (`HttpOnly`,
  `SameSite=Lax`, `Secure` outside development). `authMiddleware` resolves session → user →
  membership → groups → features in one query. The second strategy is a Bearer tenant API key
  (hashed, expiry, soft revoke).
- **Magic link** is the zero-credential path: a 256-bit, 15-minute, single-use, SHA-256-hashed
  token. With no `RESEND_API_KEY` the URL is logged. Dev-login exists and 404s in production.
- **OAuth is a registry** (D11): one generic `/auth/:provider` router over `ProviderDefinition`s
  (Google, Microsoft via arctic). Redirect URIs come from `APP_URL`, accounts link by verified email,
  and tokens are AES-GCM encrypted under `OAUTH_ENCRYPTION_KEY`.
- **Hardening (D12)**: random tokens hashed with SHA-256, a required encryption key, CSRF by origin
  allow-list (Bearer is exempt), and a KV sliding-window rate limit on login routes that no-ops
  without `RATE_LIMIT_KV`.
- **CLI handoff (D26)**: `GET /auth/cli?redirect_uri=http://127.0.0.1:<port>/callback` only allows
  loopback redirects. It mints a revocable tenant key `cli:<hostname>` and 302s back with it.
  Details: `.claude/rules/api.md`.

**Known gaps:** no provider token refresh; the rate limit is approximate; no session management UI
beyond "log out everywhere"; CLI keys differ from other keys only by name.

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

**Known gaps:** no `/api/ready` smoke step against a preview; no OpenAPI (`@hono/zod-openapi` is the
path); no per-PR previews.

## 4. Database

- **One driver, one client per request (D2)**: Drizzle over `postgres.js`. The client is built per
  request / consumer message / step / cron run and closed in `waitUntil` or `finally`.
  `resolveDatabaseUrl` = `PREVIEW_DATABASE_URL ?? HYPERDRIVE.connectionString ?? DATABASE_URL`.
  Hyperdrive is the pool, so there is no LISTEN/NOTIFY, advisory lock or PREPARE on the request path.
- **Conventions**: one file per table, `tenantRef()` + `timestamps()` (`timestamptz`), append-only
  enums, `vector(1024)` (a new dimension means a new table). `migrate.ts` creates the `vector`
  extension first. Detail: `.claude/rules/database.md`.
- **Local port is chosen** (`scripts/dev-db.mjs`): each checkout gets its own compose project and
  port, written back to `DATABASE_URL`, so two copies never share a database.
- **Migrations**: `db:generate` → read the SQL → `db:migrate` (role → migrations → grants).
  Migrations are forward-only.
- **Cross-tenant allow-list**: `tests/config/unscoped-allowlist.test.ts` fails a function that
  queries a `tenant_id` table without naming a tenant. Each exception carries a reason. It does
  not prove `admin.ts` is the only cross-tenant surface.
- **RLS** ships inert: every tenant table has `tenantIsolation()` (enforced by `rls-coverage`),
  and `TENANT_SCOPE_MODE=enforce` waits on the spike in `docs/RLS.md`.

**Known gaps:** the RLS spike has not been run; no read replicas; the TEST database is pinned to
5433, so two checkouts cannot run `pnpm test` at once.

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
- **Usage and tracing**: one `ai_usage` row per call, costed at write time from the one price table
  (`shared/ai/pricing`; an unknown model gets `null` and is counted as unpriced). Langfuse tracing is
  on only when both keys are set (D16).
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
stay active-looking; no budgets/quotas over `ai_usage`, prompt versioning or evals; the demo seed's
vectors are deterministic, so dense search over seeded docs is noise.

## 10. Deployment

Two standalone tomls (D6) kept identical in everything code can see by `wrangler-parity.test.ts`.
Account-scoped names carry `-staging`. Neon uses one project with a branch and role per
environment, and Hyperdrive points at the direct host. Tagging `X.Y.Z` (which must equal the root
version) deploys staging; publishing the Release deploys production. `ci.yml` (→ `gate.yml`) is the
single gate, which `deploy.yml` calls. `pnpm provision <phase>` / `/rf-provision` automates
accounts → resources → secrets → deploy over REST. Reference: `docs/DEPLOY.md`, `SETUP.md` Part 3.

**Known gaps:** no release helper beyond `kit:release`; no per-PR previews; no CLI publishing;
provisioning HTTP calls have not been run end-to-end against live accounts; no automated
Workers-plan check.

## 11. CLI

A thin client over `/api/*` using a tenant API key. It parses with shared schemas and never keeps
a second copy of the contract (D26). `api.ts` is the only `fetch` site. Config lives in
`~/.rocketflare/config.json` (0600); `ROCKETFLARE_API_KEY`/`ROCKETFLARE_URL` override it for CI.
`--json` is available on every read. Exit codes: 0 ok · 1 error · 2 not logged in · 3 forbidden.
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
  out). Every other path is `neverPort`, `manual` or `core`; `kit-manifest.test.ts` requires 100%
  coverage.
- **Porting notes**: one `docs/upgrades/X.Y.Z.md` per release (frontmatter + four headings), with
  `unreleased.md` accumulating. CI fails a PR touching `apps/**`/`packages/**` without an entry,
  and the tag gate refuses a release without one. `pnpm kit:release` writes everything.
- **`scripts/upgrade.mjs`**: a blobless mirror in `.upgrade/`. It classifies paths, drops absent
  surfaces and plugin-owned files, translates through the same `applyReplacements()` as the rename,
  then patches with `--reject` as a fallback. It **never** applies kit migrations (snapshots are
  cumulative), writes resource ids into tomls, applies deletions unasked, or ports the root
  version. The version stamp is written last, only on a clean apply.
- **Released history is never rewritten** — every copy pins a commit.

**Known gaps:** tomls and `.dev.vars.example` are diffed, not merged; the reject rate is not
predicted; pre-manifest copies need `--adopt`; no partial upgrades; nothing checks the adopter ran
migrations; lockstep plugin releases bump every plugin in a monorepo.

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
  `defaultPlugins` installed, and plugin repos call `plugin-ci.yml` (floor + newest kit).
- **Lifecycle** (`scripts/plugin.mjs`): `add` (plan, then `--apply`), `upgrade`, `remove`
  (`--archive`), `list`, `check`, `export`. Every plan step is **declarative, agent (with its
  assertion) or human** — a printed instruction is not a mechanism. The host generates the
  migration (`db:generate --name plugin-<id>-<version>`). `pnpm provision cloudflare <env>` writes
  a plugin's bindings (`kv|queue|r2|workflow|durable_object`), crons, prefixes and vars into BOTH
  tomls. DO migration tags `plugin-<id>-vN` are append-only.
- **`plugin check` is an exhaustive oracle**: manifest fields, `minKit`, ledger diff, barrel lines,
  `*.rej`, migration tag, host dependencies, worker exports, a tenant-isolation test for tenant
  tables, `onTenantDeleted` for DOs, table collisions. Each finding names file, line and exact edit.
  Structural checks read comment-free code. CI runs the same command.
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

**Known gaps:** no sandbox, review or signing; no rename migrations (expand/contract only); no
cross-plugin FK tooling or `many()` onto core tables; `grants` is additive by convention only;
provisioning never deletes resources; `d1`/`vectorize`/`analytics_engine` bindings are refused;
the ledger judges only ledgered entries, ignores namespace imports, truncates types over 300
chars, and `uses` is only as fresh as the last export; table collisions are caught by `check`, not
refused at `add`; the isolation check proves a test exists, not that it is right; no database-free
test of data-touching handlers; one DO per row is unpurgeable (purge-intent ledger not built);
`plugin-ci.yml` input changes reach callers only via `main`, and nothing tests versions between
floor and ceiling.

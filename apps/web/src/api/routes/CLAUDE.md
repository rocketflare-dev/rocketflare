# API Routes

Hono routers mounted in `src/api/index.ts`. Thin controllers: validate → authorise → query → respond.

## Layout

- `health.ts` — `/api/health`, `/api/ready`. Public.
- `auth/` — public (rate-limited where login-shaped): `session.ts` (`/auth/methods|session|select-tenant|logout`), `magic-link.ts` (`/auth/magic-link/request|verify`), `oauth.ts` (ONE generic `/auth/:provider` + `/callback` over `auth/providers`), `dev-login.ts` (development only), `providers.ts` (linked identities), `cli.ts` (`/auth/cli?redirect_uri=` loopback key hand-off, D26), `helpers.ts` (`completeLogin`, `safeRedirectPath`). Static routes mount BEFORE the generic `/:provider` router.
- `invite.ts` — public `GET /api/invite/:token`, cookie-required `POST /api/invite/:token/accept` (transactional).
- Behind `authMiddleware` (cookie or Bearer): `me.ts`, `tenant.ts` (current tenant + `/settings`), `tenants.ts` (mine; create — multi only), `members.ts`, `invitations.ts` (+ tenant-free `GET /pending`), `keys.ts`, `notifications.ts`, `activity.ts`, `access-requests.ts` (tenant-free), `files.ts` (D23: `POST /api/files?scope=` multipart `file` → 201 `fileSchema`; `GET /:id` streams from R2 with `Cache-Control: private`, `ETag`/304, `inline` only for the avatar MIME allowlist else `attachment`; `DELETE /:id` uploader-or-`delete File`; `avatars` scope writes `users.avatarUrl`; 503 `storage_not_configured` without `FILES`).
- AI (D16/D17/D18), all behind `authMiddleware`; logic in `services/ai/*`, `services/agents/**`, `services/prompts.ts` — routes never import an SDK or read `ai_configs`:
  - `ai-config.ts` → `/api/ai/config`: `GET /` (rows as `aiConfigSchema`, `hasCredential` never the key; `read AiConfig`), `GET /providers` (the `PROVIDERS` catalog + `defaultMaxOutputTokens` — **no shared schema**, the UI parses it permissively), `GET /readiness` (`readiness()` — what the resolvers WOULD pick, no 503), `POST /test` (`testConfig` on a saved `configId` or an inline candidate; rate-limited 10/min/IP; `manage AiConfig`), `POST /` (upsert on `(tenant, scope, label)`; omitted `apiKey` keeps the stored one, a provider change without a key drops it; `isDefault` swaps inside one transaction, the first row in a scope is default; 201 create / 200 update), `DELETE /:id` (204).
  - `ai-prompts.ts` → `/api/ai/prompts`: `GET /`, `GET /:key` (member read), `PUT /:key` / `DELETE /:key` (`manage Prompt`; unknown key → 404 `prompt_not_found`; the registry is code).
  - `ai-usage.ts` → `GET /api/ai/usage/summary?from&to` (`summarizeUsage`, default 30 days, `from >= to` → 400 `invalid_range`; `manage AiConfig`).
  - `ai-agent-models.ts` → `/api/ai/agent-models`: `GET /` (every registry prompt key + assignment + the `effective` pick via `planChat` — the same function `resolveChat` uses), `PUT /:promptKey` (pin `aiConfigId` — tenant-scoped, foreign id → 404 `ai_config_not_found` — and/or `model`), `DELETE /:promptKey` (revert, idempotent 204); writes `manage AiConfig`.
  - `ai-documents.ts` → `/api/ai/documents`: `POST /ingest` (`ingestText` with `c.env.JOBS_QUEUE`; 201 with `status` `indexed` or `pending` when queued; `create Document`), `GET /` (paginated, `?status=`), `POST /search` (`searchChunks` hybrid RRF), `GET /:id`, `DELETE /:id` (owner or `delete Document`; chunks cascade). Raw text and vectors never leave the server.
  - `chat.ts` → `/api/chat`: `GET|POST /conversations` (POST resolves the client FIRST → 503 `ai_not_configured` before any row; freezes `provider`/`model`), `GET|DELETE /conversations/:id`, `POST /conversations/:id/messages` — the ONE SSE route: everything that can fail runs before `streamSSE` (resolve, `resolvePrompt('chat')`, last 40 turns, user-message insert), then frames `event: <type>` / `data: <ChatStreamEvent>` (`message.start → text.delta* → usage → message.end`, or `error`); writes inside the stream use **`streamDatabase(c)`** and are awaited, then `recordUsage`, then `tracer.flush()`. Ownership = `userId` filter on every query (others' threads 404, admins included).
  - `agents.ts` → `/api/agents`: `GET /` (registry), `GET /runs` (paginated; members their own, `isAdminLevel` all), `POST /runs` (`enqueueRun` → 202 + row, `deduplicated: true` when an active exclusive run exists; `?strict=1` → 409 `agent_run_active`; no binding → 503 `agent_runs_not_configured`), `GET /runs/:id` (`reconcileRun` against `instance.status()` then row + `events`), `POST /runs/:id/cancel` (`requestCancel`, cooperative). The route never runs the agent.
- `analytics-pages.ts` (D19, mounted at `/api/analytics` behind `authMiddleware`): `GET /pages` (ensures the tenant's template pages exist, then lists — `{ items }`, not paginated), `POST /pages` + `PATCH|DELETE /pages/:id` + `POST /pages/:id/reset` (`manage Dashboard`, admin+; template pages cannot be deleted → 403 `template_page`; reset on a user page → 400 `not_a_template_page`), `GET /pages/:id`, `GET /templates`, `POST /templates/recreate` (admin+), `GET /facts/status` (admin+, fact-table freshness). Logic in `services/dashboard-templates.ts` + `services/fact-tables/`.
- `cube-api.ts` (D19): ONE router mounted at BOTH `/cubejs-api` and `/mcp` behind `authMiddleware`; builds a drizzle-cube `createCubeApp` per request over `c.get('db')` with `extractSecurityContext` from `cubes/security.ts` and forwards `c.req.raw` (the adapter registers absolute paths: `/cubejs-api/v1/{load,meta,sql,batch,dry-run}`, `/mcp`). Guard: `read Analytics` (every member). Row scoping is inside every cube — `cubes/CLAUDE.md`.
- `ws.ts` — `GET /ws?tenantId=`, mounted WITHOUT `authMiddleware` (a browser cannot set headers on an upgrade): resolves the cookie via `resolveCookieAuth`, checks membership in the requested tenant, forwards to `NOTIFICATIONS_HUB.idFromName(tenantId)` with `X-Tenant-Id/X-User-Id/X-Session-Id`. Not an upgrade → 426 `upgrade_required`; no cookie → 401; no membership → 403; suspended → 403 `tenant_suspended`.
- Behind `globalAdminMiddleware`: `admin.ts` — the only cross-tenant surface; logic in `services/admin.ts`.
- Guard list, per mount: public — `health`, `/auth/*`, `GET /api/invite/:token`; `globalAdminMiddleware` — `/api/admin/*`; cookie-resolved — `/ws`; `authMiddleware` — every other `/api/*`, `/cubejs-api`, `/mcp`. Inside: `guardPermission(c, 'read', 'Analytics')` on every cube request (`cube-api.ts`), `manage Dashboard` on every `/api/analytics` write, `isAdminLevel(auth)` on `/api/analytics/facts/status`; `GET /api/analytics/{pages,pages/:id,templates}` are membership only.
- Logic lives in `services/{auth,tenants,members,invitations,admin,notifications,activity,email,jobs,realtime,storage,prompts,dashboard-templates}.ts`, `services/ai/*`, `services/agents/**`, `services/fact-tables/**` (D19: registry-driven refresh + freshness — the `:15` cron and the two `db:*-facts` scripts share it); routes validate → authorise → call a service → respond. `cubes/security.ts` (`extractSecurityContext`) is the only bridge from `c.get('auth')` into cube SQL; `utils/db/tenant-helpers.ts` `onTenantCreated` is the post-commit tenant hook (seeds template dashboards, best-effort). `services/jobs.ts` (`enqueueJob`) and `services/realtime.ts` (`nudge*`) are the only paths to `JOBS_QUEUE` and `NOTIFICATIONS_HUB`; `services/ai/resolve.ts` the only path to `ai_configs` / `agent_models` / the `AI` binding; `services/agents/runs.ts` the only path to `AGENT_RUN_WORKFLOW`. Consumers are in `../queues/`, the DO in `../durable-objects/`, the Workflow class in `../workflows/`.

## Rules

- `createRouter()` from `utils/routes/router.ts` — never `new Hono()` (D13). It gives `c.get('config' | 'db' | 'logger' | 'requestId')` types.
- Request contracts are zod schemas in `packages/shared/src/` (`@gmgo/shared/<module>`; UI and CLI import them too). Validate with `validate('json' | 'query' | 'param', schema)` from `utils/routes/validate.ts`; a bad input becomes the shared 400 envelope with `code: 'validation_failed'`.
- Read config via `c.get('config')`, never `c.env` (D3). Bindings are passed INTO services from the route, never read inside them: `c.env.JOBS_QUEUE` → `createInvitation(db, cfg, logger, jobs, …)`, `c.env.FILES` → `createR2Storage(...)`; `NOTIFICATIONS_HUB` only ever via the `realtime` that `withAuth` returns.
- Body limits: the global `jsonBodyLimit` (1 MB) skips `/api/files` (`isUploadPath`); `files.ts` mounts `uploadBodyLimit` (`MAX_UPLOAD_BYTES + 64 KB`) on its `POST` and enforces the exact 5 MB per file (413 `payload_too_large`) and the avatar allowlist (415 `unsupported_media_type`) itself. A new upload route must do the same two things — the transport cap is not the per-file limit.
- Throw typed errors from `utils/core/errors.ts` (`NotFoundError`, `ForbiddenError`, ...). Do not hand-roll `c.json({ error }, 4xx)`; `middleware/error-handler.ts` owns the envelope `{ error, statusCode, code?, details? }`.
- Success bodies are bare domain objects (no envelope). Lists use `paginatedResponse(item)` from `@gmgo/shared/pagination` → `{ items, pagination: { page, pageSize, total, totalPages } }`.
- Auth is applied AT THE MOUNT in `index.ts` (`app.use('/api/x/*', authMiddleware); app.route('/api/x', xRouter)`), never inside a route file. Every tenant-scoped query carries `eq(table.tenantId, tenantId)` from the auth context — never from the body/query.
- Side effects that may outlive the response (activity writes, realtime nudges, the tracer flush) go through `defer(...)` from `withAuth` (= `c.executionCtx.waitUntil`, awaited inline when there is no ExecutionContext); a detached promise is killed when the response ends. **Inside an SSE stream there is no `defer`**: the request's `db` is already closing in `waitUntil` once `streamSSE` returned the Response, so open `streamDatabase(c)` (`utils/routes/route-helpers.ts`), await every write and `tracer.flush()`, and `close()` it in the stream's `finally` (`chat.ts`).
- Routes enqueue, never run: anything longer than a request is a queue message or a Workflow (D7). Transactional emails are `email.send` jobs (`enqueueJob(c.env.JOBS_QUEUE, …)` inside the service) — except the magic link, which stays inline because a person is waiting on it.
- Realtime (D8): services `nudge(realtime, realtimeEvent('member.changed', tenantId, { id }))`; the route only passes `realtime` through. Emit after the transaction commits.

## Route anatomy

```ts
router.post('/', validate('json', createThingSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c) // throws 401 / 403 no_tenant|pending_approval
  guardPermission(c, 'create', 'Thing')
  const [row] = await db.insert(things).values({ ...c.req.valid('json'), tenantId }).returning()
  defer(() => recordActivity(db, { tenantId, userId: user.id, type: 'thing.created', subjectType: 'Thing', subjectId: row.id }))
  return c.json(row, 201)
})
```

`withAuth(c)` is the tenant-free variant (`tenantId: string | null`) for invite accept, pending
invitations, access requests and `/api/admin/*`. Both also return `cfg`, `logger`, `realtime`
(`{ defer, env }` — hand it to a service that nudges) and `tracer` (D16 — the request's Langfuse
batcher or `noopTracer`, for `withAgentTrace` / `traceChatClient`). `requireMultiTenant(cfg)` → 404
`tenancy_mode_single`. `uuidParam(c, 'id')` → 404 for a non-UUID `:id` (never a DB error).
`streamDatabase(c)` → a second `{ db, close }` for the body of an SSE stream.

New endpoint checklist: schema in `packages/shared/src/` → `validate(...)` → auth seam + permission
guard → tenant-scoped query → tests in `tests/api/` → update this file if a new router appears.

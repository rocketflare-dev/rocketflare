---
globs:
  - apps/web/src/api/**
  - apps/web/src/worker.ts
  - apps/web/src/config.ts
  - packages/shared/src/**
---

# API Patterns

Hono app assembled in `apps/web/src/api/index.ts` (exports `app` only). `apps/web/src/worker.ts` is the Worker entry:
`export default { fetch, queue, scheduled }` plus the DO/Workflow class exports. Keeping the classes
out of `api/index.ts` is what lets tests drive `app.request(req, env, ctx)` under Node.

## Middleware order (do not reorder casually — 04 §10)

1. `app.onError(errorHandler)` / `app.notFound` — every failure below, including config validation, gets the JSON envelope
2. `requestLogger` (hono-pino) — request id exists for everything after
3. `configMiddleware` — `loadConfig(c.env)`; everything below reads `c.get('config')`, **never `c.env` for config**
4. `securityHeaders` — after `next()`; **returns a 101 untouched** (the DO's upgrade response has immutable headers; re-wrapping it drops the socket)
5. `jsonBodyLimit` (1 MB) on `/api/*` and `/auth/*` — **skipped for `/api/files`** (`isUploadPath`); the upload route mounts `uploadBodyLimit` (`MAX_UPLOAD_BYTES + 64 KB` multipart overhead) on its own `POST` and enforces the exact per-file cap in the handler
6. `cors` — before CSRF so preflights are answered; **bypassed for WebSocket upgrades** (`Upgrade: websocket` — CORS does not govern the handshake, the route checks membership)
7. `csrf` — cookie-only, no DB, cheap rejection (GET `/ws` is a safe method, no exemption needed)
8. `databaseMiddleware` — per-request postgres.js client, `c.executionCtx.waitUntil(close())`
9. `langfuseFlush` (optional) — brackets exactly the handler's spans
10. Mounts: `/api/health|ready` public → `/auth` (rate-limited login routes) → `/api/invite` public → `/api/admin/*` behind `globalAdminMiddleware` → `/ws` (no `authMiddleware`: a browser cannot set headers on an upgrade, so `routes/ws.ts` resolves the cookie itself) → every other `/api/*` (incl. `/api/files`) with `authMiddleware` at the mount → `/cubejs-api`, `/mcp` behind `authMiddleware` → `app.all('*')` ASSETS catch-all with a 404 guard for `/api|/auth|/cubejs-api|/mcp|/ws`

Auth is per-mount, not global: the public surface is enumerable and small.

## Routes are thin

- `createRouter()` (`apps/web/src/api/utils/routes/router.ts`) — never `new Hono()` bare; no `declare module 'hono'` augmentation
- Validate with `validate('json'|'query'|'param', schema)` (`apps/web/src/api/utils/routes/validate.ts`, a zValidator wrapper) using schemas from `@gmgo/shared/<module>` (`packages/shared/src/`); its hook throws `ValidationError` so a 400 uses the shared envelope `{ error, statusCode, code?, details? }` — never call `zValidator` directly
- `const { db, tenantId, user, cfg, logger, defer, realtime } = withAuthAndDb(c)` is the **only** way to read auth in a route (`withAuth(c)` is the tenant-free variant, `tenantId: string | null`). Never `c.get('auth'|'session'|'db')` by hand. `defer(fn)` runs a side effect through `waitUntil` (awaited inline when there is no ExecutionContext) and logs instead of throwing; `realtime` (`{ defer, env }`) is what you hand to a service so it can `nudge` (D8) — routes never touch `NOTIFICATIONS_HUB`. Bindings a service needs (`c.env.JOBS_QUEUE`, `c.env.FILES`) are passed from the route as arguments
- Authorise with `guardPermission(c, action, subject)` (CASL, `apps/web/src/api/middleware/permissions.ts`) — throws `UnauthorizedError`/`ForbiddenError` and returns the `AuthContext`; `can(c, …)` for branching. Owner-only actions (delete tenant, transfer ownership) use `guardOwner(c)` / `isOwnerLevel(auth)` — an explicit `role === 'owner'` check, never `manage Tenant`
- Every query filters by `tenantId` from the auth context — see `.claude/rules/database.md`
- Throw typed errors from `apps/web/src/api/utils/core/errors.ts` (`NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError`, …); never `c.json({ error }, 4xx)` by hand
- Pagination: `paginationQuerySchema` → `{ items, pagination: { page, pageSize, total, totalPages } }` (`packages/shared/src/pagination.ts`)
- `TENANCY_MODE=single` (D25): routes that only make sense multi-tenant (`create-org`, `delete-org`, `/select-tenant`, `/admin/tenants` list) return 404 `tenancy_mode_single`; use the `requireMultiTenant` helper, don't inline the check

## Contracts live in `packages/shared` (`@gmgo/shared`)

A new or changed API surface starts as a zod schema in `packages/shared/src/<module>.ts`, exported
from `index.ts`, imported as `@gmgo/shared/<module>` by the route (`validate()`), the UI
(`api.get(..., { schema })`) and the CLI (`apps/cli/src/api.ts`). Response shapes, request bodies,
query params, the error envelope and pagination all come from there; never define a response type in
a route file. `packages/shared` is **private** (`"private": true`, no `publishConfig`) and imports
only `zod`, its siblings and type-only `@casl/ability` — never `apps/web` or `apps/cli`. Adding a
route the CLI should call means adding the schema first, then the route, then the CLI command.

### `GET /auth/cli` (D26) — the CLI login handoff (`apps/web/src/api/routes/auth/cli.ts`)

`GET /auth/cli?redirect_uri=http://127.0.0.1:<port>/callback&hostname=<machine>`. `redirect_uri`
must be exactly `http://127.0.0.1:<port>/callback` or `http://localhost:<port>/callback` (any port,
`http:` only, no query/hash/userinfo) — `validateCliRedirectUri`; anything else is a 400
`invalid_redirect_uri`. That allowlist is what makes handing a key over in a query string acceptable.
No session → 302 `/login?returnUrl=<this url>`; session without a tenant → 302 `/select-tenant?returnUrl=`
(skipped in `TENANCY_MODE=single`). Then `mintApiKey` (the same helper `POST /api/keys` uses) creates a
tenant key named `cli:<sanitised hostname>` with scopes `['*']`, records `api_key.created`
(`via: 'cli'`) in `waitUntil`, and 302s to `redirect_uri?key=&tenant_id=&tenant_name=`. The plaintext
is never logged and is shown once; the CLI stores it. The server never redirects with `?error=` —
failures surface as the JSON envelope on this route.

## Services

Plain modules, signature `(db, cfg, logger, …args)` — dependencies are passed, never imported as
process globals. No service reads `c.env`, `process.env` or a module-level `config`. A service that
needs a binding (KV, Queue, R2, AI) takes it as a parameter typed from `Cloudflare.Env`. The two
Phase 2 shapes: services that **queue** take the binding after the logger —
`createInvitation(db, cfg, logger, jobs, input)`, `decideAccessRequest(db, cfg, logger, jobs,
input)` (`jobs: JobsQueue`, a structural slice so tests pass a `RecordingQueue`); services that
**nudge** take `realtime?: Realtime` as a trailing optional parameter (`updateTenant(db, tenantId,
patch, realtime?)`, `notify(db, input, realtime?)`) or inside their `input` (`changeMemberRole`,
`removeMember`, `acceptInvitation`). Storage routes build the seam themselves:
`createR2Storage(c.env.FILES)` → `StorageService`, 503 `storage_not_configured` without the binding.

## Config

`apps/web/src/config.ts`: one zod schema over `Cloudflare.Env`, `loadConfig(env)` memoised per isolate by env
identity, called at the top of `fetch`, `queue` and `scheduled`. `APP_ENV` (`development | staging |
production`) is the environment discriminator — `NODE_ENV` is a Node concept and exists only in test
scripts. **`process.env` is forbidden in `apps/web/src/`** (the compat flag would populate it from `[vars]`,
but that hides the binding dependency and is dead in tests).

## Background work: enqueue, never run

A route never runs long work. Rule (05 §1.4):

| Work | Use | How |
|---|---|---|
| fire-and-forget, < 30 s total | `JOBS_QUEUE` | producer `enqueueJob(queue, input)` / `enqueueJobs` in `apps/web/src/api/services/jobs.ts` (validates `jobInputSchema` from `@gmgo/shared/jobs`, stamps `{ id, enqueuedAt }`); consumer `processJobsBatch(batch, { env, config, logger })` in `apps/web/src/api/queues/jobs.ts` dispatching on `type` to `queues/handlers/*`; `apps/web/src/api/queue.ts` routes `batch.queue` by prefix (`isJobsQueue`) |
| multi-step, retries, minutes+ (agent runs) | `AGENT_RUN_WORKFLOW` (Phase 3) | deterministic instance id `<kind>:<tenant>:<subject>`; DB row is the claim (`UPDATE … WHERE status IN (queued,running) RETURNING`) |
| periodic | `[triggers] crons` | `apps/web/src/api/scheduled.ts` dispatches on `event.cron`; each task try/caught |

Jobs rules (D7):

- **Adding a job type** = a variant in `jobInputSchema` + `jobEnvelopeSchema` and `JOB_TYPES`
  (`packages/shared/src/jobs.ts`) + one entry in the `handlers` table of `queues/jobs.ts` + a
  `queues/handlers/<name>.ts` (copy `example-ping.ts`). The `type` string is the version seam: a
  breaking payload change is a new type (`email.send.v2`), never an edited schema
- Handler signature `(job: JobOf<'x'>, ctx: { env, config, logger, db })`; each message gets its
  own DB client, closed in `finally`. **Never `waitUntil` in a consumer — await everything**; a
  handler that throws is retried, one that returns is acked
- Poison policy: an envelope that fails `jobEnvelopeSchema` is logged and **`ack()`ed** (retrying
  cannot make it valid). Handler error → `retry({ delaySeconds: backoffSeconds(attempts) })`, 30 s
  doubling to a 15 min cap; the toml's `max_retries = 3` ends it. Unknown queue → `ackAll()`
- Missing `JOBS_QUEUE` → `JobsQueueNotConfiguredError`, never a silent inline fallback. Queued in
  the kit: invitation (create/bulk/resend) and access-request-decided emails. The **magic-link email
  stays inline** — a person is waiting on it
- `example.ping` is the smoke job: `enqueueJob(c.env.JOBS_QUEUE, { type: 'example.ping', payload: { tenantId } })` from any route, then watch `wrangler dev`

Side effects that can outlive the response (email, tracing flush, DO nudge, `sql.end()`) go in
`c.executionCtx.waitUntil(...)` — in routes via `defer()` from `withAuth` — never awaited inline and
never dropped on the floor.

## Realtime (D8)

Routes never touch `NOTIFICATIONS_HUB` directly. `apps/web/src/api/services/realtime.ts` is the
**only** caller: `nudge(realtime, event)` (tenant-wide), `nudgeUser(realtime, userId, event)`,
`nudgeUsers(realtime, userIds, event)`, over a `Broadcaster` seam whose one implementation is
`createHubBroadcaster(env)` → `idFromName(tenantId)` → typed RPC stub (`broadcast`,
`broadcastToUser`, `broadcastToUsers` → `{ delivered }`). `realtime` is the `Realtime` (`{ defer,
env }`) returned by `withAuth()`; every nudge goes through `defer`/`waitUntil`, is never awaited on
the response path and is a no-op without the binding. Build events with
`realtimeEvent(type, tenantId, payload?)`; types and the query-key invalidation map
(`REALTIME_INVALIDATIONS`) live in `@gmgo/shared/realtime` — add a type there, not in a route. The
payload is a nudge (`{ id }` or `{ entity, id }` for `entity.changed`); the client re-queries. "DB is
the truth, WebSocket is a nudge." Emit **after** the transaction commits (`acceptInvitation` defers
its two nudges past the `db.transaction`).

`GET /ws` (`routes/ws.ts`): not an upgrade → 426 `upgrade_required`; no cookie → 401; not a member
of `?tenantId` (or the session tenant) → 403; suspended → 403 `tenant_suspended`; else forward to the
tenant's DO stub with `X-Tenant-Id` / `X-User-Id` / `X-Session-Id`. The DO trusts those headers
**only** because it is reachable solely through the binding — never expose it another way.

## Workers runtime

`nodejs_compat` is on, but the request path must stay free of Node-only APIs: no `pg`, `ws`,
`node:fs`, `node:child_process`, `pg-boss`, `@opentelemetry/sdk-node`. `Buffer`, `AsyncLocalStorage`
and `node:crypto` hashing work but prefer WebCrypto/`TextEncoder`. `pnpm build:api` (dry-run bundle)
catches what `tsc` cannot — see `.claude/rules/cloudflare.md`.

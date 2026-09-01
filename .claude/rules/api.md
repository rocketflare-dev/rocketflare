---
globs:
  - src/api/**
  - src/worker.ts
  - src/config.ts
---

# API Patterns

Hono app assembled in `src/api/index.ts` (exports `app` only). `src/worker.ts` is the Worker entry:
`export default { fetch, queue, scheduled }` plus the DO/Workflow class exports. Keeping the classes
out of `api/index.ts` is what lets tests drive `app.request(req, env, ctx)` under Node.

## Middleware order (do not reorder casually — 04 §10)

1. `app.onError(errorHandler)` / `app.notFound` — every failure below, including config validation, gets the JSON envelope
2. `requestLogger` (hono-pino) — request id exists for everything after
3. `configMiddleware` — `loadConfig(c.env)`; everything below reads `c.get('config')`, **never `c.env` for config**
4. `securityHeaders`
5. `bodyLimit` on `/api/*` and `/auth/*`
6. `cors` — before CSRF so preflights are answered
7. `csrf` — cookie-only, no DB, cheap rejection
8. `databaseMiddleware` — per-request postgres.js client, `c.executionCtx.waitUntil(close())`
9. `langfuseFlush` (optional) — brackets exactly the handler's spans
10. Mounts: `/api/health|ready` public → `/auth` (rate-limited login routes) → `/api/invite` public → `/api/admin/*` behind `globalAdminMiddleware` → every other `/api/*` with `authMiddleware` at the mount → `/cubejs-api`, `/mcp` behind `authMiddleware` → `app.all('*')` ASSETS catch-all with a 404 guard for `/api|/auth|/cubejs-api|/mcp`

Auth is per-mount, not global: the public surface is enumerable and small.

## Routes are thin

- `createRouter()` (`src/api/utils/routes/router.ts`) — never `new Hono()` bare; no `declare module 'hono'` augmentation
- Validate with `validate('json'|'query'|'param', schema)` (`src/api/utils/routes/validate.ts`, a zValidator wrapper) using schemas from `src/shared/`; its hook throws `ValidationError` so a 400 uses the shared envelope `{ error, statusCode, code?, details? }` — never call `zValidator` directly
- `withAuthAndDb(c, ({ tenantId, user, db, scoped }) => …)` is the **only** way to read auth in a route. Never `c.get('auth'|'session'|'db')` by hand. Handlers may return a plain object; it is wrapped in `c.json`
- Authorise with `guardPermission(c, action, subject)` (CASL, `src/permissions/`) — returns a Response to bubble up, or null. Owner-only actions (delete tenant, transfer ownership) additionally check `role === 'owner'` explicitly
- Every query filters by `tenantId` from the auth context — see `.claude/rules/database.md`
- Throw typed errors from `src/api/utils/core/errors.ts` (`NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError`, …); never `c.json({ error }, 4xx)` by hand
- Pagination: `paginationQuerySchema` → `{ items, pagination: { page, pageSize, total, totalPages } }` (`src/shared/pagination.ts`)
- `TENANCY_MODE=single` (D25): routes that only make sense multi-tenant (`create-org`, `delete-org`, `/select-tenant`, `/admin/tenants` list) return 404 `tenancy_mode_single`; use the `requireMultiTenant` helper, don't inline the check

## Services

Plain modules, signature `(db, cfg, logger, …args)` — dependencies are passed, never imported as
process globals. No service reads `c.env`, `process.env` or a module-level `config`. A service that
needs a binding (KV, Queue, R2, AI) takes it as a parameter typed from `Cloudflare.Env`.

## Config

`src/config.ts`: one zod schema over `Cloudflare.Env`, `loadConfig(env)` memoised per isolate by env
identity, called at the top of `fetch`, `queue` and `scheduled`. `APP_ENV` (`development | staging |
production`) is the environment discriminator — `NODE_ENV` is a Node concept and exists only in test
scripts. **`process.env` is forbidden in `src/`** (the compat flag would populate it from `[vars]`,
but that hides the binding dependency and is dead in tests).

## Background work: enqueue, never run

A route never runs long work. Rule (05 §1.4):

| Work | Use | How |
|---|---|---|
| fire-and-forget, < 30 s total | `JOBS_QUEUE` | typed producer helper in `src/api/services/*/queue.ts`; consumer is a plain `(batch, env)` function switched on `batch.queue` in `src/api/queue.ts` |
| multi-step, retries, minutes+ (agent runs) | `AGENT_RUN_WORKFLOW` | deterministic instance id `<kind>:<tenant>:<subject>`; DB row is the claim (`UPDATE … WHERE status IN (queued,running) RETURNING`) |
| periodic | `[triggers] crons` | `src/api/scheduled.ts` dispatches on `event.cron`; each task try/caught |

Side effects that can outlive the response (email, tracing flush, DO nudge, `sql.end()`) go in
`c.executionCtx.waitUntil(...)`, never awaited inline and never dropped on the floor.

## Realtime

Routes never touch `NOTIFICATIONS_HUB` directly. `services/notification.ts` (`broadcastDataEvent`,
`broadcastInvitationEvent`) is the seam; the payload is a nudge (`{ entity, id }`) and the client
re-queries. "DB is the truth, WebSocket is a nudge."

## Workers runtime

`nodejs_compat` is on, but the request path must stay free of Node-only APIs: no `pg`, `ws`,
`node:fs`, `node:child_process`, `pg-boss`, `@opentelemetry/sdk-node`. `Buffer`, `AsyncLocalStorage`
and `node:crypto` hashing work but prefer WebCrypto/`TextEncoder`. `pnpm build:api` (dry-run bundle)
catches what `tsc` cannot — see `.claude/rules/cloudflare.md`.

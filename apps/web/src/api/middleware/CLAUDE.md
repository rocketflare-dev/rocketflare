# Middleware

Applied globally in `src/api/index.ts` in THIS order (04 §10). Each step needs what the earlier
ones set; reordering silently breaks something.

| # | File | Sets / does | Why here |
|---|------|-------------|----------|
| 1 | `error-handler.ts` | `app.onError` + `app.notFound` → shared envelope `{ error, statusCode, code?, details? }` | Registered first so even a config failure gets the envelope |
| 2 | `request-logger.ts` | `requestId`, `logger` (hono-pino) | Every later log line, including config errors, has a request id. The one middleware that runs before config, so it calls `loadConfig` itself and falls back to `info` |
| 3 | `config.ts` | `config` = `loadConfig(c.env)` (D3) | Everything below reads `c.get('config')`, never `c.env` |
| 4 | `security-headers.ts` | Headers after `next()`; **a 101 is returned untouched** (the DO's upgrade response has immutable headers; re-wrapping drops the socket) | Early so 4xx/5xx from later middleware are covered too |
| 5 | `body-limit.ts` | `jsonBodyLimit` 1 MB on `/api/*`, `/auth/*` → 413 `payload_too_large`; **skipped for `/api/files`** (`isUploadPath`, `UPLOAD_PATHS`) — `routes/files.ts` mounts `uploadBodyLimit` (`MAX_UPLOAD_BYTES + 64 KB` multipart overhead) on its `POST` and enforces the exact per-file cap in the handler | Before any parsing or DB work; the upload cap is per route so one route's multipart need does not lift the JSON cap everywhere |
| 6 | `cors.ts` | Function origin from `config.APP_URL` (+ dev origins outside production); **bypassed when `Upgrade: websocket`** (`isWebSocketUpgrade`) — CORS does not govern the handshake and `cors()` would try to set headers on the immutable 101 | Must answer preflights BEFORE csrf can reject them |
| 7 | `csrf.ts` | Origin/Referer/Sec-Fetch-Site check for cookie-authed unsafe methods → 403 `csrf_failed` | Cookie-only, no DB: cheap rejection before we open a client |
| 8 | `database.ts` | `db` per request (D2), closed in `waitUntil` | Last global: first thing with real cost |
| — | `auth.ts` | `authMiddleware` (cookie `__Host-session` OR `Authorization: Bearer <api key>` → `auth: AuthContext`; ONE LATERAL query; sliding expiry via `waitUntil`) and `globalAdminMiddleware` (cookie + `isGlobalAdmin`, tenant-free); `resolveCookieAuth(c)` is the exported cookie half that `routes/ws.ts` calls itself | Applied PER MOUNT in `index.ts`, never inside route files: the public surface (health, `/auth/*`, `/api/invite/:token`, `/ws` — which cannot carry headers and so authenticates inline) is enumerable and small |
| — | `permissions.ts` | `guardPermission` / `can` / `guardOwner` / `isAdminLevel` over `auth.ability` | Called inside handlers after `withAuthAndDb(c)` |
| — | `rate-limit.ts` | `authRateLimit` (KV sliding window, 10/min/IP, no-op without `RATE_LIMIT_KV`), `operationLock(kv, key, fn)` per-tenant mutex | Mounted on login-shaped routes in `routes/auth/index.ts` and on invite accept in `index.ts` |

Auth codes (envelopes): 401 `unauthorized` · 403 `blocked` · 403 `tenant_suspended` (middleware) · 403 `no_tenant` / `pending_approval` (thrown by `withAuthAndDb` when a valid session has no membership, so tenant-free routes using `withAuth` keep working) · 404 `tenancy_mode_single` (`requireMultiTenant`).

Constraints:
- Nothing in `src/` reads `process.env` or imports `node:*`. Bindings live on `c.env`; config on `c.get('config')`.
- Errors are THROWN (`utils/core/errors.ts`), never hand-rolled `c.json({ error })`; `error-handler.ts` is the single place they become responses.
- Anything trusting `c.get('auth').tenantId` is safe; anything reading tenant ids from the request body/query is not.

## Adding one

1. `export const xMiddleware = createMiddleware<AppEnv>(async (c, next) => { ... })` — typed via `AppEnv`, never a bare `Context`.
2. Add a `Variables` field to `src/api/types.ts` if it sets context.
3. Insert it in `src/api/index.ts` at the step whose inputs it needs, update the table above, and add a test in `tests/api/`.

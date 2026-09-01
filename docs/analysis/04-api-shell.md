# 04 — The Hono API shell

Everything between "request arrives" and "route handler runs", plus the route/contract
conventions the handlers follow. Sources:

- **Mirevue** (`~/work/mirevue`) — Node + `@hono/node-server`, Postgres via `pg`, structural reference.
- **GuideMode server** (`~/work/guidemode/apps/server`) — Cloudflare Workers, Hyperdrive→Neon, KV,
  Queues, Workflows, cross-script DO, Static Assets; the CF substrate reference.

Verdict up front: **Mirevue's shell is the better-designed one and should be the structural
base for almost every file; GM supplies the Worker entry shape, the `Bindings` typing discipline,
the ASSETS catch-all, the KV rate limiter, `waitUntil` fire-and-forget, and the fetch-based
Langfuse client.** Mirevue's shell is clean but Node-shaped in exactly the places that matter
for Workers: a process-wide `pg.Pool` singleton, `AsyncLocalStorage`-based tenant scoping,
module-load-time `process.env` validation, `pino` with a `pino-pretty` transport, and OTel
`NodeSDK` for tracing. Each has a Workers-safe replacement described below.

---

## 1. App assembly

### Mirevue — `src/api/index.ts` + `src/server.ts`

- `src/api/index.ts:54` builds an **untyped** `new Hono()`; typing of `c.get('db'|'env'|'auth'|
  'session'|'ability')` comes from `declare module 'hono' { interface ContextVariableMap }`
  augmentations spread across the middleware files (`middleware/auth.ts:14-20`,
  `middleware/database.ts:8-12`, `middleware/env.ts:5-9`).
- Order (`index.ts:57-75`): `app.onError(errorHandler)` → `pinoLogger` (production only) →
  `securityHeadersMiddleware` → `envMiddleware` → `databaseMiddleware` → `csrfProtectionMiddleware`
  → `cors({ origin: [config.APP_URL, 'http://localhost:3000'], credentials: true })`.
- Mounting (`index.ts:78-179`): public `/api/health`+`/api/ready` (`routes/health.ts`), public
  `/auth`, public `/api/invite`; `/api/admin/*` behind `globalAdminMiddleware` (tenant-free
  cross-tenant surface); every other prefix is the two-line pair
  `app.use('/api/x/*', authMiddleware); app.route('/api/x', xRouter)`. Auth is applied **per
  prefix at mount time**, never inside route files. ~40 routers; several share one prefix
  (`/api/workshop-sessions` has 15 routers mounted on it, `index.ts:147-161`).
- **No `notFound` handler** in either repo; Hono's default text 404 is what an unmatched `/api/*`
  gets in dev. Mirevue's prod SPA fallback (`server.ts:56-70`) hand-rolls a JSON 404 for
  `/api|/auth|/ws|/models` prefixes before serving `index.html`.
- `src/server.ts` is the Node bootstrap: `initLangfuse` (L19), `serveStatic` mounts for
  `/models`, `/ort`, `/vad` (L27-47), prod-only `serveStatic('./dist/ui')` + SPA fallback via
  `readFileSync('./dist/ui/index.html')` (L52-71), `serve({ fetch: app.fetch, port })` (L73),
  WebSocket upgrade attached to the raw `http.Server` (L89), pg-boss agent workers started
  **only here, never on import** (L96), SIGTERM/SIGINT graceful shutdown with a 10s force-exit
  timer (L100-133). None of this file survives into a Worker; its *responsibilities* map onto
  `export default { fetch, queue, scheduled }` + the ASSETS catch-all.

### GM — `src/api/index.ts` is the Worker entry (`wrangler.toml:2 main = "src/api/index.ts"`)

- `new Hono<{ Bindings: CloudflareEnv }>()` (`index.ts:74`) — the only typed piece; `Variables`
  are still module augmentation.
- Order (`index.ts:77-154`): `onError` → **once-per-isolate AI adapter + Langfuse init**
  guarded by a module `let aiModelsInitialized` (L80-121) → a **Langfuse flush middleware**
  that does `await next(); c.executionCtx.waitUntil(tracer.flush())` (L124-130) → `pinoLogger`
  (production only, gated on `process.env.NODE_ENV`, L133-135) → security headers → env →
  database → csrf → `cors` with a **function origin** reading `c.env.APP_URL` (L141-154).
- Health is inline: `app.get('/health', …)` (L157-159) — no DB readiness probe. Mirevue's
  `/api/health` + `/api/ready` (SELECT 1) pair is better and should be kept **under `/api/`** so
  it can never collide with an SPA route.
- Mounting is the same per-prefix `use+route` pair (L184-338), plus **webhook routers with no
  auth middleware** (signature verification inside, L166-178), a public token-is-the-auth
  survey route (L302), and two admin surfaces stacked `authMiddleware` → `requireGlobalAdmin`
  (L331-333). A few routers apply auth internally ("auth middleware applied inside router",
  L169, 195) — inconsistent; the kit should forbid this and keep auth at the mount.
- A **sub-app per request** for drizzle-cube (`cubeApiApp`, L343-515) that rebuilds
  `createCubeApp(...)` on every request and forwards `c.req.raw`. Out of scope for the kit
  (analytics), but it is the pattern for "third-party Hono app that needs per-request env".
- **SPA via Static Assets** (`index.ts:524-543`, `wrangler.toml [assets]`): hashed files are served
  by the assets layer *before* the Worker runs (`run_worker_first` is not set); only navigations
  reach `app.all('*')`, which 404s anything under `/api/`, `/auth/`, `/cubejs-api/`, `/mcp` and
  otherwise does `return c.env.ASSETS.fetch(c.req.raw)`; `not_found_handling =
  "single-page-application"` makes the binding return `index.html`. Falls back to 404 when
  `ASSETS` is unbound (Vite dev). **This is the kit's SPA strategy.**
- `queueHandler` (L545-712) dispatches on `batch.queue` name to a per-queue consumer, builds
  `db`/`r2`/`kv` from `env` itself, and passes `{ env }` down into `NotificationService.*`
  (L612, 635, 653). `scheduled` is a separate file (`src/scheduled.ts`) gated by hour-of-day
  inside one handler over 8 crons (`wrangler.toml [triggers]`).
- `export default { fetch: app.fetch, queue: queueHandler, scheduled: scheduledHandler.scheduled }`
  (L721-725) + named `export { …Workflow }` classes (L733-743). The DO class is deliberately
  **not** exported from this script (cross-script binding, L727-731) so preview URLs keep working.
  Named `export { app }` (L715) exists so tests can `app.request(...)` without the Worker wrapper.

**Base for the kit:** Mirevue's `index.ts` layout and comments; GM's Worker export shape,
typed `Hono<AppEnv>`, ASSETS catch-all and the `waitUntil` flush middleware. Strip: the
once-per-isolate AI init middleware (move to a lazy resolver, §9), drizzle-cube, webhooks,
survey-only, every product router.

---

## 2. Hono typing: `Bindings` / `Variables` / `wrangler types`

- GM types bindings by hand in `src/types/env.ts:18-73` (`CloudflareEnv`, every field
  **optional**), *and* `wrangler types` generates `worker-configuration.d.ts` with
  `interface __BaseEnv_Env { RATE_LIMIT_KV: KVNamespace; HYPERDRIVE: Hyperdrive; ASSETS:
  Fetcher; … }` and `declare namespace Cloudflare { interface Env extends __BaseEnv_Env {} }`
  (`worker-configuration.d.ts:4-97`). `build` runs `wrangler types` first (`package.json`
  "build"). GM never uses the generated `Env`; it only leans on the ambient runtime types
  (`KVNamespace`, `Workflow<T>`, …). Result: **three** overlapping env shapes — `CloudflareEnv`,
  `middleware/env.ts:5-92 interface Env` (a second hand-written copy, with `any` for every
  binding), and the generated one — plus a `c.get('env')` object rebuilt per request
  (`env.ts:107-201`) that must list every binding or it is silently `undefined`
  (the comment at `env.ts:180-185` records a real bug from exactly that).
- Mirevue has no `Bindings` at all; `c.get('env')` is the zod `AppConfig` singleton
  (`middleware/env.ts:11-14`).

**Recommendation for the kit**

```ts
// src/api/types.ts
export type AppBindings = Cloudflare.Env          // from `wrangler types`, single source of truth
export type AppVariables = { config: AppConfig; db: Database; auth?: AuthContext;
                             session?: SessionContext; ability?: AppAbility; requestId: string;
                             logger: Logger }
export type AppEnv = { Bindings: AppBindings; Variables: AppVariables }
export type AppContext = Context<AppEnv>
```

- Every `new Hono<AppEnv>()` (app *and* routers). Delete `declare module 'hono'` augmentation —
  it makes `c.get('db')` typed on **every** Hono instance in the process including third-party
  ones, and it is what let Mirevue and GM's shells look "untyped" yet compile.
- `wrangler types` in `predev`/`prebuild`, `worker-configuration.d.ts` committed (GM does this).
  Secrets are declared as `string` in the generated `Env` only if present in `.dev.vars`; keep
  a `.dev.vars.example` with every name so the generated type is stable.
- Services never receive `c`. They receive what they need: `(db, cfg, logger, …)` or a small
  `Deps` object. GM passes `{ env }` (the whole binding bag) into `NotificationService`
  (`index.ts:612`); Mirevue passes `AiEnv` (a 5-field subset, `services/ai.ts:34-42`). Prefer
  Mirevue's narrow-subset style, but derive the subsets from the zod config type.

---

## 3. Config validation in a Worker

- Mirevue `src/config.ts:8-201`: one zod schema over `process.env`, two `superRefine` cross-field
  rules (S3 vars required when `STORAGE_DRIVER=s3`, `APP_DATABASE_URL` required when
  `TENANT_SCOPE_MODE=enforce`), `export const config = loadConfig()` **at module load**, throws
  a readable multi-line error. Excellent shape; wrong moment for a Worker (no `process.env` at
  module-evaluation time in workerd; bindings only exist on `fetch(req, env, ctx)`).
- GM: no validation anywhere. `getRequiredEnv(env, key)` throws lazily
  (`middleware/env.ts:204-210`); everything else is `c.env?.X || process.env.X` with `??`
  defaults scattered through ~60 call sites (grep: 17× `process.env.NODE_ENV`, 15×
  `process.env.OAUTH_ENCRYPTION_KEY` in `src/api`). Note GM's `compatibility_date = "2024-12-02"`
  predates `nodejs_compat_populate_process_env` (default from 2025-04-01), so in production
  every `process.env.X` fallback is **undefined** — they only work under vitest/tsx.

**Recommendation: validate once per isolate, lazily, from `c.env`, memoised by identity.**

```ts
// src/config.ts
let cached: { env: unknown; cfg: AppConfig } | undefined
export function loadConfig(env: Cloudflare.Env): AppConfig {
  if (cached?.env === env) return cached.cfg
  const r = configSchema.safeParse(env)          // zod over the bindings object; bindings pass through
  if (!r.success) throw new ConfigError(formatIssues(r.error))   // → 500 with the list, logged once
  cached = { env, cfg: r.data }
  return r.data
}
```

- Per-isolate, not per-request: `env` is the same object for the life of the isolate in
  production, so the identity check makes this a one-time parse; in `wrangler dev` a `.dev.vars`
  edit produces a new `env` and re-validates. Never cache on a module `const` computed at import
  (Mirevue) — the same module is also imported by `queue`/`scheduled` handlers and tests.
- The same `loadConfig(env)` is called at the top of `fetch` (via `configMiddleware`), `queue`
  and `scheduled`, so all three entry points fail identically.
- Schema keeps Mirevue's style (enums, coercions, defaults, `superRefine`), but typed against
  the generated `Cloudflare.Env`; bindings (`DB`, `RATE_LIMIT_KV`, `ASSETS`, …) are declared with
  `z.custom<KVNamespace>()` or simply spread through untouched (`z.object({...}).passthrough()`).
- Fail-fast at deploy time is still possible: add a `GET /api/ready` that calls `loadConfig` and
  a smoke step in CI hitting it on the preview URL. That replaces Mirevue's boot-time crash.
- `.dev.vars` = local secrets (gitignored); `[vars]` in `wrangler.toml` = non-secret config
  (GM puts `APP_URL`, `NODE_ENV`, `AI_PROVIDER`, `AI_MODELS`, `RELEASE_VERSION`, Paddle price
  ids there). Kit should ship `.dev.vars.example` (names only) and `wrangler.jsonc` `vars`
  for the non-secrets; `NODE_ENV` should be replaced by an explicit `APP_ENV`
  (`development|preview|staging|production`) because Workers do not set `NODE_ENV`.
- Drop the `process.env` fallback entirely. For tests, pass a real env object: use
  `@cloudflare/vitest-pool-workers` (`import { env } from 'cloudflare:test'`) or
  `app.request(path, init, testEnv)` — Hono's third argument is the env.

---

## 4. Middleware inventory

| Concern | Mirevue | GM | Kit base / CF notes / strip |
|---|---|---|---|
| Error handler | `middleware/error-handler.ts:61-78` — logs, `classifyInfrastructureError` for RLS/scope faults (L7-13 fixed greppable messages), `createErrorResponse` (`utils/core/errors.ts:533-565`) | `error-handler.ts:20-37`, same lineage minus the fault classification; a dead `asyncErrorHandler` (L53-57) | **Mirevue.** Keep fault classification hook but make the fault list generic (`database_unavailable`, `tenant_isolation_violation`). Add `app.notFound` returning `{ error: 'Not found', statusCode: 404 }` for `/api/*` (neither repo has it). Add `requestId` to every log line and to the 500 body. |
| Request logging | `pinoLogger({ pino: logger })` prod only (`index.ts:60-62`); `utils/core/logger.ts:46-55` uses a **`pino-pretty` transport (worker thread → Node-only)** | `pinoLogger` prod only (`index.ts:133-135`); `utils/core/logger.ts:66-125` uses pino **browser mode** + `hono-pino/debug-log` pretty writer — this is the Workers-compatible config | **GM's logger config**, Mirevue's usage. `hono-pino` sets `c.get('logger')` and a request id (`reqId`) — use that instead of GM/Mirevue's module-global `logger` inside requests. Turn it on in **all** envs; in dev the debug-log writer is readable. GM's `[observability.logs] enabled = true` (`wrangler.toml`) ships `console.*` JSON to Workers Logs; pino browser mode writes via `console`, so structured fields survive. Strip `process.env.NODE_ENV` gating → `config.APP_ENV`. |
| Security headers | `security-headers.ts:9-56` — HSTS, nosniff, X-Frame DENY, Referrer-Policy, Permissions-Policy, strict CSP with a **hashed inline theme script** (L7) and path-scoped relaxations for pdf.js/voice (L13-20, 40-46) | `security-headers.ts:3-25` — same headers, plain CSP (`script-src 'self'`) | **GM's minimal set** + Mirevue's post-`next()` placement. Strip Mirevue's product-specific CSP branches. Consider Hono's built-in `secureHeaders()` — it covers all of these; hand-rolled version is fine and easier to reason about. Keep CSP as a config-driven string list so the app can append `connect-src` for its providers. |
| Env / config | `env.ts:11-14` sets the singleton `config` | `env.ts:107-201` rebuilds a 60-key object per request from `c.env ?? process.env` | **New**: `configMiddleware` = `c.set('config', loadConfig(c.env))`. Kill GM's duplicate list and `getRequiredEnv`. |
| Database | `database.ts:44-77` — process-wide `pg.Pool` singleton (`getSystemPool`), rebuilds after `closeDatabase()`; `c.get('db')` is the **unpinned system pool** by design (rules `api.md:36-42`) | `database.ts:13-35` — **creates a drizzle client per request** from `PREVIEW_DATABASE_URL ?? HYPERDRIVE.connectionString ?? DATABASE_URL` (`db/client.ts:98-124`), `postgres`-js for Hyperdrive, `@neondatabase/serverless` HTTP for Neon URLs | **GM** (per-request client is the correct Workers shape — a `pg.Pool` singleton cannot live across requests without `nodejs_compat` connection reuse caveats). CF: with Hyperdrive, `postgres-js` **must** be `max: 1`/`prepare: false` and the client ideally ended in `waitUntil` after the response; keep `preview → hyperdrive → url` precedence. See 03-database for RLS/tenant-scope; the `db` handle placed on context stays the *system* handle, as in Mirevue. |
| CSRF | `csrf.ts:36-74` — skip safe methods, skip Bearer, skip no-cookie; reject `Sec-Fetch-Site` not in same-origin/same-site/none; Origin then Referer allowlist = localhost:3000/3001 + `APP_URL` origin | `csrf.ts:37-75` **byte-identical**; reads `c.get('env').APP_URL` | Either (identical). Pure Web API — CF-safe. Genericize: allowlist from `config.APP_URL` + `config.DEV_ORIGINS` rather than hardcoded localhost ports; cookie name from one constant shared with the auth module. Runs **before** auth so it uses only the raw cookie header. |
| CORS | `hono/cors`, static origin list, `credentials: true` (`index.ts:70-75`) | `hono/cors`, function origin from `c.env.APP_URL`, explicit `allowMethods/allowHeaders`, **no `credentials`** (`index.ts:141-154`) | GM's function-origin (needed because config is per-isolate, not import-time) + Mirevue's `credentials: true` + GM's explicit methods/headers (add `PATCH`). Only actually needed when UI origin ≠ API origin (Vite dev); with ASSETS the app is same-origin in prod — keep it, gated to dev origins. |
| Rate limiting | `rate-limit.ts:42-75` — **Postgres** `rate_limit_hits` table, one CTE statement (prune+count+insert), per-IP via `X-Forwarded-For`; `authRateLimitMiddleware` (L110-124) mounted on unauthenticated auth routes; `resetRateLimits(db, prefix)` for tests | `rate-limit.ts:10-35` + `services/rate-limiter.ts:20-90` — **KV** `RATE_LIMIT_KV`, sliding window as a JSON array of timestamps, keyed `auth_rate_limit:ip:<CF-Connecting-IP>`; **skips when KV unbound**. Also `operation-guard.ts:17-63` KV mutex per tenant (`op_lock:<op>:<tenant>` w/ TTL, 409) and `tenantRateLimit` (L117-153) | **GM** (KV) as the store, Mirevue's middleware shape and test reset helper. CF notes: KV is eventually consistent and read-then-write is racy — acceptable for brute-force throttling, **not** for hard quotas; for anything exact use the Workers **Rate Limiting binding** (`[[unsafe.bindings]] type = "ratelimit"`, beta — no stability guarantee) or a DO. Use `CF-Connecting-IP` first (GM), fall back to `X-Forwarded-For` (Mirevue). Keep `operationLock` — it is a genuinely useful generic primitive. Drop the "no KV → skip" silent path in prod (fail closed or log loudly; fine in dev). |
| Auth | `auth.ts:63-300` — Bearer API key (`validateApiKey` from `routes/keys.ts`) then `sessionId` cookie; 5-7 sequential queries (session+user, membership, tenant, touch lastAccessed); sliding 7-day renewal; "first membership" tenant fallback; 403 `{ code: 'tenant_suspended'\|'pending_approval'\|'no_tenant' }`; sets `auth`, `session`, `ability` (CASL). `globalAdminMiddleware` (L327-388) tenant-free variant for `/api/admin/*` | `auth.ts` — same two strategies, but the session path is **one SQL statement with `LEFT JOIN LATERAL`** (L316-380) fetching user+membership+tenant+subscription, and side-effect writes (touch, renew, clear stale selection) go through `fireAndForget(c, …)` → `c.executionCtx.waitUntil` (L194-203, 386-411). Adds subscription/billing (`buildSubscriptionInfo`, L59-120) and a survey-only path allowlist (`survey-only.ts`) | **Mirevue's contract** (context shapes, error codes, `globalAdminMiddleware` at the mount rather than GM's `authMiddleware`+`requireGlobalAdmin` stack) with **GM's mechanics** (single LATERAL query, `waitUntil` for writes — on Workers a detached promise after the response is *killed*, so `waitUntil` is mandatory, not an optimisation). Strip: billing/subscription, survey-only, `isSurveyOnly`, `githubId`. Details belong to 02-auth; the shell only needs: it is mounted per prefix, requires `config`+`db` on context, and sets `auth/session/ability`. |
| Permissions | `permissions.ts:19-37` `guardPermission(c, action, subject)` → `Response \| null`; CASL abilities in `src/permissions/` | identical, types from `@guidemode/types` | Either. Keep the "returns a Response to bubble up" convention — it is what makes `withAuthAndDb` handlers linear. |
| Tenant resolution | Inside `authMiddleware` (session.selectedTenantId → first membership); admin surface is tenant-free. Body/query tenant ids are never trusted (`middleware/CLAUDE.md:18`) | Same; plus per-tenant KV locks/limits key off `c.get('session').tenantId` | Same. No subdomain/host-based tenant resolution in either repo; kit v1 stays session-selected-tenant. |
| Body size limit | none | none | Add Hono `bodyLimit({ maxSize })` on `/api/*` (CF caps request bodies at 100 MB Free / 500 MB Paid anyway, but a 1-2 MB JSON cap protects the DB/LLM paths). |
| Analytics | — | `analytics.ts:72-93` `trackUsageEvent(c, category, name, meta)` → `ANALYTICS_ENGINE.writeDataPoint({ blobs, doubles, indexes: [tenantId] })`, never throws; middleware itself is a no-op (L104-107) | Optional seam: keep the **function**, drop the middleware. It is 20 lines and the only free per-tenant usage counter on CF. |
| Static / SPA | `server.ts` `serveStatic` + `readFileSync(index.html)` | `index.ts:524-543` ASSETS catch-all | GM. |

---

## 5. Route conventions and contracts

### Thin controllers (both, Mirevue codified)

- `routes/CLAUDE.md:22-31` and `.claude/rules/api.md:21-34`: `zValidator('json'|'query', schemaFromShared)`
  → `withAuthAndDb(c, ({ tenantId, user, db, unscopedDb, scoped }) => …)` → `guardPermission` →
  tenant-filtered drizzle query → optional `broadcast(...)`. Handlers may **return a plain object**;
  `withAuthAndDb` wraps it in `c.json` (`route-helpers.ts:128-132`). Rule: **never** read
  `c.get('session'|'auth'|'db')` by hand (`api.md:25-29`) — one accessor, one shape.
- `withEngagement` (`utils/routes/with-engagement.ts:182-212`) is Mirevue's domain-specific
  second seam (`{ subject, access, writable, capability, param, locate }` declared guards). It is
  workshop-specific but the *pattern* — a per-aggregate prologue that loads the row, applies
  access + lifecycle guards, and hands the handler a typed context — is exactly what a kit
  consumer will want for their own top-level aggregate. Ship it as a documented pattern
  (`withResource` template), not as code.
- GM's `route-helpers.ts:44-75` is the older `withAuthAndDb` (no `scoped`/`unscopedDb`); GM
  routes are far less consistent (auth sometimes inside routers, ad-hoc `c.json({ error })`).
- `zValidator` runs before the seam, so a bad body 400s before authz (`api.md:116-117`) — accept.
  Neither repo customises the zValidator error hook; the default returns zod's raw
  `{ success: false, error: ZodError }` **which does not match the `{ error, statusCode }`
  envelope**. Kit should pass a hook that throws `ValidationError(422, …)` (or 400) so all
  errors flow through `onError`.

### Shared contracts — `src/shared/`

- `shared/CLAUDE.md`: "New or changed API contract ⇒ schema here first." Zod only — **no drizzle,
  no hono, no node builtins** so it bundles for the browser. Server imports relatively, UI via
  `@shared/*`. `z.coerce.date()` for timestamps. `src/shared/auth.ts:78-100` also holds the
  server-side `AuthContext`/`SessionContext` interfaces (GM puts these in a workspace package
  `@guidemode/types`; single-package kit → `src/shared/auth.ts` as Mirevue).
- **Client:** neither repo uses `hono/client` RPC. Both use a hand-rolled `src/ui/lib/api-client.ts`:
  `fetch` with `credentials: 'include'`, an `ApiError(message, status, code, details)` class
  (Mirevue L16-56), and Mirevue adds an optional **`schema` option that zod-parses the response**
  (L88-91). That is the recommended v1: plain fetch + shared zod schema on both ends. `hc<typeof
  app>` RPC was evaluated implicitly and not adopted — it requires the UI to import the server
  type graph (drizzle types, bindings), which conflicts with the "shared is zod-only" rule and
  bloats UI type-checking. Revisit only if the kit later wants generated OpenAPI
  (`@hono/zod-openapi` is the natural upgrade path since contracts are already zod).
- **Response envelope:** none. Success bodies are bare domain objects (`{ people, pagination,
  permissions }`, `{ success: true }`, arrays). Error bodies are `{ error: string, statusCode:
  number, code?: string, ...context }` from `ApiError.toJSON()` (`errors.ts:26-32`), with
  ad-hoc `c.json({ error, code }, 403)` in middleware matching the same top-level shape. The UI
  reads `message ?? error` + `code` (`api-client.ts:97-124`). Kit: **codify the error shape as a
  zod schema in `src/shared/errors.ts`** (`{ error, statusCode, code?, details? }`) and make
  `ApiError.toJSON` and every middleware use it; leave success bodies bare.
- **Pagination:** page-based. `shared/tenants.ts:122-140`: query `{ page (min 1, default 1),
  pageSize (1..100, default 25), search?, type? }`, response `{ items…, pagination: { page,
  pageSize, total, totalPages } }`. GM is `limit/offset` + `hasMore`/`total` ad hoc. Kit: ship
  `paginationQuerySchema` + `paginatedResponse(itemSchema)` helper in `src/shared/pagination.ts`
  using Mirevue's shape; cursor pagination is an app-level choice.
- **SSE/streaming:** Mirevue `utils/routes/agent-progress.ts:45-85` uses `hono/streaming
  streamSSE` — CF-compatible — but its queued-run reader relies on `pg-notify` LISTEN (Node
  only). Streaming contract (`meta/stage/transcript/result/error/done` frames,
  `shared/agent-progress.ts`) is a good generic shape; transport for "run progress" on CF is a
  DO or polling — out of this doc's scope (see 05/06).

### Services and utils

- Mirevue `src/api/services/` (~70 files) are plain modules exporting functions/classes that take
  `(db, …)` explicitly; `AiEnv` (`services/ai.ts:34-42`) shows the "narrow env subset" style;
  `ScopedRunner` (`db/client.ts:36-52`) is threaded where work outlives the request. GM services
  take `(db, env)` or `{ env }` bags and sometimes construct their own clients from `env`
  (`index.ts:581-593`). Kit convention: **services never see `Context`; they take `db`, a typed
  config slice, `logger`, and (where they need `waitUntil`) an `ExecutionContext` or a
  `defer(fn)` callback.**
- `utils/core/` (Mirevue): `errors.ts` (typed `ApiError` tree, `createErrorResponse`,
  infrastructure fault mapping), `logger.ts`, `keys.ts` (API key hash/generate). `utils/routes/`:
  `route-helpers.ts`, `broadcast.ts` (fire-and-forget realtime, logged once), `with-engagement.ts`,
  `agent-progress.ts`. `utils/db/`: tenant/people/access/phase query helpers. Keep the three-way
  split; kit ships `core/{errors,logger,keys,ids}.ts`, `routes/{route-helpers,broadcast,pagination}.ts`,
  `db/tenant-helpers.ts`.
- `keys.ts:1,16` uses `randomBytes` from `node:crypto` for key generation but WebCrypto for
  hashing; replace with `crypto.getRandomValues(new Uint8Array(32))` (as
  `auth/oauth-encryption.ts:129` already does). Key prefix `exec_`/`gai_` → configurable.

---

## 6. Observability

- **Mirevue** (`src/api/observability/`): `langfuse.ts:54-80` boots `@opentelemetry/sdk-node
  NodeSDK` with `LangfuseSpanProcessor` (needs `AsyncLocalStorage` context manager);
  `tracing.ts:41-64 withAgentTrace(ctx, fn)` = `startActiveObservation` + `propagateAttributes`
  from `@langfuse/tracing`, a no-op when keys are absent; `tracing.ts:136-150` wraps the
  Anthropic client in a `Proxy` that taps `messages.create/.stream` and emits a `generation`
  per call (deliberately **not** OpenInference prototype patching); `trace-names.ts` is a 5-min
  TTL cache mapping tenant/session ids to names for readable dashboards. Shutdown flushes
  (`server.ts:125`). `.claude/rules/api.md:203-221`: "every LLM call MUST be traced."
- **GM**: `services/langfuse.ts:1-10` — "REST-based tracing… to avoid `@opentelemetry/sdk-node`
  which is incompatible with Cloudflare Workers"; batches ingestion events in memory and
  `POST /api/public/ingestion` (L178) once per request from the flush middleware via
  `waitUntil` (`index.ts:124-130`). Plus `[observability.logs]` and Analytics Engine.
- **Can Mirevue's version run in Workers?** Not as written. `NodeSDK` pulls Node resource
  detectors, `process.on`, and `AsyncLocalStorage` (available under `nodejs_compat` but the
  OTel Node SDK still assumes a long-lived process and timers for batch export). The
  `withAgentTrace` **API** and the client-tapping Proxy are runtime-neutral. Path to a Workers
  version: keep `withAgentTrace`/`traceClient` signatures; swap the provider for
  `@microlabs/otel-cf-workers` (a Workers-native OTel SDK that exports on `waitUntil`) or the
  `@langfuse/otel` span processor on `@opentelemetry/sdk-trace-base` `BasicTracerProvider` with
  an explicit `forceFlush()` in the flush middleware; **or** adopt GM's fetch-based batcher and
  give it Mirevue's API. GM's batcher is ~300 lines with no deps; that is the pragmatic v1.
- **Belongs in the kit?** As an **optional seam, yes**: `src/api/observability/tracing.ts`
  exporting `withTrace(ctx, fn)` and `traceLlmClient(client)` that are no-ops unless
  `LANGFUSE_PUBLIC_KEY`+`LANGFUSE_SECRET_KEY` are set, plus the flush middleware. Keep GM's
  `trackUsageEvent` (Analytics Engine) as a second optional sink. Ship `[observability.logs]`
  enabled by default. Strip `trace-names.ts` (workshop-specific) or generalise to `tenantName` only.

---

## 7. AI provider seam

- **Mirevue**: per-tenant provider configs in DB (`tenant_ai_configs`, encrypted keys) with a
  static provider catalog `services/ai-providers.ts` (`PROVIDERS[]` with `scopes`, `suggestedModels`,
  `supportsThinking`), per-agent model assignment (`shared/agent-models.ts` keyed by prompt-registry
  key), platform fallback `ANTHROPIC_API_KEY`/`EMBEDDINGS_API_KEY` (`config.ts:43-48`), resolver
  in `services/ai.ts` returning an `AnthropicLikeClient` (Anthropic | Bedrock; Anthropic-compatible
  base URLs for Moonshot/Fireworks) already wrapped by `traceAnthropicClient`. Rich, Anthropic-shaped.
- **GM**: `AI_PROVIDER` + comma-separated `AI_MODELS` vars (`wrangler.toml [vars]`), a
  once-per-isolate adapter registry (`utils/ai/ai-models-init.ts`, `index.ts:80-121`), a separate
  `services/ai-config/` resolver (notebook → tenant → platform) with Azure/Bedrock wrappers,
  and `@google/generative-ai` + `@anthropic-ai/sdk` + OpenAI. Two overlapping systems.
- **Recommendation for v1:** a **thin** seam only — `src/api/services/ai/{provider.ts,resolve.ts}`
  with an interface `{ provider, model, apiKey, baseUrl?, maxOutputTokens }` resolved as
  *tenant config → platform env*, encrypted at rest with the same key as OAuth tokens, and a
  `PROVIDERS` catalog (Mirevue's shape minus scopes/reranker/thinking). Return a raw SDK client
  wrapped by the tracing tap. Do **not** port per-agent model assignment, prompt registry, or
  GM's adapter registry into the kit; they are product features. Workers AI (`AI` binding) can
  be one more provider entry. Everything here works on Workers today (both SDKs are fetch-based).

---

## 8. Node-only APIs in Mirevue's API shell (explicit list)

Inventory of `src/api`, `src/config.ts`, `src/server.ts`, `src/db` (excluding tests):

| Module | Where | Replacement in kit |
|---|---|---|
| `@hono/node-server`, `serve-static` | `server.ts:3-4` | `export default { fetch }` + `ASSETS` binding |
| `node:http` `Server`, `ws` (WebSocketServer) | `server.ts`, `services/websocket.ts`, `services/websocket-upgrade.ts` | Durable Object + `upgradeWebSocket` from `hono/cloudflare-workers` (see 05-realtime) |
| `pg` `Pool`/`PoolClient` | `db/client.ts:3`, `middleware/database.ts:2`, `db/tenant-scope.ts:3`, `services/pg-notify.ts` | `postgres` (postgres-js) over Hyperdrive / `@neondatabase/serverless`; per-request client |
| `pg-boss` | `services/agent-queue.ts`, `agent-worker.ts` | Cloudflare Queues / Workflows |
| `node:async_hooks` `AsyncLocalStorage` | `utils/routes/route-helpers.ts:1`, `db/tenant-scope.ts:1` | Available under `nodejs_compat`, but the *pinned-connection* model it protects does not exist with per-request clients; tenant scope becomes `SET LOCAL` inside a transaction (03-database). `AsyncLocalStorage.snapshot()` (L121) has no purpose then |
| `process.env` at import time | `config.ts:191`, `utils/core/logger.ts:18-32` | `loadConfig(c.env)` lazily; logger level from config |
| `process.on('SIGTERM')`, `process.exit` | `server.ts:108-133` | none needed |
| `pino` transport `pino-pretty` (worker thread) | `utils/core/logger.ts:46-55` | pino `browser` mode + `hono-pino/debug-log` (GM `logger.ts:66-101`) |
| `@opentelemetry/sdk-node` `NodeSDK` | `observability/langfuse.ts:2` | fetch-based batcher or `@microlabs/otel-cf-workers` (§6) |
| `node:crypto randomBytes` | `utils/core/keys.ts:1,16` | `crypto.getRandomValues` (WebCrypto already used for hashing/AES/HMAC in `auth/*`) |
| `node:fs`, `node:fs/promises`, `node:path`, `node:zlib`, `node:readline`, `node:child_process`, `node:stream` | `services/eval-launcher.ts`, `routes/admin-eval-*.ts`, `routes/rewired.ts`, `services/rewired-toc.ts`, `services/storage.ts` (local driver), `services/people-import.ts`, `services/outputs-export.ts`, `db/fixtures/load-rewired.ts` | All product-specific (evals, Rewired book, local storage). **Not ported.** Storage → R2 binding |
| `readFileSync('./dist/ui/index.html')` | `server.ts:55` | ASSETS `not_found_handling = "single-page-application"` |
| `Buffer` | scattered in auth/microsoft.ts, google.ts, sessions.ts (base64) | `nodejs_compat` provides `Buffer`; prefer `btoa/atob` + `TextEncoder` for a clean bundle |

Net: `middleware/{csrf,security-headers,permissions,error-handler}.ts`, `utils/core/errors.ts`,
`observability/tracing.ts` (API), `shared/**`, and the route/handler *conventions* port verbatim.
`middleware/{database,env,rate-limit,auth}.ts`, `utils/routes/route-helpers.ts`, `config.ts`,
`logger.ts` need the substitutions above.

---

## 9. Proposed file list — kit `src/api/` shell + `src/shared/`

```
wrangler.jsonc                  # main: src/api/index.ts, nodejs_compat, [assets] ASSETS, kv RATE_LIMIT_KV,
                                # hyperdrive HYPERDRIVE, [observability.logs], vars: APP_ENV, APP_URL
worker-configuration.d.ts       # generated by `wrangler types`, committed
.dev.vars.example               # names only

src/config.ts                   # zod schema over Cloudflare.Env; loadConfig(env) memoised per isolate; AppConfig type
src/api/index.ts                # Hono<AppEnv> assembly, middleware order (§10), mounts, ASSETS catch-all,
                                # export { app }; export default { fetch, queue, scheduled }
src/api/types.ts                # AppBindings = Cloudflare.Env, AppVariables, AppEnv, AppContext
src/api/queue.ts                # queue(batch, env, ctx) dispatcher on batch.queue → consumers/*
src/api/scheduled.ts            # scheduled(event, env, ctx) dispatcher on event.cron
src/api/middleware/
  config.ts                     # c.set('config', loadConfig(c.env))
  database.ts                   # per-request drizzle client (preview → hyperdrive → url); c.set('db'); end in waitUntil
  request-logger.ts             # hono-pino wiring, requestId, c.set('logger')
  security-headers.ts           # post-next headers; CSP from config
  csrf.ts                       # Mirevue verbatim, origins from config
  cors.ts                       # function-origin cors, credentials, dev origins from config
  body-limit.ts                 # bodyLimit for /api/*
  rate-limit.ts                 # KV sliding window (authRateLimit, tenantRateLimit) + operationLock
  auth.ts                       # authMiddleware, globalAdminMiddleware (contract from 02-auth)
  permissions.ts                # guardPermission / can
  error-handler.ts              # onError → shared error envelope; notFound for /api/*
  CLAUDE.md
src/api/routes/
  health.ts                     # /api/health, /api/ready (SELECT 1 + loadConfig)
  auth/…  keys.ts  members.ts  invitations.ts  notifications.ts  user-settings.ts  tenant-settings.ts  admin.ts
  CLAUDE.md
src/api/services/               # (db, cfg, logger, defer) convention; ai/{provider,resolve}.ts optional seam
src/api/utils/
  core/errors.ts  core/logger.ts  core/keys.ts  core/ids.ts
  routes/route-helpers.ts       # withAuthAndDb → { c, user, tenantId, db, cfg, logger, defer }
  routes/pagination.ts  routes/broadcast.ts
  db/tenant-helpers.ts
src/api/observability/
  tracing.ts                    # withTrace / traceLlmClient (no-op without keys)
  langfuse-client.ts            # fetch-based batcher, flushed via waitUntil
  analytics.ts                  # trackUsageEvent → ANALYTICS_ENGINE (optional)
src/shared/
  CLAUDE.md  index.ts
  errors.ts                     # apiErrorSchema { error, statusCode, code?, details? }
  pagination.ts                 # paginationQuerySchema, paginatedResponse(item)
  auth.ts  tenants.ts  notifications.ts  admin.ts  tenant-settings.ts
src/ui/lib/api-client.ts        # fetch + credentials + ApiError + optional zod `schema`
```

## 10. Recommended middleware order for the kit

1. `app.onError(errorHandler)` / `app.notFound(...)` — registered first so every later failure, including config validation, gets the JSON envelope.
2. `requestLogger` (hono-pino) — first real middleware so the request id exists for everything after it, including config errors.
3. `configMiddleware` — `loadConfig(c.env)`; everything below reads `c.get('config')`, never `c.env` directly.
4. `securityHeaders` — wraps `next()` and sets headers on the way out; placed early so it also covers 4xx from later middleware.
5. `bodyLimit` (on `/api/*` and `/auth/*`) — reject oversized bodies before any parsing or DB work.
6. `cors` — needs `config.APP_URL`; must run before CSRF so preflights (OPTIONS) are answered, not blocked.
7. `csrf` — cookie-only, no DB; cheap rejection before we open a database client.
8. `databaseMiddleware` — per-request client; last of the globals because it is the first thing with real cost.
9. `langfuseFlush` (optional) — `await next(); ctx.waitUntil(flush())`; sits just above routes so it brackets exactly the handler's spans.
10. Mounts: `/api/health|ready` public → `/auth` (with `authRateLimit` on login routes) → `/api/invite` public → `/api/admin/*` with `globalAdminMiddleware` → every other `/api/<prefix>/*` with `authMiddleware` at the mount → `app.all('*')` ASSETS catch-all with the `/api|/auth` 404 guard.

`auth` stays **per-mount** rather than global (both repos agree) because the public surface
(health, OAuth callbacks, invite accept, webhooks) is enumerable and small.

## 11. Env vars and bindings

Bindings (`wrangler.jsonc`): `ASSETS` (Fetcher), `HYPERDRIVE` (Hyperdrive), `RATE_LIMIT_KV` (KV),
`ANALYTICS_ENGINE` (optional), plus whatever 05/06 add (`NOTIFICATIONS_HUB` DO, queues, R2).

Vars (non-secret, `[vars]`): `APP_ENV`, `APP_URL`, `RELEASE_VERSION`, `LOG_LEVEL`, `EMAIL_FROM`,
`AI_PROVIDER`, `AI_MODEL` (if the seam ships), `LANGFUSE_BASE_URL`.

Secrets (`.dev.vars` / `wrangler secret put`): `DATABASE_URL` (dev/fallback), `PREVIEW_DATABASE_URL`
(per-PR), `OAUTH_ENCRYPTION_KEY` (≥32 chars; also signs magic-link/invite tokens), `RESEND_API_KEY`,
`SLACK_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`,
`ANTHROPIC_API_KEY` (platform fallback), `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`.

Dropped from Mirevue: `PORT`, `NODE_ENV`, `BROADCASTER_DRIVER`, `STORAGE_*`, `TENANT_SCOPE_MODE`/
`APP_DATABASE_URL` (03 decides), `INTERVIEW_EVIDENCE_KINDS`, `REWIRED_CONTENT_DIR`,
`EMBEDDINGS_API_KEY`, `AGENT_MAX_*`. Dropped from GM: all `PADDLE_*`, `GITHUB_*`, `GITLAB_*`,
`JIRA_*`, `LINEAR_*`, `NOTION_*`, `*_REDIRECT_URI` (derive from `APP_URL`), `CLOUDFLARE_API_TOKEN/
ACCOUNT_ID`, `AI_MODELS`, `AI_PROMPT_LOGGING`, `LANGFUSE_ENABLED` (presence of keys is the switch),
`ADMIN_SECRET`, `SESSION_SECRET`, `R2_*`.

## 12. Open questions / risks

1. **Per-request DB client cost on Hyperdrive.** GM creates a `postgres()` client per request and
   never ends it; with Hyperdrive that is tolerated but leaks sockets across the isolate. Kit
   should `ctx.waitUntil(sql.end())` after the response or use the Neon HTTP driver for
   request/response work. Interacts with 03's RLS/`SET LOCAL` decision (needs a transaction on one
   connection — fine with postgres-js, impossible with neon-http single statements).
2. **KV rate limiting is approximate.** Read-modify-write on eventually-consistent KV; fine for
   login throttling, wrong for quotas. Decide whether v1 adopts the Workers Rate Limiting binding
   (exact, per-colo) and keeps KV only for `operationLock`.
3. **Testing harness.** GM tests run the Hono app under Node (`vitest environment: 'node'`, a
   hand-written `cloudflare:workers` mock) and rely on `process.env` fallbacks; Mirevue tests hit
   the real app + real Postgres. For the kit: `@cloudflare/vitest-pool-workers` (real bindings, KV,
   miniflare Hyperdrive→local PG) vs Node + `app.request(req, env)`. The former removes every
   `process.env` fallback; the latter is faster and what both teams know.
4. **`hc` RPC vs zod-on-both-ends.** Recommended zod-on-both-ends (existing practice). If OpenAPI
   docs become a requirement, `@hono/zod-openapi` should be adopted *before* routes multiply.
5. **`declare module 'hono'` augmentation vs generic `Hono<AppEnv>`.** Removing augmentation
   means every router file must be `new Hono<AppEnv>()`; a lint rule or a `createRouter()`
   factory in `src/api/utils/routes/` is needed so nobody instantiates a bare `Hono`.
6. **Validation error shape.** Neither repo overrides zValidator's default 400 body. Changing it
   to the shared envelope is a UI-visible change; do it in the kit from day one.
7. **`process.env` in third-party deps.** pino, `@anthropic-ai/sdk`, arctic etc. touch
   `process.env`/`process.version` at import; `nodejs_compat` covers them, and a compat date ≥
   2025-04-01 populates `process.env` from vars — decide whether to rely on that (convenient) or
   forbid it (explicit). Recommendation: forbid in app code, tolerate in deps.
8. **Preview deployments.** GM's `PREVIEW_DATABASE_URL` → Neon branch per PR is a good pattern
   the kit should keep in `databaseMiddleware`, but it depends on a CI step outside this doc.
9. **Langfuse client choice** (fetch batcher vs Workers-OTel). Fetch batcher is smaller and
   proven in GM; OTel keeps Mirevue's `propagateAttributes` semantics and future exporters.

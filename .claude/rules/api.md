---
paths:
  - apps/web/src/api/**
  - apps/web/src/worker.ts
  - apps/web/src/config.ts
  - packages/shared/src/**
---

# API Patterns

`apps/web/src/api/index.ts` builds the Hono app and exports `app` only; `apps/web/src/worker.ts` is
the Worker entry (`export default { fetch, queue, scheduled, email }` + the DO/Workflow classes).
Keep the classes out of `api/index.ts` — it lets tests drive `app.request(req, env, ctx)` in Node.

## Read the nested doc before you touch…

- a middleware, the mount order, a body/CSP rule → `src/api/middleware/CLAUDE.md`; a route file
  or an endpoint's codes → `src/api/routes/CLAUDE.md`
- a service, realtime, visibility, feature flags → `src/api/services/CLAUDE.md`
- a model call, chat, a streaming route, ingest, retrieval → `src/api/services/ai/CLAUDE.md`
- agent runs, tools, interrupts, decisions → `src/api/services/agents/CLAUDE.md`; the Workflow
  class → `src/api/workflows/CLAUDE.md`; a job type or consumer → `src/api/queues/CLAUDE.md`
- anything a plugin contributes, or the analytics plugin → `apps/web/src/plugins/CLAUDE.md`

## Middleware order (do not reorder casually — each step needs what the earlier ones set)

1. `app.onError(errorHandler)` / `app.notFound` — every later failure, config validation included,
   gets the JSON envelope; then `/cdn-cgi/*` → bare 404 before the logger
2. `requestIdMiddleware` + `requestLogger` (hono-pino) — a request id for everything after
3. `configMiddleware` — `loadConfig(c.env)`; everything below reads `c.get('config')`, **never
   `c.env` for config**
4. `securityHeaders` — **returns a 101 untouched**; the `embeddable` opt-in is for a route that has
   PROVED the content type, never a path allowlist
5. `apiBodyLimit` (1 MB) on `/api/*`, `jsonBodyLimit` on `/auth/*` and each plugin `apiPrefixes`
   entry outside `/api` — skipped for `UPLOAD_PATHS`, which cap per route; a plugin public mount's
   `bodyLimitBytes` replaces it beneath its prefix
6. `cors` (before CSRF so preflights are answered; **bypassed for `Upgrade: websocket`**) → `csrf`
   (cookie-only, no DB)
7. `databaseMiddleware` — one client per request from `openDatabase`, closed in `waitUntil`
8. `tracerMiddleware` on `/api/*` — the request's span recorder, flushed after the handler
9. Mounts, in order: `/api/health|ready` → `/auth` → `/api/identity` (signed events, no session) →
   `/api/invite` → `/api/admin/*` behind `globalAdminMiddleware` → `/ws` (no `authMiddleware`; the
   route resolves the cookie) → plugin `publicMounts` under `/api/hooks/<id>` (no auth, per-IP rate
   limit) → the mount table, each entry with `authMiddleware` → **plugin authed mounts, last** (Hono
   matches in registration order, so a plugin can never shadow a kit prefix)
10. `app.all('*')` ASSETS catch-all, with a JSON 404 for `/api|/auth|/ws` and every `API_PREFIXES`
    entry (an unauthenticated `/cubejs-api/*` is a 401 envelope, never `index.html`)

**Auth is per mount, not global**: the public surface stays enumerable and small. A new authed
router is a `['/api/x', xRouter]` entry in the mount table — never auth inside a route file.

## Routes are thin

- `createRouter()` (`utils/routes/router.ts`) — never `new Hono()` bare; no `declare module 'hono'`
- Validate with `validate('json'|'query'|'param', schema)` (`utils/routes/validate.ts`) over a
  schema from `@rocketflare/shared/<module>` — never `zValidator` directly; a bad input is the
  shared 400
- `const { db, tenantId, user, cfg, logger, defer, realtime, tracer } = withAuthAndDb(c)` is the
  **only** way to read auth in a route (`withAuth(c)` is the tenant-free variant). Never
  `c.get('auth'|'session'|'db'|'tracer')` by hand. Bindings a service needs (`c.env.JOBS_QUEUE`,
  `FILES`, `AI`, `AGENT_RUN_WORKFLOW`) are passed from the route as arguments
- Authorise with `guardPermission(c, action, subject)` (`middleware/permissions.ts`; `can(c, …)` to
  branch). Owner-only actions use `guardOwner(c)` / `isOwnerLevel(auth)` — an explicit
  `role === 'owner'`, never `manage Tenant`
- Throw typed errors from `utils/core/errors.ts`; never `c.json({ error }, 4xx)` by hand. The
  envelope is `{ error, statusCode, code?, details? }`, owned by `middleware/error-handler.ts`
- Lists: `paginationQuerySchema` → `{ items, pagination: { page, pageSize, total, totalPages } }`
  (`@rocketflare/shared/pagination`); success bodies are bare domain objects
- `TENANCY_MODE=single`: multi-tenant-only routes (`create-org`, `delete-org`, `/select-tenant`,
  `/admin/tenants` list) call `requireMultiTenant` → 404 `tenancy_mode_single`; don't inline it
- `uuidParam(c, 'id')` for a `:id` — a non-UUID is a 404, never a DB error
- **Feature flags gate at the MOUNT, and never through CASL.** `requireFeature('x')` is the optional
  third element of a mount entry (`['/api/thing', thingRouter, requireFeature('thing')]`) → **404
  `feature_disabled`** (a 403 confirms it exists). Never `access Feature:x` — a global admin's
  `manage all` satisfies it. **The nav is not the only door**: a surface with no nav entry, and
  above all a hook that CREATES rows, gates on `features` itself

## Tenancy and visibility

- Every domain query filters by `tenantId` from the auth context — never from the body or query
  (`.claude/rules/database.md`)
- **Row VISIBILITY is a predicate too.** `accessScopeOf(auth)` → `visibleDocuments(scope)` (or a
  resource's registry predicate) is **ANDed with the tenant predicate and never replaces it**, and a
  hidden row answers the SAME 404 as an absent one. Never a CASL condition; never a new
  `if (kind === …)` branch — a restrictable resource is a `visibilityResources()` entry
  (drizzle gotchas: `src/api/services/CLAUDE.md`)

## Contracts live in `packages/shared` (`@rocketflare/shared`)

A new or changed surface starts as a zod schema in `packages/shared/src/<module>.ts`, imported as
`@rocketflare/shared/<module>` by the route (`validate()`), the UI (`api.get(..., { schema })`) and
the CLI (`apps/cli/src/api.ts`): schema → route → CLI command. Never a response type in a route
file. `packages/shared` is **private** and never imports `apps/web` or `apps/cli`.

## Streaming routes

Streams speak AG-UI through `services/ai/chat-turn.ts` (write: chat) or
`services/agents/run-stream.ts` (read: a run's tail) — rules in those directories' CLAUDE.md. Two
hold for any stream: everything that can fail (resolve, authorise, validate, writes) happens as JSON
**before** the first frame; inside the stream use `streamDatabase(c)` for every write, await it and
the tracer flush, and close it in `finally` — the request's `db` closes in `waitUntil` once the
Response is returned, and there is no `defer` after it. **Never `streamSSE`.**

## Background work: a route enqueues, never runs

| Work | Use |
|---|---|
| fire-and-forget, < 30 s | `JOBS_QUEUE` via `enqueueJob` / `enqueueJobs` (`services/jobs.ts`) |
| multi-step, retries, minutes+ | `AGENT_RUN_WORKFLOW` via `enqueueRun` — never an agent's `run()` |
| periodic | `[triggers] crons` → `SCHEDULED_TASKS` (`api/scheduled.ts`) |

- Cron: each task try/caught, one DB client per run. A plugin declares the TASK, the kit's tomls
  the EXPRESSION — a task under an expression no toml carries never runs
- Missing `JOBS_QUEUE` → `JobsQueueNotConfiguredError`, never a silent inline fallback. The
  **magic-link email stays inline** — a person is waiting on it
- Side effects that can outlive the response (email, activity, tracing flush, DO nudge, `sql.end()`)
  go through `c.executionCtx.waitUntil` — `defer()` from `withAuth` in a route — never awaited
  inline and never dropped. Concurrency is a DB claim row, never a `Map`

## Realtime, AI, services and config

- Routes never touch `NOTIFICATIONS_HUB`: `services/realtime.ts` is the **only** caller. A route
  hands `realtime` to the service, which nudges **after** the transaction commits — "DB is the
  truth, WebSocket is a nudge"

- Feature code never imports an AI SDK, reads `ai_configs` / `agent_models` or decrypts a key —
  `services/ai/resolve.ts` is the only seam; 503 `ai_not_configured` is thrown before any row is
  written or any stream opens. **Never log or return a credential** (`hasCredential`,
  `redactSecrets`). A prompt is a `CORE_PROMPT_REGISTRY` entry, never a string in a route
- Services are plain modules `(db, cfg, logger, …args)` — dependencies are passed, never read from
  `c.env`, `process.env` or a module-level `config` (`src/api/services/CLAUDE.md`)
- `apps/web/src/config.ts`: one zod schema over `Cloudflare.Env`; `loadConfig(env)` memoised per
  isolate, called at the top of `fetch`, `queue` and `scheduled`. `APP_ENV` is the environment
  discriminator — `NODE_ENV` exists only in test scripts
- **Module-evaluation order is the trap the type system cannot see.** `queues/jobs.ts`,
  `services/agents/registry.ts`, `services/prompts.ts`, `scheduled.ts`,
  `utils/routes/api-prefixes.ts` and `services/access.ts` read the plugin barrel at module scope; a
  cycle through one leaves one side `undefined` — a crash at import, not a compile error. So a
  registry a plugin's code imports back is a FUNCTION, not a const (`visibilityResources()`), and a
  value a plugin needs moves to a leaf (`services/access-sql.ts`) and is re-exported

## Workers runtime

- **`process.env` is forbidden in `apps/web/src/`** — bindings are on `c.env`, config on
  `c.get('config')`
- `nodejs_compat` is on, but the request path stays free of Node-only APIs: no `pg`, `ws`,
  `node:fs`, `node:child_process`, `pg-boss`, `@opentelemetry/sdk-node`. `Buffer`,
  `AsyncLocalStorage` and `node:crypto` hashing work, but prefer WebCrypto / `TextEncoder`
- `pnpm web build:api` (dry-run bundle) catches what `tsc` cannot — `.claude/rules/cloudflare.md`

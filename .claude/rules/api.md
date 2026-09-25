---
paths:
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
4. `securityHeaders` — after `next()`; **returns a 101 untouched** (the DO's upgrade response has immutable headers; re-wrapping it drops the socket). ONE second branch: a response a route opted in with `c.set('embeddable', true)` gets `X-Frame-Options: SAMEORIGIN` + `EMBEDDABLE_CONTENT_SECURITY_POLICY` (`frame-ancestors 'self'`) instead of `DENY` + `'none'`, so the document viewer can frame a PDF. **Only a route that has PROVED the content type may set the flag** (`routes/files.ts`: `isEmbeddableMimeType(row.contentType)`, set BEFORE the `If-None-Match` 304 early return, or a revalidation from inside the `<object>` kills the embed) — never a path allowlist, never a global policy change; both policies are built from one `CSP_BASE` so they cannot drift
5. `jsonBodyLimit` (1 MB) on `/api/*` and `/auth/*` — **skipped for the `UPLOAD_PATHS`** (`/api/files`, `/api/ai/documents/upload` — `isUploadPath`); each upload route mounts `uploadBodyLimit` (`MAX_UPLOAD_BYTES + 64 KB` multipart overhead) on its own `POST` and enforces the exact per-file cap in the handler
6. `cors` — before CSRF so preflights are answered; **bypassed for WebSocket upgrades** (`Upgrade: websocket` — CORS does not govern the handshake, the route checks membership)
7. `csrf` — cookie-only, no DB, cheap rejection (GET `/ws` is a safe method, no exemption needed)
8. `databaseMiddleware` — per-request postgres.js client, `c.executionCtx.waitUntil(close())`
9. `tracerMiddleware` (`middleware/tracing.ts`, on `/api/*`) — `c.set('tracer', tracerFor(cfg, { store: ownConnectionSpanStore(cfg, env) }))` (D32): the span recorder with the OTLP exporter when a backend is configured and the `ai_spans` store (its OWN short-lived client per non-empty flush — the request's is closed in `waitUntil`, possibly first); flushed through `deferOrAwait` (= `waitUntil`) AFTER the handler. A streaming route whose generations run after `next()` resolves (chat SSE) flushes again itself; flushing an empty batch is a no-op
10. Mounts: `/api/health|ready` public → `/auth` (rate-limited login routes) → `/api/invite` public → `/api/admin/*` behind `globalAdminMiddleware` → `/ws` (no `authMiddleware`: a browser cannot set headers on an upgrade, so `routes/ws.ts` resolves the cookie itself) → every other `/api/*` (incl. `/api/files`, `/api/ai/{config,prompts,usage,agent-models,documents}`, `/api/chat`, `/api/agui`, `/api/agents`, `/api/traces`) with `authMiddleware` at the mount → **every installed plugin's mounts, last** (D31, so a plugin can never shadow a kit prefix — Hono matches in registration order; the analytics plugin's are `/api/analytics`, `/cubejs-api` and `/mcp`, the last two ONE router mounted twice because drizzle-cube registers absolute paths) → `app.all('*')` ASSETS catch-all with a JSON-404 guard for `/api|/auth|/ws` plus every prefix in `API_PREFIXES` (an unauthenticated `/cubejs-api/*` is therefore a 401 envelope, never `index.html` — `tests/api/health.test.ts`)

Auth is per-mount, not global: the public surface is enumerable and small.

## Routes are thin

- `createRouter()` (`apps/web/src/api/utils/routes/router.ts`) — never `new Hono()` bare; no `declare module 'hono'` augmentation
- Validate with `validate('json'|'query'|'param', schema)` (`apps/web/src/api/utils/routes/validate.ts`, a zValidator wrapper) using schemas from `@rocketflare/shared/<module>` (`packages/shared/src/`); its hook throws `ValidationError` so a 400 uses the shared envelope `{ error, statusCode, code?, details? }` — never call `zValidator` directly
- `const { db, tenantId, user, cfg, logger, defer, realtime, tracer } = withAuthAndDb(c)` is the **only** way to read auth in a route (`withAuth(c)` is the tenant-free variant, `tenantId: string | null`). Never `c.get('auth'|'session'|'db'|'tracer')` by hand. `defer(fn)` runs a side effect through `waitUntil` (awaited inline when there is no ExecutionContext) and logs instead of throwing; `realtime` (`{ defer, env }`) is what you hand to a service so it can `nudge` (D8) — routes never touch `NOTIFICATIONS_HUB`; `tracer` (D32) is the request's span recorder (or the no-op when no sink is reachable), for `withAgentTrace` / `traceChatClient`. Bindings a service needs (`c.env.JOBS_QUEUE`, `c.env.FILES`, `c.env.AI`, `c.env.AGENT_RUN_WORKFLOW`) are passed from the route as arguments
- Authorise with `guardPermission(c, action, subject)` (CASL, `apps/web/src/api/middleware/permissions.ts`) — throws `UnauthorizedError`/`ForbiddenError` and returns the `AuthContext`; `can(c, …)` for branching. Owner-only actions (delete tenant, transfer ownership) use `guardOwner(c)` / `isOwnerLevel(auth)` — an explicit `role === 'owner'` check, never `manage Tenant`
- Every query filters by `tenantId` from the auth context — see `.claude/rules/database.md`
- **Row VISIBILITY is a predicate too (D29).** `accessScopeOf(auth)` (`services/access.ts`) →
  `{ tenantId, userId, groupIds, bypass }`; `visibleDocuments(scope)` / `visibleAnalyticsPages(scope)`
  are **ANDed with the tenant predicate and never replace it**, and a row the caller may not see
  answers the SAME 404 as one that does not exist. `bypass` is `isAdminLevel`. Never express this as
  a CASL condition — the kit uses none, and "own" has always been the route's own check. Two drizzle
  rules come with it: the EXISTS subquery uses a LITERAL alias (a column object renders with
  whatever table alias is in scope where the fragment lands), and a raw predicate cannot be used
  with `db.query.X.findFirst` (it renames the table it selects from) — use `db.select()`.
  **A restrictable resource is a `VISIBILITY_RESOURCES` entry** (`services/access.ts`):
  `{ key, noun, usageKey, predicate, setGroups, grantRows, countGrants }`. Documents and a plugin's
  pages are two of them, an installed plugin (D31) adds its own through
  `ServerPlugin.visibilityResources`, and `setResourceGroups` / `grantsForResources` /
  `countGroupGrants` dispatch through the registry — never a new `if (kind === …)` branch
- Throw typed errors from `apps/web/src/api/utils/core/errors.ts` (`NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError`, …); never `c.json({ error }, 4xx)` by hand
- Pagination: `paginationQuerySchema` → `{ items, pagination: { page, pageSize, total, totalPages } }` (`packages/shared/src/pagination.ts`)
- **Feature flags gate at the MOUNT, and never through CASL** (D30). `requireFeature('x')`
  (`middleware/feature.ts`) is a middleware placed as the optional THIRD element of a mount-table
  entry in `api/index.ts` — `['/api/thing', thingRouter, requireFeature('thing')]` — so a surface
  that ships dark is dark as a whole rather than route by route, declared once like auth. It answers
  **404 `feature_disabled`**, not 403: a 403 confirms the feature exists. It reads
  `auth.features`, the same array a plugin's own registries read; an ability check would hand
  every global admin the dark surface, because `manage all` covers `access` on every `Feature:`
  subject. **The nav is not the only door** — a surface with no nav entry gates independently, and
  the sharpest kind is a hook that CREATES rows, which is why `ServerPlugin.hooks.onTenantCreated`
  is handed `features` (the analytics plugin's dashboard templates are the worked example)
- `TENANCY_MODE=single` (D25): routes that only make sense multi-tenant (`create-org`, `delete-org`, `/select-tenant`, `/admin/tenants` list) return 404 `tenancy_mode_single`; use the `requireMultiTenant` helper, don't inline the check
- **A READ stream is not a write stream, and the terminal convention INVERTS** (issue #7,
  `services/agents/run-stream.ts`). `chat-turn.ts` emits `RUN_ERROR` when its body throws, and it is
  right to: there the stream IS the run. A route that merely TAILS something durable — a Workflow in
  another isolate — owns nothing, so **it emits no `RUN_ERROR` for its own failure**; it logs and
  closes. Closing with no terminal event means *reconnect*, uniformly, for a redeploy, an idle cap, a
  duration cap, a transport error and a client abort. Three rules come with it: **the SSE `id:` goes
  on the LAST frame of a row's group and on no other frame in it** (one durable row is not one AG-UI
  event — a `text` row is `START → CONTENT → END`; put the cursor on the first frame and a mid-group
  drop leaves the client holding a message that never closes, for ever, with no error, while
  replaying a whole group is free because every id in it derives from the row id); **never
  `reconcileRun` — or any other Workflow/DO subrequest — inside the loop**, only once, before the
  first frame; and **never write a `: ping` comment frame when the negotiated transport is binary**,
  because it is not a valid protobuf frame and poisons everything after it. `?afterSeq=` beats
  `Last-Event-ID` when both arrive (an explicit client must win over a stale browser value), a
  garbage explicit cursor is a 400 and a garbage header is ignored
- **`reconcileRun` costs a Workflow subrequest, so a caller that can PROVE the run is alive does not
  make one.** Keeping it out of the stream loop is only half the rule: a client re-reading a run on
  every new event puts the same loop on the read path instead. `reconcileRun(db, env, run, {
  lastEventAt })` returns the row untouched — before the binding is touched at all — when the run
  wrote a durable event inside `RECONCILE_LIVENESS_MS` (30 s), because a run that emitted two
  seconds ago has not had its instance vanish, which is the only thing this function is for. The
  argument is **optional and opted into per call site**, never a default: a route that already has
  the log passes `events.at(-1)?.at` (`GET /runs/:id`, `GET /runs/:id/agui` — read the log FIRST,
  then settle; settling writes no event, so nothing is lost), and a route with no log passes nothing
  and reconciles as before. The cost is bounded and stated: a dead instance is detected up to one
  window later
- **Streaming routes speak AG-UI** (`services/ai/chat-turn.ts` is the ONE implementation; `routes/chat.ts` and `routes/agui.ts` are wrappers around it): resolve, authorise, validate and write anything that can fail as JSON **before** the stream opens — after the first frame a failure can only be a `RUN_ERROR`. Inside the stream use `streamDatabase(c)` (`utils/routes/route-helpers.ts`) for every write and close it in the stream's `finally`: `databaseMiddleware` ends the request's `db` in `waitUntil` the moment the Response object is returned, which is BEFORE the stream body runs. Transport is hono's generic `stream(c, cb)` plus `createAguiEncoder(c.req.header('Accept'))` (`services/ai/agui.ts`) — **never `streamSSE`**, whose `writeSSE` imposes an `event:` line and pins the content type, and spec AG-UI frames are `data:` only. `encodeBinary` covers SSE and protobuf in one path; await every write and the tracer flush inside the stream — there is no `defer` after the Response. A cancelled run emits NOTHING: closing with neither `RUN_FINISHED` nor `RUN_ERROR` IS the cancellation signal

## Contracts live in `packages/shared` (`@rocketflare/shared`)

A new or changed API surface starts as a zod schema in `packages/shared/src/<module>.ts`, exported
from `index.ts`, imported as `@rocketflare/shared/<module>` by the route (`validate()`), the UI
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

## AI services (D17, D18, D32) — `services/ai/*`, `services/agents/**`, `services/prompts.ts`

- **One resolve seam.** `resolveChat(db, cfg, env, tenantId, { promptKey? })` / `resolveEmbeddings(...)` in `services/ai/resolve.ts` are the ONLY readers of `ai_configs` / `agent_models` and the only decrypt. The platform chat tier (`ANTHROPIC_API_KEY` → `workers_ai` via `env.AI` → none) is `platformChat(cfg, env)` — `resolveChat`, `readiness` and `routes/ai-agent-models.ts` read it; never re-derive the chain in a route. Feature code never imports an SDK, never queries those tables, never sees a key; it asks for a client and calls it through `services/ai/kit.ts` (`runStreamingChat`, `runToolLoop`, `callStructuredTool`). No client → `AiNotConfiguredError` (503 `ai_not_configured`) — throw it before any row is written or any stream opens. Tests `vi.mock('@/api/services/ai/resolve')` (`// @vitest-isolate`) and hand in `FakeChatClient`
- **Never log or return a credential.** Rows leave as `hasCredential`; every provider failure goes through `normalizeAiError` → `AiError { code }` whose message is `redactSecrets`'d; the user-facing sentence is `describeAiError(err)`, never the vendor body. Encrypt with `encrypt(key, requireEncryptionKey(cfg))` (`auth/oauth-encryption.ts`) at the route
- **Per-tenant request defaults live in the adapter** (`service_tier`, `thinking` — explicitly disabled by default), never at call sites; a new cross-cutting concern is another client wrapper (`traceChatClient`, `tapUsage`), not a fork of the adapter
- **`recordUsage(db, …)` on every model call** (`services/ai/usage.ts`): `feature` is the prompt key or `agent:<key>`, with `provider`, `model`, the `TokenUsage`; the cost is filled from `@rocketflare/shared/ai/pricing` at write time (pass `costMicrocents` only to override) and an unknown model stays null. The chat route records after the stream (on the stream DB client); agents record from `callStructuredTool`'s `onUsage` / the loop's summed usage
- **Trace every LLM call** (D32): `withAgentTrace(name, { tracer, tenantId, userId, conversationId | runId, … }, trace => traceChatClient(client, trace, { provider }, tracer))`. `withAgentTrace` makes its span ACTIVE (`observability/context.ts`, `AsyncLocalStorage`), so tool spans (recorded by `kit.ts`'s one tool runner — never trace a tool yourself), `searchChunks`' `retrieval` span and `traceEmbed` batches nest under it with no extra parameter; `traceStep` nests anything else. `tracer` comes from `withAuth` in a route, from `ctx.tracer` in a job (`JobContext.tracer`, optional — `?? noopTracer`), and from `tracerFor(cfg, { store: databaseSpanStore(db) })` in a Workflow step — flush it yourself there, BEFORE the step's client closes (no `waitUntil`). A run's steps join ONE trace: `traceId: traceIdForRun(runId)`, `parentSpanId: rootSpanIdForRun(runId)`, `spanName: 'execute#N'`; the root is recorded by the `finish` step (`recordRunRoot`). Attribute names only in `genai-attributes.ts`
- **The knowledge tools read what their REQUESTER may read** (D29): `AgentToolContext` carries
  `scope: AccessScope`, built in `executeRun` from `agent_runs.requestedByUserId` at EXECUTE time
  (current membership, not a snapshot from enqueue); a run with no requester gets tenant-visible
  documents only. `searchChunks(db, cfg, env, scope, request)` and the three `document-content.ts`
  readers take the scope, not a tenant id. `fullAccessScope(tenantId)` is for maintenance paths only
- **Agents read knowledge through `ctx.tools`** (`services/agents/tools/`): `search_knowledge` = `searchChunks` bound to the run's `tenantId` (whole passages, grouped by document, each located by `passage`/`charOffset`), `get_document` = a tenant-scoped `{ offset, maxChars }` window over `documents.content`, `list_documents` = what is indexed. An agent that uses `runToolLoop` includes `ctx.tools`. **A tool answer is JSON the model can act on**: never a bare "nothing found" — a dead end carries `error` + `hint` and, where it helps, the documents that DO exist (`listKnowledgeDocuments`), and a nearest-neighbour ranking says so (`note`) rather than implying relevance. Add kit-wide tools in `buildAgentTools` (`tools/index.ts`), never by importing `searchChunks` into an agent
- **Agents: routes enqueue, never run.** `POST /api/agents/runs` → `enqueueRun(db, c.env, …)` (validate → `queued` row → `AGENT_RUN_WORKFLOW.create({ id: runId })` → 202). Missing binding → `AgentRunsNotConfiguredError` (503 `agent_runs_not_configured`). Never call an agent's `run()` from a route. Reads go through `settleOnRead`; cancel through `requestCancel` (cooperative — the run polls `checkCancelled()` — escalating to a forced terminate + settle when a cancel was already requested; pass `c.env` so it can)
- **A route also PARKS and RESUMES a run** (issue #17). `POST /runs/:id/interrupts/:interruptId` is `update AgentRun` PLUS the agent's `approvers` policy (`'requester' | 'admin'`, via `canAnswer`), validates the body with `interruptPayloadSchema(spec)` — the SAME function the UI validated its draft with — then `resolveInterrupt` (a **compare-and-set on `status = 'pending'`**, so two people answering at once is one 200 and one 409 `interrupt_not_pending`, never a lost decision), `resumeRun` and only THEN `nudgeOrRestartInstance`. **The answer is the transition**: flip the row first, wake the instance second, and `sendEvent` carries `{ interruptId }` only — a payload on the wire would be a second source of truth that can disagree with the audit row. `instance.not_found` there is recovered, not failed: start `<runId>-r1`. `POST /runs/:id/steering` appends a note to a live run (409 on a settled one); `GET /api/agents/interrupts` is the tenant-wide inbox, returning `canAnswer` PER ITEM rather than filtering
- **`GET /runs/:id` reads the log, THEN settles, THEN reads the asks — the order is the contract.** Reading the interrupts before the settle returns a `pending` ask beside a `cancelled` run, which is a screen nobody can act on. And `reconcileRun` only touches the binding when the row has been quiet for `RECONCILE_LIVENESS_MS`: a run that emitted a durable event seconds ago is alive by definition, and a Workflow subrequest per reader per tick to be told so is what that guard removes
- **A step retry OR a resume re-enters the agent from the top**, so `run()` must be safe to re-run: side effects (an ingest, a ledger write, tokens) go through `ctx.once(key, fn)` — once per `(run, key)`, guaranteed by the unique index on `agent_run_effects`, result stored as jsonb so **return ids, not rows** (at-least-once with a recorded result, not exactly-once). A `runToolLoop` agent passes `resume: await ctx.checkpoint.load()` + `onCheckpoint: ctx.checkpoint.save` so the retry continues the conversation instead of re-paying for it, and rebuilds any state it derived from tool results DURING the loop out of the resumed transcript. A checkpoint that will not parse is `null` — the run starts fresh, never fails
- **`ctx.interrupt({ key, spec })` is how an agent asks a person**, and its `key` is MANDATORY and must be stable across attempts — `UNIQUE (run_id, key)` is what makes the re-entered `run()` find the ANSWER instead of asking again, forever. Derive it from an entity id, a step name or the question; never a counter or a clock. Everything after it is on the far side of a park that may last days and span a deploy, so it goes behind `ctx.once`. A declined `approval` throws `InterruptDeclinedError` (the run settles `cancelled`, `error` NULL); `choice`/`input`/`form` resolve `cancelled` and hand the refusal to the model. For a tool the MODEL calls, the gate is on the TOOL (`Tool.requiresApproval` / `requiresApprovalWhen(input)`), enforced by `runToolLoop` before any handler runs — and that loop MUST be passed `approvals: ctx.approvals` and `runApproved: ctx.once`, or the gate is re-asked and the approved call runs twice. `ctx.artifact({ key, title, data })` upserts what the run PRODUCED (the table is the store, the event row only its position); `ctx.steering()` delivers notes exactly once and is folded in through `beforeTurn`
- **Workflow steps open their own DB client** (`withStepDatabase` in `api/workflows/agent-run.ts`) and close it in `finally`; step bodies are plain functions in `services/agents/runtime.ts` (`claimStep`, `executeRun`, `finishStep`) so tests call them with `{ db, env }`. Everything in a step is awaited — nudges through `createStepRealtime().settle()`, events through `emit` — there is no `waitUntil`. Every terminal write names `ACTIVE_RUN_STATUSES`; the CLAIM names the narrower `CLAIMABLE_RUN_STATUSES`, and `finishStep`'s "still active at the end → fail it" backstop keeps a third, narrower list still — widening that one turns every parked run into a `failed` row
- **Prompts are code.** A new system prompt is a `CORE_PROMPT_REGISTRY` entry in `services/prompts.ts` (title, description, `variables`, `defaultText`) read through `resolvePrompt(db, tenantId, key, vars)`; never a hard-coded string in a route or agent. Adding an agent: `CORE_AGENT_KEYS` + schemas in `@rocketflare/shared/ai/agents` → prompt → `services/agents/examples/<key>.ts` → `CORE_AGENTS` entry (`docs/ADAPTING.md` §3)
- **Two ways in, one ingest path**: `ingestText(db, cfg, env, input, { jobs })` (JSON text) and `ingestFile(db, cfg, env, input, { jobs, storage })` (multipart — original to R2 as a `files` row scope `documents`, `fileId` on the document) — text-like types index inline ≤ 50 chunks else a `document.index` job; PDF/Office/HTML enqueue `document.convert` (`convertAndIndexDocument`: R2 → `env.AI.toMarkdown` → the same `indexDocument`). Everything that can 503 (`resolveEmbeddings`, `canConvert`) runs BEFORE any write; the upload route maps `ConversionNotConfiguredError` → 503 `conversion_not_configured`. Retrieval only through `searchChunks`; reading a document's TEXT only through `services/ai/document-content.ts` (`readDocumentWindow` / `listDocumentPassages` / `readDocumentCard`), which BOTH `get_document` and `GET /api/ai/documents/:id/{content,passages,card}` call — never a second slice in JS, and never a `select()` over `chunks` that could widen onto `embedding`. Both carry the tenant predicate on every query; `documentId` narrows, never replaces it. `DELETE /:id` deletes the original too (`deleteStoredFile`); `/api/files` refuses a `documents`-scope delete with 409 `owned_by_document`
- Routers: `/api/ai/config` (`aiConfigRouter`: list · `providers` · `readiness` · `test` · upsert · delete), `/api/ai/prompts`, `/api/ai/usage` (`/summary`), `/api/ai/agent-models`, `/api/ai/documents` (`ingest` · `upload` · list · `search` · get · `:id/content` · `:id/passages` · `:id/card` · delete), `/api/chat` (conversations + the AG-UI `messages` stream), `/api/agui` (`POST /run` — the `RunAgentInput` endpoint; same `streamChatTurn`), `/api/traces` (D32: `GET /` list · `GET /:id` by trace, run or message id — `read Trace`, admin+ only, from `services/traces.ts`), `/api/agents` (registry · `runs` list/create/get/cancel · `runs/:id/agui` · `runs/:id/agui/stream` · `runs/:id/interrupts/:interruptId` · `runs/:id/steering` · `interrupts` — the inbox). Permissions: `AiConfig`/`Prompt`/`Document` admin+ `manage`, member `read` (+ `create Document`); `Conversation`/`AgentRun` `manage` for all with ownership route-side (`userId` filter → 404; `isAdminLevel(auth)` widens runs), and answering an interrupt is `update AgentRun` plus the agent's `approvers`; `Trace` (D32) is `read` for owner/admin/support only — a span holds other people's prompts, so members get nothing, not even their own runs

## Analytics — a PLUGIN, not core (D19 · D31)

Cubes, dashboards, fact tables, `/cubejs-api` and `/mcp` left the kit in 0.6.0 for
`rocketflare-plugin-analytics` (`docs/CONCEPTS.md` §8). **The conventions did not change, they
moved**: once installed they are in `apps/web/src/plugins/analytics/CLAUDE.md`, `cubes/CLAUDE.md`
and `services/fact-tables/CLAUDE.md`. Three things a KIT route author still has to know:

- **A plugin's routes are kit routes in every respect** — `createRouter()`, `validate()` with a
  contract from its own shared entry, `guardPermission` with its own subject, `withAuthAndDb` for
  the tenant id, typed errors, and a tenant predicate on every query. What differs is only where
  they are REGISTERED: `ServerPlugin.mounts`, not `api/index.ts`'s table.
- **A prefix outside `/api` costs three core edits the plugin cannot make**: `ServerPlugin.apiPrefixes`
  feeds `API_PREFIXES` (the SPA catch-all's JSON-404 guard and the parity test), but
  `[assets] run_worker_first` in BOTH tomls and the Vite dev proxy are files a plugin never touches.
  `pnpm plugin add` prints them; `pnpm provision cloudflare <env>` writes the toml half.
- **A registry a plugin composes into is a FUNCTION, not a const.** `visibilityResources()` is the
  kit's worked example: it reads the plugin barrel, a plugin's visibility resource imports this
  module, and evaluated at module scope one side finds `serverPlugins` `undefined` — which fails at
  IMPORT time, not per request. Anything a plugin needs as a VALUE moves to a leaf
  (`services/access-sql.ts`) and is re-exported here so no core importer moves.

## Feature flags (D30) — `permissions/features.ts`, `middleware/feature.ts`, `services/features.ts`

- **One seam**: `resolveFeatures(cfg, flagRows, { tenantId, userId })` is the only place the two
  layers combine — `FEATURES_ENABLED` in `[vars]` (does this deployment ship it at all? fail-closed,
  consulted only for an `environmentGated` flag) and the `feature_flags` / `tenant_feature_overrides`
  rollout state. A third source unions in there and no consumer changes. It returns `[]` without a
  tenant
- **Keys are code**: `CORE_FEATURES` in `@rocketflare/shared/permissions` + metadata in
  `CORE_FEATURE_FLAGS` (`@rocketflare/shared/features`), the `CORE_PROMPT_REGISTRY` pattern. No migration to add one; evaluation
  iterates the registry, so an orphaned row is inert. There is no create endpoint by design
- **`featureBucket` is a wire format** — changing the hash, separator or modulus reshuffles every
  live rollout. Golden vectors in `tests/config/features.test.ts` are the guard. The percentage is
  never hashed in, which is what makes a rollout monotonic (raising it only ever adds)
- Admin CRUD lives on `routes/admin.ts` behind `globalAdminMiddleware`; the override sub-routes call
  `requireMultiTenant`, the list and `PATCH` do not. `GET /api/features` is the member-level
  effective list (and the CLI's, since a Bearer key cannot reach `/api/admin/*`)

## Plugins (D31) — `src/plugins/*`, the server barrel

A plugin is a separate git repository copied into the app that contributes through
`ServerPlugin` (`apps/web/src/plugins/types.ts`). Server-side rules, all of them checkable:

- **A plugin imports the host only from a DECLARED entry, and receives everything else as injected
  context.** On the server that entry is `@/plugins/api`: `const ctx: RequestCtx = requestCtx(c)` in
  a route, `jobCtx` in a handler, `cronCtx` in a task, `toolCtx` in an agent tool, `workflowCtx` in
  a Workflow, `HookCtx` / `SeedCtx` in the two hooks, `DetachedCtx` for a callback that outlives the
  handler. The methods are the kit's own helpers under another name — `ctx.guard`, `ctx.uuid`,
  `ctx.page`, `ctx.enqueue`, `ctx.nudge`, `ctx.notFound`, `ctx.defer`, `ctx.storage`, `ctx.scope` —
  and the ADAPTER (`requestCtx` and its siblings) is the only thing that reads the kit's internal
  context, which is what lets `cfg` stay `cfg` in a kit route while every plugin says `config`.
  `docs/plugin-api.md` is the generated reference; `tests/helpers/plugins.ts` enforces the rule and
  every diagnostic carries the replacement import. **Annotate the context explicitly** —
  `ctx.notFound()` returns `never`, and TypeScript narrows on that only when the call target is
  explicitly typed, so `const ctx = requestCtx(c)` throws at runtime while the compiler still
  believes the row may be undefined
- **The two things that cannot be injected are entries instead**: `@/db/schema/kit` for a table file
  (a `pgTable(...)` runs at module scope, and drizzle-kit reads it statically — imported by RELATIVE
  path, since drizzle-kit bundles that file and resolves no tsconfig alias) and the split UI kit.
  `@testkit/{integration,unit}` is the third, for a plugin's tests
- **Compatibility is OBSERVED, not versioned.** There is no plugin-API number: a plugin declares a
  top-level `minKit` (one bare `X.Y.Z` floor, no ceiling) and `uses` (the host symbols it imports,
  derived by `pnpm plugin export`), the kit emits its surface as the `## Surface ledger` block of
  `docs/plugin-api.md`, and the check is `uses \ ledger` — a set difference that cannot throw and
  names each missing symbol with its replacement import. Change or remove a member of a declared
  entry → regenerate `docs/plugin-api.md` (`node scripts/plugin-api-doc.mjs`) and commit it; the
  gate diffs the file, and any plugin naming the removed symbol fails `pnpm plugin check` by name.
  `requires.kit` and `requires.pluginApi` were both PREDICTIONS, both went stale, and both are now
  refused by name rather than ignored

- **`mounts` are spread LAST into the mount table of `api/index.ts`**, so the enumerable auth
  surface stays one list. An entry is the same tuple a kit mount is — `['/api/<id>', router,
  middleware?]` — and the prefix is `/api/<id>` by convention, which is what stops two plugins
  claiming one path. A prefix the Worker owns OUTSIDE `/api` also goes in `apiPrefixes`, or the SPA
  catch-all answers `index.html` for it
- **A feature flag gates the MOUNT, not each route** — `requireFeature('<id>')` as the third element,
  exactly like a kit surface, answering 404 `feature_disabled`. Never `access Feature:<id>`: a global
  admin's `manage all` satisfies the CASL form (§ Feature flags above)
- **`jobHandlers` is checked against the plugin's OWN `shared.jobs`** (`{ [T in JobTypeOf<S>]: … }`),
  so a declared variant with no handler is a type error in the plugin rather than a dispatch failure
  in the host. Namespace every `type` `<id>.verb`; the handler contract is the kit's (own DB client,
  await everything, throw to retry)
- **`agentTools(ctx)` is bound to the run's `AgentToolContext`**, which carries the `AccessScope` —
  so a plugin tool reads what its REQUESTER may read, never a bare `tenantId` it chose itself. It is
  appended after the kit's three knowledge tools; a test that pinned the exact tool list must become
  a prefix assertion
- **`grants` is ADDITIVE and over the plugin's OWN subjects.** It runs after the kit's matrix in
  `buildAbility`; CASL can take a rule back only with `cannot`, so a plugin that revoked a kit grant
  would change what every role may do merely by being installed. Declare the subject in
  `SharedPlugin.subjects`, then grant it here
- **`hooks.onTenantCreated`, `hooks.onTenantDeleted` and `hooks.seedDemo` are post-commit, idempotent and best-effort**, each
  try/caught by the host after the kit's own — a plugin hook that throws must never break sign-up or
  invite accept, so nothing a tenant NEEDS may arrive only that way. `seedDemo` gets a `demoId`
  already namespaced with the plugin's id; fixed ids + `onConflictDoNothing`, as everywhere
- **`onTenantDeleted` is for state the FK cascade cannot reach**, and nothing else: a plugin's
  TABLES are already gone. It runs from the `tenant.purge` job with the tenant id and `env`, so a
  plugin reaches its own R2 prefix, KV keys or Durable Object through the bindings rather than a
  global. **DO state is purgeable only because instance names are DERIVED**: nothing enumerates the
  instances of a namespace, so a plugin declares a FINITE key set derived from the tenant id and the
  purge loops the declared keys, never instances (`NotificationsHub`'s `idFromName(tenantId)` is
  already that shape). One DO per ROW cannot be purged under this rule; the escape hatch is a
  purge-intent ledger — a table carrying `tenant_id` with NO foreign key, so it survives the cascade
  (`access_requests.requested_tenant_id` is the precedent) — and it is **deferred until somebody
  needs it**, deliberately not built
- `visibilityResources` (D29) registers rows a group may restrict — `{ key, noun, usageKey,
  predicate, setGroups, grantRows, countGrants }` in `services/access.ts`'s registry, so the
  predicate is SQL ANDed onto the tenant one and the 409 `group_in_use` count includes it.
  `rlsExcludedTables` and `unscopedAllowlist` are the plugin's own entries in the two enforcement
  tests, keyed exactly as the kit keys its own (a path under `apps/web/` → the reason)
- **Module-evaluation order is the one trap the type system cannot see.** The barrels are read at
  MODULE SCOPE by `queues/jobs.ts`, `services/agents/registry.ts`, `services/prompts.ts`,
  `api/scheduled.ts`, `utils/routes/api-prefixes.ts` and `services/access.ts`, so a plugin module
  that reads a module-scope value from one of those at its OWN module scope closes a cycle and one
  side holds `undefined` — a crash at import, not a compile error. `example-feature` shows the two
  avoidances: **`import type`** for anything only needed as a type (`AgentToolContext`, `Tool`), and
  **naming the file directly** rather than the barrel (`db/schema/feature-flags`, because
  `db/schema/index.ts` re-exports `plugins/schema.ts`, which re-exports the plugin). The shared side
  has the same rule and a test for it (`tests/config/shared-imports.test.ts`)

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
| fire-and-forget, < 30 s total | `JOBS_QUEUE` | producer `enqueueJob(queue, input)` / `enqueueJobs` in `apps/web/src/api/services/jobs.ts` (validates `jobInputSchema` from `@rocketflare/shared/jobs`, stamps `{ id, enqueuedAt }`); consumer `processJobsBatch(batch, { env, config, logger })` in `apps/web/src/api/queues/jobs.ts` dispatching on `type` to `queues/handlers/*`; `apps/web/src/api/queue.ts` routes `batch.queue` by prefix (`isJobsQueue`) |
| multi-step, retries, minutes+ (agent runs) | `AGENT_RUN_WORKFLOW` — `AgentRunWorkflow` (`api/workflows/agent-run.ts`) | `enqueueRun` (`services/agents/runs.ts`): the `agent_runs` row first, then `create({ id: runId })` — the instance id STARTS as the run id and becomes `<runId>-rN` if a park has to be restarted; the row is the claim (`UPDATE … WHERE status IN (queued,running) RETURNING` — `CLAIMABLE_RUN_STATUSES`); exclusive = a partial unique index over the WIDER `ACTIVE_RUN_STATUSES` (a parked run holds the slot), dedupe returns the active run; steps `claim → execute#N (retries 2, 10 min) → resume#N \| expire#N → finish` |
| periodic | `[triggers] crons` | `apps/web/src/api/scheduled.ts` `SCHEDULED_TASKS` dispatches on `event.cron`; each task try/caught; one DB client per run. `0 4 * * *` → `pruneExpired`, plus every installed plugin's `scheduledTasks` (the analytics plugin's `15 * * * *`). **A plugin declares the TASK and the kit's tomls declare the EXPRESSION** — a task under an expression no toml carries never runs |

Jobs rules (D7):

- **Adding a job type** = a variant in `CORE_JOB_VARIANTS` (shared — `jobInputSchema`, `jobEnvelopeSchema`, `JobType` and `JOB_TYPES` are all DERIVED from that one list), a handler in `queues/handlers/`, and its entry in `coreHandlers` (`queues/jobs.ts`). **There is no `runHandler` switch**: the mapped type `{ [T in CoreJobType]: JobHandler<T> }` is the completeness check, and dispatch is `handlers[job.type](job as never, ctx)`. A plugin (D31) brings its variants in `SharedPlugin.jobs` and its handlers in `ServerPlugin.jobHandlers`, checked against the types IT declared
  (`packages/shared/src/jobs.ts`). The `type` string is the version seam: a breaking payload change
  is a new type (`email.send.v2`), never an edited schema. `handlers/document-index.ts` is the
  shortest kit handler to copy; `src/plugins/example-feature/jobs/ping.ts` is the shortest one full stop
- Handler signature `(job: JobOf<'x'>, ctx: { env, config, logger, db, tracer? })` (`tracer` is the message's span recorder, flushed by the consumer before `db` closes — an AI handler brackets its work in `withAgentTrace(..., { kind: 'job', spanName: 'job <type>' })`); each message gets its
  own DB client, closed in `finally`. **Never `waitUntil` in a consumer — await everything**; a
  handler that throws is retried, one that returns is acked
- Poison policy: an envelope that fails `jobEnvelopeSchema` is logged and **`ack()`ed** (retrying
  cannot make it valid). Handler error → `retry({ delaySeconds: backoffSeconds(attempts) })`, 30 s
  doubling to a 15 min cap; the toml's `max_retries = 3` ends it. Unknown queue → `ackAll()`
- Missing `JOBS_QUEUE` → `JobsQueueNotConfiguredError`, never a silent inline fallback. Queued in
  the kit: `tenant.purge`, and invitation (create/bulk/resend) and access-request-decided emails. The **magic-link email
  stays inline** — a person is waiting on it
- **`tenant.purge` is the out-of-database half of deleting a tenant.** The FK cascade is complete
  inside Postgres and reaches nothing else, so `deleteTenant` proves the queue binding BEFORE the
  `DELETE` (a deployment that cannot purge must fail while the tenant still exists), then enqueues
  with the tenant id and slug — the row is gone, so the payload is all the handler will ever have.
  The handler runs every plugin's `onTenantDeleted` first (each try/caught, so it cannot fail the
  job) and then `purgeTenantObjects`, which pages `tenants/<id>/` with `listPage` + `deleteMany`. A
  missing `FILES` binding is ACKED with a log — no binding, no objects, and no retry can conjure one
  — which is deliberately the opposite of `document.convert`, where the bytes exist and are
  unreachable. An R2 error throws and is retried: the alternative is a tenant's files living on for
  ever because one list call timed out. Everything in it is idempotent, which is what makes that
  retry free
- `example-feature.ping` is the smoke job and it belongs to the `example-feature` PLUGIN (D31), not to the kit: `POST /api/example-feature/ping` (or `rocketflare example-feature ping`) enqueues it, then watch `wrangler dev`. The shape to copy is `apps/web/src/plugins/example-feature/jobs/ping.ts`
- `chat.compact` (D17) folds the messages outside a conversation's `CHAT_HISTORY_MAX_CHARS` budget into `conversations.summary`; the window comes from the same pure `selectHistoryWindow` the route uses, and the write is a compare-and-set on `summarised_through_id` so two deliveries cannot lose an update. `document.index` (D18) re-indexes a `documents` row from its stored `content` (`handlers/document-index.ts` → `indexDocument`); the message carries ids only. `ingestText` enqueues it for texts over 50 chunks

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
(`REALTIME_INVALIDATIONS`) live in `@rocketflare/shared/realtime` — add a type there, not in a route. The
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

# 05 — Async work, realtime, email, storage

Scope: background jobs, realtime notifications, email, file storage — across
`~/work/mirevue` (Node/Postgres structural reference) and
`~/work/guidemode/apps/server` (Cloudflare substrate reference). Target: one
Workers script, DO in-script, Hono + Drizzle.

Paths below are relative to `~/work/mirevue/` (MV) or
`~/work/guidemode/apps/server/` (GM).

---

## 0. One-paragraph verdict

Take **GM's Cloudflare substrate** (Queues consumer routing, `WorkflowEntrypoint`
+ `step.do`, `scheduled()` dispatcher, `NotificationsHub` DO with hibernation,
native R2 binding) and **Mirevue's discipline** (a single `Broadcaster` seam
that routes never bypass, WS upgrade auth that checks tenant membership, a
config-driven email service with a dev fallback, a narrow `StorageService`
interface). The one cross-cutting principle both repos arrive at independently
— **"the database is the truth; the websocket is a nudge"** (MV
`agent-run-log.ts:10-20`, GM `notification.ts` `broadcastOssCorpusPassEvent`
docblock) — should be stated in the kit's rules file and is what makes the
pg-boss → Workflows move survivable.

---

## 1. Background jobs

### 1.1 Mirevue: pg-boss (what the semantics actually are)

| Concern | Where | Semantics |
|---|---|---|
| Enqueue | `src/api/services/agent-queue.ts:246-320` `enqueueRun` | Resolve AI client → `precheck` → insert `agent_runs` row (`queued`) → `boss.send(name, data, { singletonKey: tenantId:sessionId, startAfter })` → `null` jobId means policy rejected → delete row, return `busy` |
| Concurrency policy | `agent-queue.ts:193-203` `ensureAgentQueue` | `exclusive` (one queued OR active per key; extra triggers dropped) or `stately` (one per state: one active + one queued = coalesce/back-pressure) |
| Debounce | `agent-queue.ts:214-232` `debounceSeconds` → `startAfter` | **Leading-edge** window, deliberately not trailing-edge |
| Liveness | `agent-queue.ts:72-103` `JOB_EXPIRE_SECONDS=1800`, `JOB_HEARTBEAT_SECONDS=60` | Heartbeat distinguishes dead worker from slow agent |
| Retry | `retryLimit: 2, retryBackoff: true, retryDelayMax: 60` | Attempt number reaches handler via `job.retryCount` |
| Durable progress | `src/api/services/agent-run-log.ts` | Append frames to `agent_run_events` (`seq` continues across retries), then `pg_notify`; SSE reader replays from table + follows NOTIFY (`src/api/utils/routes/agent-progress.ts:170` `streamRunProgress`, resumable via `Last-Event-ID`) |
| Cancellation | `agent-runtime.ts:650` `cancelAgent` + `AGENT_RUN_CANCEL_CHANNEL` | Mark rows, `boss.cancel`, `pg_notify` so the replica owning the loop aborts |
| Orphan recovery | `agent-runtime.ts:712` `recoverOrphanedRuns` + `agent-queue.ts:332` `isJobLive` | On boot: `running` rows whose job is not `created/retry/active` → failed |
| Worker start | `src/server.ts:88-90` → `agent-worker.ts:97-149` `startAgentWorkers` | One `boss.work` per agent queue + `PLAIN_QUEUES` + `MAINTENANCE_QUEUE` cron via `boss.schedule('*/5 * * * *')`. Only `server.ts` starts workers, so tests importing `app` never spawn a poller |
| Plain queues | `prep-document-queue.ts:228` `definePlainQueue`, `PLAIN_QUEUES` list at `:861` | `stately` + per-subject `singletonKey`, no `agent_runs` row |
| Schema init | `scripts/queue-init.ts` → `agent-worker.ts:222` `initQueueSchema` | pg-boss owns `pgboss` schema outside drizzle; run as migrate-step |
| Test drain | `tests/helpers/queue.ts:54` `drainQueue`, `agent-worker.ts:165` `runQueuedJobsOnce` | Deterministic in-test execution, ignores `startAfter` |

### 1.2 GM: Queues + Workflows + cron

**Queues.** Two queues declared as producer+consumer pairs in `wrangler.toml:101-123`
(`SESSION_PROCESSING_QUEUE`: `max_batch_size=1, max_batch_timeout=60,
max_concurrency=5, max_retries=3, retry_delay=120`; `BILLING_QUEUE`: same shape,
`retry_delay=60`). One `queue()` handler routes on `batch.queue` string
(`src/api/index.ts:545-562`) to `processBillingUpdate`
(`src/api/queues/billing-consumer.ts`) or the inline `processSessionProcessing`
(`index.ts:565-712`). Consumer builds its own db via
`createDatabaseWithHyperdrive(env.HYPERDRIVE, env.DATABASE_URL)`, uses
`message.ack()` / `message.retry({ delaySeconds })` (`index.ts:625`) and
`batch.retryAll()` on missing bindings. Producer is a thin static class over
`queue.send(message)` (`src/api/services/billing-queue.ts`). Progress is
broadcast from inside the consumer via `NotificationService.broadcastProgressEvent`.

**Workflows.** 11 classes (`wrangler.toml:125-190`, each `[[workflows]]` =
`name` + `binding` + `class_name`), all re-exported from `src/api/index.ts:733-743`.
Shape (`src/api/workflows/aiva-interview-processing-workflow.ts:38-120`):

```ts
export class X extends WorkflowEntrypoint<CloudflareEnv, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const env = this.env
    const db = createDatabaseWithHyperdrive(env.HYPERDRIVE, env.DATABASE_URL) // outside step.do
    const cfg = await step.do('load-config', { timeout: '1 minute',
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' } }, async () => …)
```

- db/env: `this.env` bindings; db handle created once in `run()` and closed over by steps.
- Progress: **two channels** — a DB row per run (`linearSyncLog` updated with
  `updateSyncStep`, `linear-sync-workflow.ts:150`) plus a WS nudge
  (`broadcastProgress` → `NotificationService.broadcastSyncProgressEvent`,
  `workflows/utils/sync-workflow-utils.ts:70-97`). Non-critical; swallowed on failure.
- Cancellation: cooperative — `checkCancellation(db, table, id)` at the top of
  each step (`sync-workflow-utils.ts:137`), reading a `status='cancelled'` flag.
- Dedupe: deterministic instance id + probe (`src/api/services/oss-corpus/dispatch.ts:165-217`
  `instanceExists` via `workflow.get(id)` try/catch; `force` appends a millisecond).
- Status reconciliation: `oss-corpus.ts:470` — `instance.status()`; an
  `instance.not_found` **is an answer** (the pass is dead), not an error.
- Trigger: `c.env.X_WORKFLOW.create({ id?, params })` from routes (8 sites, e.g.
  `routes/aiva-interviews.ts:418`) and from cron (`src/scheduled.ts:270`).
- Limits: script-wide `[limits] cpu_ms = 300000` (`wrangler.toml:26-64`) was needed
  because Workflows bound CPU **per step** at the default 30s — the kit should
  document this footgun and start with the default.

**Cron.** 8 expressions in `wrangler.toml:236-247`; **one** `scheduled()` handler
(`src/scheduled.ts:57`) that derives `minute/hour/date` from
`event.scheduledTime` and gates each task with `if (hour === N && minute === 0)`.
Each task is wrapped in its own try/catch ("don't throw — allow other tasks to
continue"). The monthly task must additionally gate on `date === 1`
(`scheduled.ts:64-66` comment) — a footgun that dispatching on `event.cron`
would avoid. Long work (corpus sync) is **dispatched to a Workflow**, not run
inline (`scheduled.ts:258-275`).

### 1.3 Mapping: pg-boss → Cloudflare

| pg-boss semantic (MV) | CF equivalent | Survives? | Kit should… |
|---|---|---|---|
| `boss.send(queue, data)` fire-and-forget job | `env.QUEUE.send(body)` | Yes | one producer helper per queue, typed body |
| `retryLimit`/`retryBackoff`/`retryDelayMax` | consumer `max_retries`, `retry_delay` in wrangler.toml; `message.retry({ delaySeconds })`; `step.do` `retries` | Yes (config moves to wrangler + code) | put retry policy next to the consumer; add `dead_letter_queue` |
| `job.retryCount` in handler | `message.attempts` (Queues); Workflows retries are per-step and invisible | Partial | log `attempts`; don't build logic on it |
| `startAfter` (leading-edge debounce) | `send(body, { delaySeconds })` (0–86400s) | **Delays but does not collapse** | dedupe lives in DB/instance-id, not the queue |
| `expireInSeconds` / heartbeat | Queues: visibility handled by platform; Workflows: `step.do` `timeout` | Yes (platform-managed) | nothing to build |
| `policy: 'exclusive'` (singleton per key) | Workflow **deterministic instance id** (`create` with an existing id throws / `get` probe) | Yes — the only CF-native singleton | copy GM `dispatch.ts` pattern: `id = <kind>:<tenant>:<subject>[:<bucket>]` |
| `policy: 'stately'` (one active + one queued, coalesce) | none | **No** | either (a) DB claim row with `pending_rerun` flag the workflow checks at its end, or (b) time-bucketed instance ids. Do **not** fake it in-memory |
| `singletonKey` scoping | part of the instance id | Yes | — |
| Durable `agent_run_events` + `LISTEN/NOTIFY` wake | DB rows + DO broadcast as nudge; UI re-queries | Yes (different wake mechanism) | keep MV's `seq`-numbered event table if streaming is wanted; otherwise GM's status-row + `sync:progress` nudge |
| SSE `streamRunProgress` with `Last-Event-ID` replay | Works on Workers (Hono `streamSSE`), but wake needs polling or DO | Partial | kit v1: no SSE; progress via WS nudge + query invalidation |
| `pg_notify` cross-replica cancel | `checkCancellation` DB flag per step (GM) | Yes | cooperative cancel; document that a running step finishes |
| `recoverOrphanedRuns` / `isJobLive` at boot | `instance.status()` reconcile on read (GM `oss-corpus.ts:470`) | Yes — inverted (lazy, on read) | reconcile helper in the status route |
| `boss.schedule(cron)` maintenance | `[triggers] crons` + `scheduled()` | Yes | one dispatcher, one task |
| `boss.work` started only from `server.ts` | `export default { fetch, queue, scheduled }` — platform invokes | N/A | tests call `queue()`/`scheduled()`/workflow `run()` directly, or use `@cloudflare/vitest-pool-workers` |
| `scripts/queue-init.ts` schema step | none — queues/workflows are wrangler resources | Gone | `wrangler queues create` documented in README; local dev needs nothing |
| `runQueuedJobsOnce` / `drainQueue` | none built-in | Gone | expose consumer functions as plain `(batch, env)` functions so tests can invoke them with a fake `MessageBatch` |

**What does not survive and needs a decision:** `stately`/coalesce back-pressure
and in-test deterministic draining. Everything else has a CF-native home.

### 1.4 Recommended minimal set for the kit

- `src/api/queues/example-queue.ts` — producer helper `enqueueExample(env.EXAMPLE_QUEUE, {tenantId, …})`
  + consumer `processExampleBatch(batch, env)`; single `queue()` router in the
  worker entry switching on `batch.queue` (GM pattern). One queue only.
- `src/api/workflows/example-workflow.ts` — 3 steps, deterministic id helper,
  `checkCancellation`, DB status row (`background_runs` table: id, tenant_id,
  kind, status, step, error, started_at, finished_at), `broadcastProgress` nudge.
  Status route reconciles with `instance.status()` and treats `not_found` as dead.
- `src/scheduled.ts` — dispatch on `event.cron` (a `Record<cronString, task[]>`),
  each task try/caught; one task: prune expired sessions / rate-limit rows
  (MV `agent-worker.ts:152` `pruneRateLimitHits` is the exact analog). Local test:
  `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"`.
- Rules text: "A route never runs long work; it enqueues (fire-and-forget, <30s
  total) or creates a workflow (multi-step, retries, minutes+). Cron only
  dispatches." Adapt MV `.claude/rules/api.md:138-202`.

---

## 2. Realtime notifications

### 2.1 Mirevue

- Seam: `Broadcaster` interface (`src/api/services/notification.ts:31-39`), two
  adapters — in-process `ws` registry (`websocket.ts`) and
  `postgresBroadcaster` (`broadcaster-postgres.ts`: local delivery + `pg_notify`
  fan-out with `replicaId` echo suppression, no replay). Chosen by `BROADCASTER_DRIVER`.
- Public API: `NotificationService.broadcastDataEvent(tenantId, entity, action, data)`
  builds `{type: 'entity:action', entity, action, data, timestamp, tenantId}`
  (`notification.ts:123-142`); `broadcastInvitationEvent(userTenantIds, …)` fans out
  to every tenant a user belongs to.
- **Auth at upgrade** (`websocket-upgrade.ts:23-79`): parse `sessionId` cookie →
  `validateSession` → reject blocked users → `tenantId` from `?tenantId=` or
  `session.selectedTenantId` → **check `tenant_users` membership** → attach
  `{tenantId, userId}` to the request → `wss.handleUpgrade`.
- Protocol: `welcome`, server `ping` every 30s / client `pong`, `subscribe`/`unsubscribe`
  channel (`websocket.ts:155-225`).
- Client: singleton `src/ui/lib/websocketClient.ts` — same-origin `/ws?tenantId=`,
  exponential backoff **with full jitter** capped at 30s, max 10 attempts, resubscribes
  channels, `resyncAfterReconnect()` invalidates a broad key set because there is
  no replay (`:87-95`). Store `websocketStore.ts:205-248` maps `entity` → React Query
  keys to invalidate. `WebSocketProvider.tsx:28` connects once auth has a tenant.
- `useNotifications` hook (`src/ui/hooks/useNotifications.ts`) is the **in-app
  notifications table** (`src/db/schema/notifications.ts`), not the socket — the
  socket's `notification:created` event just invalidates its query.

### 2.2 GM

- DO: `src/api/durable-objects/notifications-hub.ts`. **Hibernation API**:
  `ctx.acceptWebSocket(server, [tenant:<id>, user:<id>])` (tags, `:44-49`),
  `serializeAttachment` for mutable `subscriptions` (`:52-58`),
  `setWebSocketAutoResponse(ping→pong)` in constructor (`:20-26`) so keepalives
  never wake the DO, `ctx.getWebSockets('tenant:<id>')` for tag lookup (`:83-85`),
  `webSocketMessage`/`webSocketClose`/`webSocketError` handlers. No `ctx.storage`
  → stateless → migrations are free (commit `c216e0c7`).
- Scoping: **one DO instance per tenant** — `idFromName(tenantId)` in both the
  connect route (`routes/websocket.ts:52`) and the publisher
  (`services/websocket-worker.ts:22`). Cross-tenant fan-out
  (`broadcastInvitationEvent`) loops tenants. `user:` tag exists but is unused for
  routing — a per-user broadcast is a 5-line addition.
- Publish path: **fetch, not RPC** — `stub.fetch('https://notifications-hub/broadcast', POST json)`
  (`websocket-worker.ts:24-28`); channel filter smuggled as `__channel` in the body.
  `getStats` is stubbed (`:59`). Switching to RPC methods (`DurableObject` subclass
  already extends `cloudflare:workers`) is trivial and typed — recommended for the kit.
- Connect path: `app.use('/ws', authMiddleware)` (`index.ts:338`) then
  `routes/websocket.ts:26-67` reads `c.get('session').tenantId` and forwards the
  upgrade to the DO with `?tenantId&userId`. **The DO trusts the query params**
  (`notifications-hub.ts:41-42` defaults to `'unknown-tenant'`) — acceptable only
  because the DO is reachable solely via the binding. GM does **not** let the client
  pick a tenant nor re-check membership (session tenant only); MV does both.
- `resolveBroadcaster(env)` (`services/notification.ts:41-51`): DO if bound, `ws`
  dev broadcaster if `NODE_ENV=development`, else no-op. `websocket-dev.ts` is
  **dead code** in practice — nothing but tests import `setupWebSocketServer`; dev
  runs the real DO via `wrangler dev -c wrangler.toml -c wrangler.notifications.toml`
  (`package.json:8`). `routes/websocket.ts:70-185` also carries a second, unused
  in-memory broadcaster. Strip all of it.
- Client `src/ui/lib/websocketClient.ts`: same singleton shape as MV minus jitter,
  5 attempts, plus an "upgraded / new version" close-reason fast path (`:122-137`)
  that reconnects in 100ms after a deploy (DOs evict sockets on new versions —
  keep this). Consumers subscribe to `useWebSocketStore(s => s.lastEvent)` and
  filter by `type`/`data.syncId` (`hooks/useAIVAFinalizeProgress.ts:21-39`).
- Vite dev proxy `'/ws': { target: 'ws://localhost:3001', ws: true }` in both repos.

### 2.3 Why GM split the hub into a second worker, and the kit's answer

Commit `c216e0c7` (2026-07-09): a worker that **implements** a DO class gets
`has_preview: false`, which broke per-PR preview URLs. Binding cross-script to
an external DO does not count as implementing one, so the DO moved to
`src/do-worker.ts` + `wrangler.notifications.toml` (deployed first in CI because
the cross-script binding requires the target script to exist). Cost: two deploys,
two configs, `-c a -c b` dev, a `v2 deleted_classes` migration. GM has since
**removed per-PR previews** (`wrangler.staging.toml:20-27`), so the split now buys
nothing there.

**Kit: keep it in-script (agree with advisor default).** Rationale: one config,
one deploy, no ordering constraint, RPC instead of fetch; the DO is stateless so
the split remains a reversible 30-minute migration if a kit user needs preview
URLs later — document that path in the README rather than paying for it up front.

### 2.4 Kit recommendation (realtime)

Base: GM's DO + client "upgrade" fast-path; MV's seam discipline, upgrade-auth
membership check, jittered backoff, and entity→query-key invalidation table.

- `durable-objects/notifications-hub.ts`: GM as-is, but (a) RPC methods
  `broadcast(tenantId, payload, channel?)`, `stats()`; (b) reject connect without
  `tenantId` instead of defaulting; (c) optional `user:` targeting.
- `routes/ws.ts`: session cookie → `?tenantId` or session tenant → membership row →
  `stub.fetch` upgrade (MV `websocket-upgrade.ts` logic, Workers transport).
- `services/notification.ts`: MV's tiny surface (`broadcastDataEvent`,
  `broadcastInvitationEvent`, `sendTestEvent`, `getConnectionStats`) over a single
  DO broadcaster — no driver switch needed on Workers; `wrangler dev` runs the DO.
- UI: MV client (jitter) + GM upgrade fast-path; store with a small
  `entityInvalidations` map; `WebSocketProvider`.
- Rules: "never touch the DO from a route; go through `NotificationService`".

---

## 3. Email

Both repos: Resend via raw `fetch('https://api.resend.com/emails')` with the
same `sendEmail(env, to, subject, html)` signature (MV `src/api/services/email.ts:9-49`,
GM `src/api/services/email.ts:7-40`). Already Workers-compatible; no SDK.

| | Mirevue | GM |
|---|---|---|
| From address | `config.EMAIL_FROM` (default `Mirevue <noreply@example.com>`, `src/config.ts:31`) | **hardcoded** `GuideMode <noreply@notifications.guidemode.dev>` + `reply_to` (`email.ts:14,29`) |
| No key | dev: info log + skip; prod: warn + skip (`email.ts:10-20`). Magic-link route logs the URL itself when unset (`routes/auth/magic-link.ts:44-50`) — so login works with zero config | warn + skip only |
| Templates | shared `emailShell`/`ctaButton`/`rawLink` helpers + brand palette (`email.ts:51-140`); magic link, tenant invite, workshop invite, access approved, access-request pending, invitation accepted | each template a full standalone HTML document (`email.ts:43-600`); invite, tenant-created (sent to a hardcoded personal address, `tenant-helpers.ts:128`), survey notification/reminder, invitation accepted, magic link |
| Callers | 6 (`magic-link.ts:54`, `members.ts:243`, `invitations.ts:53`, `admin.ts:164`, `access-helpers.ts:51`, `prep-document-queue.ts:682`) | 8 |

**Base: Mirevue.** Strip the brand palette to neutral tokens (`APP_NAME`,
`APP_URL`, `EMAIL_FROM` from env), keep `emailShell` + three templates (magic
link, tenant invite, invitation accepted). Keep the "no `RESEND_API_KEY` → log
the link" behaviour; on Workers `NODE_ENV` comes from `[vars]`, and the dev
fallback should key on `!env.RESEND_API_KEY` rather than `NODE_ENV`. Drop GM's
hardcoded from/reply-to and the hardcoded recipient. Note MV's `sendEmail` reads
`config` (process-global) — kit version must take `env` only.

---

## 4. File storage

- **GM**: native R2 binding `AGENT_SESSIONS` (`wrangler.toml:96-98`), used directly:
  `env.AGENT_SESSIONS.put(key, buf, { httpMetadata, customMetadata })`
  (`services/storage.ts:73-76`), `.get(key)` streamed through the worker
  (`routes/agent-sessions/query.ts:618`), `.delete` best-effort. Key scheme
  `tenants/<tenantId>/<provider>/<repo>/<sessionId>/<ts>_<file>` (`storage.ts:120`).
  Missing binding → warn and no-op. **`aws4fetch` is NOT used for R2** — it signs
  Bedrock requests (`services/ai-config/bedrock-wrapper.ts:1,17`). Easy to misread.
- **Mirevue**: `StorageService` interface `{upload, download, head, delete, exists}`
  (`services/storage.ts:46-58`) over `files-sdk` with an `fs` adapter
  (`STORAGE_LOCAL_PATH=./.storage`) and a lazily-imported `s3` adapter that pulls
  `@aws-sdk/client-s3` (`storage.ts:130-170`); `buildStorageKey` /
  `sanitizeFilename` (`:65-83`); config validated by `superRefine` (`config.ts:134-150`).

**Kit: thin seam, do not defer.** MV's interface + key helpers, GM's implementation:
`createStorage(env.FILES: R2Bucket): StorageService`. `wrangler dev` emulates R2
locally (`--persist-to .wrangler/state`), so no fs adapter is needed. Drop
`files-sdk`, `@aws-sdk/*`, `STORAGE_*` vars. Ship one example route (upload +
download stream, tenant-prefixed key). Open: presigned URLs (the binding can't
mint them — needs S3-API creds + `aws4fetch`, or keep GM's stream-through).

---

## 5. Node-only in these areas (will not run on Workers)

| Item | Where | Replacement |
|---|---|---|
| `ws` server + `node:http` `upgrade` event | MV `websocket.ts`, `websocket-upgrade.ts`; GM `websocket-dev.ts`, `routes/websocket.ts:70-185` | DO + `WebSocketPair` |
| `pg` `Client` LISTEN/NOTIFY | MV `pg-notify.ts`, `broadcaster-postgres.ts`, `agent-run-log.ts` NOTIFY, cancel channel | DO broadcast; DB flag polling per step |
| `pg-boss` (own pool, schema, poller) | MV `agent-queue.ts`, `agent-worker.ts`, `prep-document-queue.ts`, `scripts/queue-init.ts` | Queues / Workflows / cron |
| `@aws-sdk/client-s3`, `files-sdk` fs adapter | MV `storage.ts` | R2 binding |
| `@hono/node-server`, `serve`, `readFileSync` SPA fallback | MV `server.ts` | `[assets]` binding with `not_found_handling = "single-page-application"` (GM `wrangler.toml:87-91`) |
| Global-scope `setInterval` (ping, cleanup) | MV `websocket.ts:159,231`; GM `routes/websocket.ts:184` (GM's own comment says disallowed) | `setWebSocketAutoResponse`; runtime prunes closed sockets |
| Process-global `config` read at import, `process.on('SIGTERM')` shutdown | MV `config.ts`, `server.ts:95-133` | `env` per invocation; no shutdown hook |
| `node:crypto` `randomUUID` | fine under `nodejs_compat`; prefer `crypto.randomUUID()` | — |
| `process.env` fallbacks | GM `middleware/env.ts:130-175` (`c.env?.X || process.env.X`) | kit: `c.env` only |

---

## 6. Proposed kit files

```
src/
  worker.ts                         # export default { fetch, queue, scheduled }; export { NotificationsHub, ExampleWorkflow }
  scheduled.ts                      # cron dispatcher keyed on event.cron; tasks/prune.ts
  api/
    queues/
      example-queue.ts              # enqueueExample(env.EXAMPLE_QUEUE, msg) + processExampleBatch(batch, env)
      index.ts                      # queueHandler: switch (batch.queue)
    workflows/
      example-workflow.ts           # WorkflowEntrypoint, 3 step.do, checkCancellation, status row, progress nudge
      utils.ts                      # instanceIdFor(), checkCancellation(), broadcastProgress(), reconcileStatus()
    durable-objects/
      notifications-hub.ts          # GM DO, RPC methods, hibernation, tenant/user tags
    routes/
      ws.ts                         # cookie → session → membership → DO upgrade
      background-runs.ts            # POST create (workflow), GET status (reconcile), POST cancel (flag)
      files.ts                      # upload/download example over storage seam
    services/
      notification.ts               # NotificationService over DO broadcaster (MV surface)
      email.ts                      # sendEmail(env,…) + emailShell + 3 templates
      storage.ts                    # StorageService over R2Bucket + buildStorageKey/sanitizeFilename
  db/schema/
    background-runs.ts              # id, tenant_id, kind, instance_id, status, step, error, timestamps
    notifications.ts                # in-app notifications (MV shape)
  ui/
    lib/websocketClient.ts          # MV jitter backoff + GM upgrade fast-path
    stores/websocketStore.ts        # entity → query-key invalidation map, lastEvent
    components/WebSocketProvider.tsx
    hooks/useNotifications.ts       # in-app notifications (MV version)
    hooks/useBackgroundRun.ts       # poll status route + react to `run:progress` nudge
```

## 7. wrangler.toml bindings for these areas

```toml
compatibility_flags = ["nodejs_compat"]

[[queues.producers]]
binding = "EXAMPLE_QUEUE"
queue = "<app>-example"
[[queues.consumers]]
queue = "<app>-example"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 3
retry_delay = 60
# dead_letter_queue = "<app>-example-dlq"

[[workflows]]
name = "<app>-example-workflow"      # account-scoped: suffix per env
binding = "EXAMPLE_WORKFLOW"
class_name = "ExampleWorkflow"

[[durable_objects.bindings]]
name = "NOTIFICATIONS_HUB"
class_name = "NotificationsHub"
[[migrations]]
tag = "v1"
new_classes = ["NotificationsHub"]   # stateless → new_classes, not new_sqlite_classes, is fine

[[r2_buckets]]
binding = "FILES"
bucket_name = "<app>-files"

[triggers]
crons = ["*/15 * * * *"]

# from other subsystems, referenced here: HYPERDRIVE (db in consumers/workflows), ASSETS
```

## 8. Env var / secret names

Secrets: `RESEND_API_KEY` (optional — absent → links logged), `DATABASE_URL`
(dev; prod via Hyperdrive).
Vars: `APP_URL`, `APP_NAME`, `EMAIL_FROM`, `NODE_ENV`.
Dropped from MV: `BROADCASTER_DRIVER`, `STORAGE_DRIVER`, `STORAGE_LOCAL_PATH`,
`STORAGE_S3_*`. Dropped from GM: `R2_BUCKET` (unused by code), `CLOUDFLARE_API_TOKEN`
/ `CLOUDFLARE_ACCOUNT_ID` (Analytics Engine only).

## 9. Open questions / risks

1. **Coalesce/back-pressure has no CF primitive.** If the kit's example workflow
   is meant to model MV's continuous agents, we need the "pending rerun" DB flag
   pattern designed and tested; otherwise state that only `exclusive` is provided.
2. **Test story for async.** MV's `drainQueue` deterministic testing has no
   equivalent; decide between calling `processExampleBatch` with a hand-built
   `MessageBatch` (cheap, no platform) and `@cloudflare/vitest-pool-workers`
   (real Queues/Workflows/DO in miniflare). Recommend the former for unit tests,
   one smoke test with the latter.
3. **Workflow instance id length/charset and `create` on an existing id** —
   GM probes with `get()` first; confirm current `create()` behaviour (throws on
   duplicate) and the 100-char id limit before hardcoding `tenant:subject` ids.
4. **Progress streaming.** MV's SSE + `Last-Event-ID` replay is genuinely better UX
   than GM's nudge; on Workers it would need polling inside `streamSSE` (no NOTIFY)
   or a DO-held cursor. Deferred from v1; flag as a design item.
5. **Per-step CPU (30s default) vs `[limits] cpu_ms`.** Document; don't raise by default.
6. **Preview URLs** are forfeited by implementing the DO in-script (GM commit
   `c216e0c7`). Document the split-out recipe; don't pre-pay for it.
7. **DO trusts `?tenantId`.** Safe only via binding; add a shared-secret header or
   RPC-only connect so a future public route can't forward untrusted params.
8. **Presigned R2 URLs** need S3 credentials + `aws4fetch`; v1 streams through the
   worker (GM pattern) — fine for small files, revisit for large uploads.
9. **Email dev fallback on Workers**: `wrangler dev` logs go to the terminal; the
   magic-link URL log must be `info`-level and unmistakable, or dev login is painful.
10. **Cross-tenant fan-out** (`broadcastInvitationEvent`) is N DO calls; fine at
    kit scale, note it.

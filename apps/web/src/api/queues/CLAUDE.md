# Jobs queue

Producer `enqueueJob(queue, input)` / `enqueueJobs` (`../services/jobs.ts`: validates
`jobInputSchema` from `@rocketflare/shared/jobs`, stamps `{ id, enqueuedAt }`). Consumer
`processJobsBatch(batch, { env, config, logger })` (`jobs.ts`), dispatching on `type` to
`handlers/*`; `../queue.ts` routes `batch.queue` by prefix (`isJobsQueue`) because the name differs
per environment. Work over ~30 s or with multiple steps is a Workflow, not a job.

## Adding a job type

- A variant in `CORE_JOB_VARIANTS` (`packages/shared/src/jobs.ts` — `jobInputSchema`,
  `jobEnvelopeSchema`, `JobType`, `JOB_TYPES` are all DERIVED from it), a handler in `handlers/`,
  and its entry in `coreHandlers`. **There is no `runHandler` switch**: the mapped type
  `{ [T in CoreJobType]: JobHandler<T> }` is the completeness check. A plugin's variants are
  `SharedPlugin.jobs`, its handlers `ServerPlugin.jobHandlers`, checked against the types IT
  declared
- The `type` string is the version seam: a breaking payload change is a new type
  (`email.send.v2`), never an edited schema. Messages carry ids, not rows
- Copy `handlers/document-index.ts` (shortest kit handler) or
  `src/plugins/example-feature/jobs/ping.ts` (shortest overall; `POST /api/example-feature/ping` is
  the smoke job)

## Handler contract

- `(job: JobOf<'x'>, ctx: { env, config, logger, db, tracer? })`. Each message gets its own DB
  client, closed in `finally` after the consumer awaits `tracer.flush()`. An AI handler brackets its
  work in `withAgentTrace(..., { kind: 'job', spanName: 'invoke_workflow <type>' })`
- **Never `waitUntil` in a consumer — await everything.** A handler that throws is retried, one that
  returns is acked; handlers must be idempotent (delivery is at least once)
- Poison: an envelope failing `jobEnvelopeSchema` is logged and **`ack()`ed** (retrying cannot make
  it valid). Handler error → `retry({ delaySeconds: backoffSeconds(attempts) })`, 30 s doubling to a
  15 min cap; the toml's `max_retries = 3` ends it. Unknown queue → `ackAll()`
- **A job naming a tenant runs only while it is `active`**: before dispatch the consumer reads
  `tenants.status` for a payload `tenantId` (a UUID) and acks the message unrun otherwise —
  suspended or deleted, kit and plugin jobs alike; `RUN_FOR_ANY_TENANT` (`tenant.purge`,
  `activity.record`) is the exception list. `afterDropped` leaves a dropped `document.index` /
  `document.convert`'s `pending` row `failed` for Retry. A test consuming such a job creates the
  tenant first (`docs/CONCEPTS.md` §1)
- A permanent failure is acked, a transient one thrown: `document.convert` acks
  `ConversionFailedError` (row `failed`) but THROWS on a missing `FILES` binding (the bytes exist
  and are unreachable); `tenant.purge` ACKS a missing `FILES` (no binding, no objects written)

## The kit's jobs

- Queued: `email.send` (invitation create/bulk/resend, access-request decided — never the magic
  link, which stays inline), `activity.record`, `document.index`, `document.convert`,
  `document.reembed`, `chat.compact`, `tenant.purge`, `event.deliver`, `knowledge.extract`
- A message that throws on every one of `max_retries` goes to the dead-letter queue
  (`dead_letter_queue` in both tomls: `<app>-jobs-dlq`, `-dlq-staging`). Nothing consumes it — a
  consumer there would match `isJobsQueue` and reprocess it — so a handler must leave its rows in
  a state a person can recover from (`failed` + Retry, a re-requestable job), never half-written
- `event.deliver` (D42) is ONE subscriber of one `plugin_events` row: `{ tenantId, eventId,
  subscriber }`, never the payload. It re-reads the row under the tenant, re-validates, and calls
  that subscriber only; a missing row (pruned, other tenant) or subscriber is acked, a 4xx
  `ApiError` is acked, anything else throws and retries. Queued by `emitEvent`, never by hand
- `tenant.purge` is the out-of-database half of deleting a tenant: the payload (id + slug) is all
  it will ever have — the row is gone. It runs every plugin's `onTenantDeleted` first (each
  try/caught) then `purgeTenantObjects` (pages `tenants/<id>/` with `listPage` + `deleteMany`). An
  R2 error throws and is retried; everything in it is idempotent
- `chat.compact` folds messages outside the `CHAT_HISTORY_MAX_CHARS` window into
  `conversations.summary`; the window is the same pure `selectHistoryWindow` the route uses, and the
  write is a compare-and-set on `summarised_through_id` so two deliveries cannot lose an update
- `document.index` re-indexes a `documents` row from its stored `content` (`indexDocument`);
  `ingestText` enqueues it over 50 chunks. `document.convert` is R2 → `env.AI.toMarkdown` → the same
  `indexDocument` (`../services/ai/CLAUDE.md`)
- `knowledge.extract` (D43, `{ tenantId, documentId, contentHash? }`) reads typed facts from one
  indexed document (`extractDocumentFacts`, `../services/knowledge/CLAUDE.md`; a run that wrote
  or removed facts nudges `entity.changed { entity: 'knowledge' }` through `collectingRealtime`,
  flushed before the handler returns). Only
  `afterTextIndexed` (`services/ai/ingest.ts`) enqueues it — after an inline index, a
  `document.index` or a `document.convert` that changed the text — and only with the
  `knowledge-facts` flag on and an entity type registered; a producer whose text is unchanged sets
  `document.index`'s `skipExtraction`. The job re-checks every gate, skips (acks) a document whose
  hash moved on, and at the tenant's `KNOWLEDGE_TENANT_DAILY_COST_USD` cap re-enqueues ITSELF with a
  delay to the next UTC day (≤ 12 h a hop) instead of throwing. Re-extraction replaces the
  document's facts, so a redelivery is idempotent
- `document.reembed` (`{ tenantId, model }`) is a self-continuing chain: ONE bounded batch of the
  tenant's stale documents per message (`reembedBatch`, `services/ai/reindex.ts`), then the same
  payload re-enqueued while any remain — the stale predicate is the cursor, so a retry resumes. A
  message for a model the tenant no longer resolves is acked (the newer chain owns the work); a
  transient provider error throws with the old chunks intact; a provider refusal of one document
  marks it `failed` and the batch moves on

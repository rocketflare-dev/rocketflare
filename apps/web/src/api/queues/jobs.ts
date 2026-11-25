/**
 * `JOBS_QUEUE` consumer: a plain `(batch, deps)` function so tests call it with a hand-built
 * `MessageBatch` and no platform. Per message: parse the envelope (invalid → log + `ack()`, a poison
 * message must never retry), dispatch on `type` to `handlers/*`, `ack()` on success, `retry({
 * delaySeconds })` with exponential backoff on failure (the platform stops after the toml's
 * `max_retries`). Each message gets its own DB client, closed in `finally` — there is no
 * `waitUntil` in a queue consumer, everything is awaited.
 */
import {
  type CoreJobType,
  type JobEnvelope,
  type JobType,
  jobEnvelopeSchema,
} from '@rocketflare/shared/jobs'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import { type DatabaseHandle, openDatabase } from '../../db/client'
import { documents, tenants } from '../../db/schema'
import { serverPlugins } from '../../plugins/server'
import { databaseSpanStore } from '../observability/span-store'
import type { Tracer } from '../observability/tracer'
import { tracerFor } from '../observability/tracing'
import type { AppBindings } from '../types'
import type { Logger } from '../utils/core/logger'
import { handleActivityRecord } from './handlers/activity-record'
import { handleChatCompact } from './handlers/chat-compact'
import { handleDocumentContextualize } from './handlers/document-contextualize'
import { handleDocumentConvert } from './handlers/document-convert'
import { handleDocumentIndex } from './handlers/document-index'
import { handleDocumentReembed } from './handlers/document-reembed'
import { handleEmailSend } from './handlers/email-send'
import { handleEventDeliver } from './handlers/event-deliver'
import { handleKnowledgeExtract } from './handlers/knowledge-extract'
import { handleTenantPurge } from './handlers/tenant-purge'

/** What every handler receives: the bindings, validated config, a job-scoped logger and a DB. */
export interface JobContext {
  env: AppBindings
  config: AppConfig
  logger: Logger
  db: DatabaseHandle['db']
  /**
   * This message's tracer — the `ai_spans` store on `db` plus the OTLP export when configured,
   * flushed by the consumer after the handler, before `db` closes. Optional so a hand-built context
   * (a test, a plugin's own harness) need not supply one; AI handlers use `ctx.tracer ?? noopTracer`.
   */
  tracer?: Tracer
}

export type JobHandler<T extends JobType> = (
  job: Extract<JobEnvelope, { type: T }>,
  ctx: JobContext
) => Promise<void>

export interface JobsConsumerDeps {
  env: AppBindings
  config: AppConfig
  logger: Logger
  /** Override the per-message DB factory (tests). Defaults to `openDatabase({ ...config, HYPERDRIVE })`. */
  createDb?: () => DatabaseHandle
}

/**
 * The type → handler table. Adding a job type = a variant in `CORE_JOB_VARIANTS` (shared) + a
 * `queues/handlers/<name>.ts` + one entry here. The mapped type is the completeness check: a
 * variant with no handler is a compile error in THIS object, which is why there is no `switch`
 * beside it repeating the same list.
 */
const coreHandlers: { [T in CoreJobType]: JobHandler<T> } = {
  'email.send': handleEmailSend,
  'activity.record': handleActivityRecord,
  'document.index': handleDocumentIndex,
  'document.convert': handleDocumentConvert,
  'document.reembed': handleDocumentReembed,
  'chat.compact': handleChatCompact,
  'tenant.purge': handleTenantPurge,
  'event.deliver': handleEventDeliver,
  'knowledge.extract': handleKnowledgeExtract,
  'document.contextualize': handleDocumentContextualize,
}

/**
 * Core handlers plus every installed plugin's. The two halves are checked where each is
 * DECLARED — core's against `CoreJobType` above, a plugin's against the job types that same
 * plugin declared (`ServerPlugin.jobHandlers` is `{ [T in JobTypeOf<S>]: JobHandler<T> }`) — so the
 * merge is the one place neither half can prove the other, and the cast says exactly that.
 */
const handlers = {
  ...coreHandlers,
  ...(Object.assign({}, ...serverPlugins.map(p => p.jobHandlers ?? {})) as Record<
    string,
    JobHandler<JobType>
  >),
} as { [T in JobType]: JobHandler<T> }

/** First retry after 30 s, doubling, capped at 15 min. The toml's `retry_delay` is the floor. */
export const BACKOFF_BASE_SECONDS = 30
export const BACKOFF_MAX_SECONDS = 15 * 60

export function backoffSeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 20) - 1)
  return Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** exponent)
}

/**
 * The jobs that run whatever the named tenant's status: `tenant.purge` is the teardown of a tenant
 * that no longer exists, and `activity.record` writes down what already happened. Every other job
 * that names a tenant — the kit's and every plugin's — runs only while that tenant is `active`.
 */
const RUN_FOR_ANY_TENANT: ReadonlySet<string> = new Set<CoreJobType>([
  'tenant.purge',
  'activity.record',
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The payload's `tenantId` — every kit job's, and a plugin job's by the same convention. */
function tenantIdOf(job: JobEnvelope): string | null {
  const payload = job.payload as { tenantId?: unknown } | null | undefined
  const id = payload?.tenantId
  return typeof id === 'string' && UUID.test(id) ? id : null
}

/**
 * A suspended (or deleted) tenant's queued work does not run: one primary-key read of
 * `tenants.status` per message that names a tenant. A job naming none (a platform email) runs.
 */
async function tenantMayRun(db: DatabaseHandle['db'], job: JobEnvelope): Promise<boolean> {
  if (RUN_FOR_ANY_TENANT.has(job.type)) return true
  const tenantId = tenantIdOf(job)
  if (!tenantId) return true
  const [row] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
  return row?.status === 'active'
}

/**
 * A dropped index or conversion leaves its document `failed` rather than `pending` for ever, so
 * the document's Retry picks it up once the tenant is active again. Only a `pending` row moves.
 */
async function afterDropped(db: DatabaseHandle['db'], job: JobEnvelope): Promise<void> {
  if (job.type !== 'document.index' && job.type !== 'document.convert') return
  const { tenantId, documentId } = job.payload
  await db
    .update(documents)
    .set({
      status: 'failed',
      error: 'The organisation was suspended before this document was processed',
    })
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.tenantId, tenantId),
        eq(documents.status, 'pending')
      )
    )
}

export async function processJobsBatch(
  batch: MessageBatch<unknown>,
  deps: JobsConsumerDeps
): Promise<void> {
  const createDb =
    deps.createDb ?? (() => openDatabase({ ...deps.config, HYPERDRIVE: deps.env.HYPERDRIVE }))

  for (const message of batch.messages) {
    await processMessage(message, deps, createDb)
  }
}

async function processMessage(
  message: Message<unknown>,
  deps: JobsConsumerDeps,
  createDb: () => DatabaseHandle
): Promise<void> {
  const parsed = jobEnvelopeSchema.safeParse(message.body)
  if (!parsed.success) {
    // Poison: retrying cannot make it valid. Ack so it leaves the queue; the log is the record.
    deps.logger.error(
      { messageId: message.id, attempts: message.attempts, issues: parsed.error.issues },
      'jobs: invalid envelope, acknowledging without processing'
    )
    message.ack()
    return
  }

  const job = parsed.data
  const logger = deps.logger.child({ jobId: job.id, jobType: job.type, attempts: message.attempts })
  const handle = createDb()
  const tracer = tracerFor(deps.config, { logger, store: databaseSpanStore(handle.db) })
  try {
    if (!(await tenantMayRun(handle.db, job))) {
      // Dropped, not deferred: every chain restarts from its own state once the tenant is active
      // again (a re-embed from the stale count, a document from Retry, compaction on the next turn).
      await afterDropped(handle.db, job)
      message.ack()
      logger.info('jobs: tenant not active, acknowledged without running')
      return
    }
    const ctx: JobContext = { env: deps.env, config: deps.config, logger, db: handle.db, tracer }
    // `job` is the union and `handlers[job.type]` the matching handler, but TypeScript pairs them
    // only by widening both to their union — which makes the CALL the intersection of every
    // handler's parameter. The table's mapped type is what keeps the pairing honest.
    await handlers[job.type](job as never, ctx)
    message.ack()
    logger.info('jobs: done')
  } catch (err) {
    const delaySeconds = backoffSeconds(message.attempts)
    logger.warn({ err, delaySeconds }, 'jobs: handler failed, retrying')
    message.retry({ delaySeconds })
  } finally {
    // Awaited, and BEFORE the close: a consumer has no `waitUntil`, and the store writes on `db`.
    await tracer.flush()
    await handle.close()
  }
}

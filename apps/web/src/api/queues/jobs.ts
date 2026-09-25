/**
 * `JOBS_QUEUE` consumer (D7): a plain `(batch, deps)` function so tests call it with a hand-built
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
import type { AppConfig } from '../../config'
import { createDatabase, type DatabaseHandle, resolveDatabaseUrl } from '../../db/client'
import { serverPlugins } from '../../plugins/server'
import { databaseSpanStore } from '../observability/span-store'
import type { Tracer } from '../observability/tracer'
import { tracerFor } from '../observability/tracing'
import type { AppBindings } from '../types'
import type { Logger } from '../utils/core/logger'
import { handleActivityRecord } from './handlers/activity-record'
import { handleChatCompact } from './handlers/chat-compact'
import { handleDocumentConvert } from './handlers/document-convert'
import { handleDocumentIndex } from './handlers/document-index'
import { handleEmailSend } from './handlers/email-send'
import { handleTenantPurge } from './handlers/tenant-purge'

/** What every handler receives: the bindings, validated config, a job-scoped logger and a DB. */
export interface JobContext {
  env: AppBindings
  config: AppConfig
  logger: Logger
  db: DatabaseHandle['db']
  /**
   * D32: this message's tracer — the `ai_spans` store on `db` plus the OTLP export when configured,
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
  /** Override the per-message DB factory (tests). Defaults to `createDatabase(resolveDatabaseUrl(env))`. */
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
  'chat.compact': handleChatCompact,
  'tenant.purge': handleTenantPurge,
}

/**
 * Core handlers plus every installed plugin's (D31). The two halves are checked where each is
 * DECLARED — the kit's against `CoreJobType` above, a plugin's against the job types that same
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

export async function processJobsBatch(
  batch: MessageBatch<unknown>,
  deps: JobsConsumerDeps
): Promise<void> {
  const createDb =
    deps.createDb ??
    (() =>
      createDatabase(
        resolveDatabaseUrl({
          HYPERDRIVE: deps.env.HYPERDRIVE,
          PREVIEW_DATABASE_URL: deps.config.PREVIEW_DATABASE_URL,
          DATABASE_URL: deps.config.DATABASE_URL,
        })
      ))

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

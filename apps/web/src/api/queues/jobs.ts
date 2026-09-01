/**
 * `JOBS_QUEUE` consumer (D7): a plain `(batch, deps)` function so tests call it with a hand-built
 * `MessageBatch` and no platform. Per message: parse the envelope (invalid → log + `ack()`, a poison
 * message must never retry), dispatch on `type` to `handlers/*`, `ack()` on success, `retry({
 * delaySeconds })` with exponential backoff on failure (the platform stops after the toml's
 * `max_retries`). Each message gets its own DB client, closed in `finally` — there is no
 * `waitUntil` in a queue consumer, everything is awaited.
 */
import { type JobEnvelope, type JobType, jobEnvelopeSchema } from '@gmgo/shared/jobs'
import type { AppConfig } from '../../config'
import { createDatabase, type DatabaseHandle, resolveDatabaseUrl } from '../../db/client'
import type { AppBindings } from '../types'
import type { Logger } from '../utils/core/logger'
import { handleActivityRecord } from './handlers/activity-record'
import { handleEmailSend } from './handlers/email-send'
import { handleExamplePing } from './handlers/example-ping'

/** What every handler receives: the bindings, validated config, a job-scoped logger and a DB. */
export interface JobContext {
  env: AppBindings
  config: AppConfig
  logger: Logger
  db: DatabaseHandle['db']
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

/** The type → handler table. Adding a job type = a schema variant in shared + one entry here. */
const handlers: { [T in JobType]: JobHandler<T> } = {
  'email.send': handleEmailSend,
  'activity.record': handleActivityRecord,
  'example.ping': handleExamplePing,
}

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
  try {
    const ctx: JobContext = { env: deps.env, config: deps.config, logger, db: handle.db }
    await runHandler(job, ctx)
    message.ack()
    logger.info('jobs: done')
  } catch (err) {
    const delaySeconds = backoffSeconds(message.attempts)
    logger.warn({ err, delaySeconds }, 'jobs: handler failed, retrying')
    message.retry({ delaySeconds })
  } finally {
    await handle.close()
  }
}

/** Narrow once so each handler is typed to its own payload. */
function runHandler(job: JobEnvelope, ctx: JobContext): Promise<void> {
  switch (job.type) {
    case 'email.send':
      return handlers['email.send'](job, ctx)
    case 'activity.record':
      return handlers['activity.record'](job, ctx)
    case 'example.ping':
      return handlers['example.ping'](job, ctx)
  }
}

/**
 * Queue consumer dispatcher (D7): one `queue` export routing on `batch.queue`. The jobs queue is
 * matched by PREFIX (`isJobsQueue`) because the NAME differs per environment
 * (`gmgo-starter-jobs` / `gmgo-starter-jobs-staging` — queue names are account-scoped) while the
 * binding and the code are identical. Any other queue is logged and acked so an accidentally bound
 * queue cannot retry forever. Config is validated like `fetch` (D3).
 */
import { loadConfig } from '../config'
import { processJobsBatch } from './queues/jobs'
import { isJobsQueue } from './services/jobs'
import type { AppBindings } from './types'
import { loggerFor } from './utils/core/logger'

export async function queue(
  batch: MessageBatch<unknown>,
  env: AppBindings,
  _ctx: ExecutionContext
): Promise<void> {
  const config = loadConfig(env)
  const logger = loggerFor(config, { handler: 'queue', queue: batch.queue })

  if (isJobsQueue(batch.queue)) {
    logger.info({ messages: batch.messages.length }, 'queue: processing jobs batch')
    return processJobsBatch(batch, { env, config, logger })
  }

  logger.warn(
    { messages: batch.messages.length },
    'queue: no consumer registered for this queue; acknowledging batch'
  )
  batch.ackAll()
}

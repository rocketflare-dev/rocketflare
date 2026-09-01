/**
 * Queue consumer dispatcher (D7): one `queue` export switching on `batch.queue`. Phase 2 adds
 * `JOBS_QUEUE` and its consumer module; until then every batch is logged and acked so an
 * accidentally bound queue cannot retry forever. Config is validated like `fetch` (D3).
 */
import { loadConfig } from '../config'
import type { AppBindings } from './types'
import { loggerFor } from './utils/core/logger'

export async function queue(
  batch: MessageBatch<unknown>,
  env: AppBindings,
  _ctx: ExecutionContext
): Promise<void> {
  const config = loadConfig(env)
  const logger = loggerFor(config, { handler: 'queue', queue: batch.queue })

  switch (batch.queue) {
    // Phase 2: case 'gmgo-starter-jobs': return consumeJobs(batch, { env, config, logger, ctx })
    default:
      logger.warn(
        { messages: batch.messages.length },
        'queue: no consumer registered for this queue; acknowledging batch'
      )
      batch.ackAll()
  }
}

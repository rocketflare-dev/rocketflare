/**
 * `example.ping` (D7): the smoke-test job. It only logs, so a developer can prove the
 * producer → Queues → consumer path end to end (`enqueueJob(env.JOBS_QUEUE, { type: 'example.ping',
 * payload: { tenantId } })` from any route, then watch `wrangler dev`). Copy this file to start a
 * real handler.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import type { JobContext } from '../jobs'

export async function handleExamplePing(
  job: JobOf<'example.ping'>,
  ctx: JobContext
): Promise<void> {
  ctx.logger.info(
    { tenantId: job.payload.tenantId, note: job.payload.note, enqueuedAt: job.enqueuedAt },
    'example.ping: pong'
  )
}

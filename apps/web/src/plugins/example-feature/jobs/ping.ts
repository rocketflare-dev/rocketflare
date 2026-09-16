/**
 * `example-feature.ping` (D7, D31): the smoke-test job. It only logs, so a developer can prove the
 * producer → Queues → consumer path end to end — `POST /api/example-feature/ping`, or
 * `rocketflare example-feature ping`, then watch `wrangler dev`. Copy this file to start a real
 * handler.
 *
 * A plugin's handler is a kit handler in every respect: it is `(job, ctx)`, it awaits everything
 * (there is no `waitUntil` in a queue consumer), it throws to be retried with backoff and returns
 * to be acked. What differs is only where it is REGISTERED — `ServerPlugin.jobHandlers`, checked
 * against the job types this plugin's shared half declared, rather than the kit's `coreHandlers`.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { EXAMPLE_PING_JOB } from '@rocketflare/shared/plugins/example-feature/index'
import type { JobContext } from '../../../api/queues/jobs'

export async function handleExamplePing(
  job: JobOf<typeof EXAMPLE_PING_JOB>,
  ctx: JobContext
): Promise<void> {
  ctx.logger.info(
    { tenantId: job.payload.tenantId, note: job.payload.note, enqueuedAt: job.enqueuedAt },
    `${EXAMPLE_PING_JOB}: pong`
  )
}

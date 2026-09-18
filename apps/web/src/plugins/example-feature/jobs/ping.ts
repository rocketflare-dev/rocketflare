/**
 * `example-feature.ping` (D7, D31): the smoke-test job. It only logs, so a developer can prove the
 * producer → Queues → consumer path end to end — `POST /api/example-feature/ping`, or
 * `rocketflare example-feature ping`, then watch `wrangler dev`. Copy this file to start a real
 * handler.
 *
 * A plugin's handler is a kit handler in every respect: it awaits everything (there is no
 * `waitUntil` in a queue consumer — that is why `JobCtx` has no `defer`, where `RequestCtx` does),
 * it throws to be retried with backoff and returns to be acked. What differs is only where it is
 * REGISTERED — `ServerPlugin.jobHandlers`, checked against the job types this plugin's shared half
 * declared, rather than the kit's `coreHandlers`.
 *
 * The exported handler is the kit's `JobHandler` shape because that is what the registration slot
 * takes; `jobCtx` adapts the raw context once, at the boundary, so the work below is written
 * against the plugin surface and names no kit internal. Note what `JobCtx` does NOT carry: a
 * `tenantId`. A job's tenant comes from its PAYLOAD, which is exactly the mistake the missing field
 * prevents.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { EXAMPLE_PING_JOB } from '@rocketflare/shared/plugins/example-feature/index'
import type { JobCtx, JobHandler } from '@/plugins/api'
import { jobCtx } from '@/plugins/api'

export async function pingExampleQueue(
  job: JobOf<typeof EXAMPLE_PING_JOB>,
  ctx: JobCtx
): Promise<void> {
  ctx.logger.info(
    { tenantId: job.payload.tenantId, note: job.payload.note, enqueuedAt: job.enqueuedAt },
    `${EXAMPLE_PING_JOB}: pong`
  )
}

/** What `ServerPlugin.jobHandlers` registers — the adapter, and the whole of the boundary. */
export const handleExamplePing: JobHandler<typeof EXAMPLE_PING_JOB> = (job, ctx) =>
  pingExampleQueue(job, jobCtx(ctx))

/**
 * Background work: `JobCtx` for a queue handler, `CronCtx` for a scheduled task (D7, D31).
 *
 * Both are the kit's own contexts with methods bolted on, and both keep the kit's two hard rules:
 *
 * - **Await everything. There is no `waitUntil` in a queue consumer.** A handler that defers work
 *   and returns has told the platform the message succeeded while the work is still running — and
 *   the isolate may be gone before it finishes. That is why `JobCtx` has no `defer`, where
 *   `RequestCtx` does.
 * - **Throw to retry, return to ack.** Backoff is 30 s doubling to a 15-minute cap and the toml's
 *   `max_retries` ends it. A handler that swallows its own error has converted a retryable failure
 *   into silent data loss.
 *
 * Neither context carries a `tenantId`, deliberately. A job's tenant comes from its PAYLOAD and a
 * cron task runs across every organisation, so there is no ambient tenant to reach for absently —
 * which is exactly the mistake the missing field prevents. Every method that needs one takes it.
 */

import type { JobInput } from '@rocketflare/shared/jobs'
import type { JobContext } from '../../api/queues/jobs'
import type { TaskContext } from '../../api/scheduled'
import { enqueueJob, enqueueJobs } from '../../api/services/jobs'
import { createStepRealtimeFor } from './realtime-step'
import type { PluginContext } from './types'

export type { JobInput, JobOf, JobType } from '@rocketflare/shared/jobs'
export type { JobContext, JobHandler } from '../../api/queues/jobs'
export type { ScheduledTask, TaskContext } from '../../api/scheduled'

/** What every background context can do, tenant supplied per call. */
interface BackgroundMethods {
  /** Enqueue follow-on work. A missing `JOBS_QUEUE` throws rather than running inline. */
  enqueue(input: JobInput, options?: { delaySeconds?: number }): Promise<{ id: string }>
  enqueueMany(inputs: readonly JobInput[], options?: { delaySeconds?: number }): Promise<void>
  /**
   * Tell one organisation's open tabs that a family of rows moved. **Awaited**, unlike a route's
   * nudge: there is no `waitUntil` here to hang it on.
   */
  nudge(tenantId: string, entity: string, id?: string): Promise<void>
  /** A per-tenant Durable Object stub, with the tenant prefix built here rather than by the caller. */
  durableObject<T extends Rpc.DurableObjectBranded | undefined = undefined>(
    namespace: DurableObjectNamespace<T>,
    tenantId: string,
    key?: string
  ): DurableObjectStub<T>
}

/**
 * One queue message. `job.payload` is already narrowed to the variant this handler was registered
 * for — `ServerPlugin.jobHandlers` is checked against the job types the plugin's own shared half
 * declared, so a declared variant with no handler is a type error in the plugin rather than a
 * dispatch failure in the host.
 */
export interface JobCtx extends PluginContext, BackgroundMethods {}

/** One cron run. `waitUntil` exists here because a scheduled invocation genuinely has one. */
export interface CronCtx extends PluginContext, BackgroundMethods {
  waitUntil(promise: Promise<unknown>): void
}

function backgroundMethods(env: PluginContext['env']): BackgroundMethods {
  return {
    enqueue: (input, options) => enqueueJob(env.JOBS_QUEUE, input, options),
    enqueueMany: async (inputs, options) => {
      await enqueueJobs(env.JOBS_QUEUE, inputs, options)
    },
    nudge: async (tenantId, entity, id) => {
      await createStepRealtimeFor(env).nudgeEntity(tenantId, entity, id)
    },
    durableObject: (namespace, tenantId, key) =>
      namespace.get(namespace.idFromName(key ? `${tenantId}:${key}` : tenantId)),
  }
}

/** Adapt the kit's `JobContext`. The only place a plugin's job half names a kit internal. */
export function jobCtx(ctx: JobContext): JobCtx {
  return {
    db: ctx.db,
    config: ctx.config,
    logger: ctx.logger,
    env: ctx.env,
    ...backgroundMethods(ctx.env),
  }
}

/** Adapt the kit's `TaskContext`. */
export function cronCtx(ctx: TaskContext): CronCtx {
  return {
    db: ctx.db,
    config: ctx.config,
    logger: ctx.logger,
    env: ctx.env,
    waitUntil: ctx.waitUntil,
    ...backgroundMethods(ctx.env),
  }
}

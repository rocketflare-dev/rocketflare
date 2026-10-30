/**
 * Background work: `JobCtx` for a queue handler, `CronCtx` for a scheduled task.
 *
 * Both are the core contexts with methods bolted on, and both keep the two hard core rules:
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

import type { JobEnvelope, JobInput } from '@rocketflare/shared/jobs'
import type { JobContext } from '../../api/queues/jobs'
import type { TaskContext } from '../../api/scheduled'
import { tenantFeatures } from '../../api/services/features'
import { enqueueJob, enqueueJobs } from '../../api/services/jobs'
import type { StorageService } from '../../api/services/storage'
import { agentRunStarter, type StartAgentRunInput, type StartedAgentRun } from './agent-runs'
import { createStepRealtimeFor } from './realtime-step'
import { filesStorage } from './storage'
import type { PluginContext } from './types'

export type { JobEnvelope, JobInput, JobOf, JobType } from '@rocketflare/shared/jobs'
export type { JobContext, JobHandler } from '../../api/queues/jobs'
export type { ScheduledTask, TaskContext } from '../../api/scheduled'
export type { StartAgentRun, StartAgentRunInput, StartedAgentRun } from './agent-runs'

/** What every background context can do, tenant supplied per call. */
export interface BackgroundMethods {
  /**
   * Enqueue follow-on work. A missing `JOBS_QUEUE` throws rather than running inline.
   *
   * It answers the stamped ENVELOPE, not just an id: the `id`, the `type` and the `enqueuedAt` are
   * what a caller echoes back so somebody can find the job again, and a narrower return would only
   * mean re-deriving values the producer already computed.
   */
  enqueue(input: JobInput, options?: { delaySeconds?: number }): Promise<JobEnvelope>
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
  /**
   * The feature keys one organisation has — what `auth.features` is on a request, resolved
   * here for a tenant named per call. A cron that fans out across every organisation reads this to
   * skip the ones whose flag is off; there is no user, so a user-bucketed rollout answers on the
   * tenant's override and the platform state alone.
   */
  features(tenantId: string): Promise<readonly string[]>
  /**
   * R2 (the `FILES` bucket), or a 503 `storage_not_configured` — loud, because a silently absent
   * bucket loses bytes. The same service `RequestCtx.storage()` returns. Write under
   * `tenants/<tenantId>/<plugin id>/…` so the `tenant.purge` job removes the objects with the tenant.
   */
  storage(): StorageService
  /**
   * Start an agent run for one organisation and return its id — `POST /api/agents/runs` from a
   * job, through the same `enqueueRun`: input validation (400), the exclusive slot, the active-run
   * cap (429 `agent_runs_limit`), the daily budget (429 `ai_budget_exceeded`), the Workflow start
   * (503 `agent_runs_not_configured` without the binding). Pass an `idempotencyKey` naming the
   * work (`receipt:<documentId>`) so a redelivered message answers the first run, `deduplicated`,
   * instead of starting a second. Part of `feature-agents`: an app without the agent runtime has
   * no such method.
   */
  startAgentRun(input: StartAgentRunInput): Promise<StartedAgentRun>
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

/** Shared by `JobCtx`, `CronCtx` and the public-mount context (`./public`). */
export function backgroundMethods(ctx: PluginContext): BackgroundMethods {
  const { db, config, env } = ctx
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
    features: tenantId => tenantFeatures(db, config, tenantId),
    storage: () => filesStorage(env),
    startAgentRun: agentRunStarter(ctx),
  }
}

/** Adapt the core `JobContext`. The only place a plugin's job half names a core internal. */
export function jobCtx(ctx: JobContext): JobCtx {
  return {
    db: ctx.db,
    config: ctx.config,
    logger: ctx.logger,
    env: ctx.env,
    ...backgroundMethods(ctx),
  }
}

/** Adapt the core `TaskContext`. */
export function cronCtx(ctx: TaskContext): CronCtx {
  return {
    db: ctx.db,
    config: ctx.config,
    logger: ctx.logger,
    env: ctx.env,
    waitUntil: ctx.waitUntil,
    ...backgroundMethods(ctx),
  }
}

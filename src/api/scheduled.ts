/**
 * Cron dispatcher (D7): tasks are registered per cron EXPRESSION and looked up by `event.cron`,
 * so adding a schedule is one entry in `[triggers] crons` (wrangler.toml — both files) and one
 * entry here. Every task is try/caught and logged individually; one failing task never blocks
 * the others. Config is validated the same way `fetch` does (D3).
 *
 * Local testing against `wrangler dev` (port 3001):
 *   curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=0+4+*+*+*"
 * (`wrangler dev --test-scheduled` additionally exposes the same thing at `/__scheduled`).
 */
import { type AppConfig, loadConfig } from '../config'
import { createDatabase, type Database, resolveDatabaseUrl } from '../db/client'
import type { AppBindings } from './types'
import { type Logger, loggerFor } from './utils/core/logger'

export interface TaskContext {
  env: AppBindings
  config: AppConfig
  db: Database
  logger: Logger
  /** `ctx.waitUntil` — for fire-and-forget side effects that must outlive the task. */
  waitUntil: (p: Promise<unknown>) => void
}

export interface ScheduledTask {
  name: string
  run(ctx: TaskContext): Promise<void>
}

export interface TaskReport {
  cron: string
  task: string
  status: 'ok' | 'failed'
  durationMs: number
  error?: unknown
}

/**
 * Nightly prune of expired rows (sessions, magic links, invitations). Phase 0: no tables yet,
 * so it only logs. Phase 1 adds `DELETE ... WHERE expires_at < now()` per table here.
 */
export const pruneExpired: ScheduledTask = {
  name: 'pruneExpired',
  async run({ logger }) {
    logger.info('pruneExpired: nothing to prune yet (Phase 1 adds session/magic-link tables)')
  },
}

/** Cron expression → tasks. Keep in sync with `[triggers] crons` in both wrangler tomls. */
export const SCHEDULED_TASKS: Record<string, ScheduledTask[]> = {
  '0 4 * * *': [pruneExpired],
}

/** Runs every task registered for `cron` and returns a per-task report (used by tests). */
export async function dispatchScheduled(
  cron: string,
  env: AppBindings,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  registry: Record<string, ScheduledTask[]> = SCHEDULED_TASKS
): Promise<TaskReport[]> {
  const config = loadConfig(env)
  const logger = loggerFor(config, { handler: 'scheduled', cron })
  const tasks = registry[cron]
  if (!tasks || tasks.length === 0) {
    logger.warn({ cron }, 'scheduled: no tasks registered for this cron expression')
    return []
  }

  const handle = createDatabase(
    resolveDatabaseUrl({
      HYPERDRIVE: env.HYPERDRIVE,
      PREVIEW_DATABASE_URL: config.PREVIEW_DATABASE_URL,
      DATABASE_URL: config.DATABASE_URL,
    })
  )
  const reports: TaskReport[] = []
  try {
    for (const task of tasks) {
      const started = Date.now()
      const taskLogger = logger.child({ task: task.name })
      try {
        await task.run({
          env,
          config,
          db: handle.db,
          logger: taskLogger,
          waitUntil: p => ctx.waitUntil(p),
        })
        reports.push({ cron, task: task.name, status: 'ok', durationMs: Date.now() - started })
      } catch (error) {
        taskLogger.error({ err: error }, 'scheduled task failed')
        reports.push({
          cron,
          task: task.name,
          status: 'failed',
          durationMs: Date.now() - started,
          error,
        })
      }
    }
  } finally {
    ctx.waitUntil(handle.close())
  }
  logger.info({ tasks: reports.map(r => `${r.task}:${r.status}`) }, 'scheduled run complete')
  return reports
}

/** The Worker `scheduled` handler (src/worker.ts). */
export async function scheduled(
  event: ScheduledController,
  env: AppBindings,
  ctx: ExecutionContext
): Promise<void> {
  await dispatchScheduled(event.cron, env, ctx)
}

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
import { and, eq, lt, sql } from 'drizzle-orm'
import { type AppConfig, loadConfig } from '../config'
import { createDatabase, type Database, resolveDatabaseUrl } from '../db/client'
import { aiSpans, tenants, userSessions } from '../db/schema'
import { serverPlugins } from '../plugins/server'
import { pruneMagicLinkTokens } from './auth/magic-link'
import { pruneInvitations } from './services/invitations'
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

/** Expired sessions, expired/consumed magic links, expired invitations older than 30 days. */
export async function runPruneExpired(db: Database) {
  const sessions = (
    await db
      .delete(userSessions)
      .where(sql`${userSessions.expiresAt} < now()`)
      .returning({ id: userSessions.id })
  ).length
  const magicLinks = await pruneMagicLinkTokens(db)
  const invitations = await pruneInvitations(db)
  return { sessions, magicLinks, invitations }
}

/** Nightly prune of expired rows (D12): counts are logged so the run is auditable. */
export const pruneExpired: ScheduledTask = {
  name: 'pruneExpired',
  async run({ db, logger }) {
    const counts = await runPruneExpired(db)
    logger.info(counts, 'pruneExpired: removed expired sessions, magic links and invitations')
  },
}

/**
 * Drop `ai_spans` older than `OBSERVABILITY_SPAN_RETENTION_DAYS` (D32). The local trace store is
 * written on every traced request whether or not a backend is configured, so without this it grows
 * for ever. One DELETE per tenant, each on the `(tenant_id, started_at)` index — a cross-tenant
 * cutoff scan would read the whole table, and every other query on it is tenant-first anyway.
 */
export async function runPruneAiSpans(db: Database, retentionDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const tenantRows = await db.select({ id: tenants.id }).from(tenants)
  let spans = 0
  for (const { id: tenantId } of tenantRows) {
    // No `.returning()`: a first prune after a busy fortnight can be a lot of rows, and the ids are
    // not needed — postgres.js reports the affected count on the result.
    const result = await db
      .delete(aiSpans)
      .where(and(eq(aiSpans.tenantId, tenantId), lt(aiSpans.startedAt, cutoff)))
    spans += (result as unknown as { count?: number }).count ?? 0
  }
  return { spans, cutoff: cutoff.toISOString() }
}

/** Nightly retention for the local trace store (D32). */
export const pruneAiSpans: ScheduledTask = {
  name: 'pruneAiSpans',
  async run({ db, config, logger }) {
    const result = await runPruneAiSpans(db, config.OBSERVABILITY_SPAN_RETENTION_DAYS)
    logger.info(result, 'pruneAiSpans: removed expired trace spans')
  },
}

/** Cron expression → tasks. Keep in sync with `[triggers] crons` in both wrangler tomls. */
const CORE_SCHEDULED_TASKS: Record<string, ScheduledTask[]> = {
  '0 4 * * *': [pruneExpired, pruneAiSpans],
}

/**
 * Core tasks plus every installed plugin's (D31). A plugin naming a cron the kit already runs
 * APPENDS to it — each task is try/caught on its own, so a plugin's failure cannot stop the kit's
 * prune — and a plugin naming a new cron expression must also add it to `[triggers]` in BOTH
 * tomls; nothing here can do that, and the parity test is what catches a forgotten one.
 */
export const SCHEDULED_TASKS: Record<string, ScheduledTask[]> = Object.entries(
  CORE_SCHEDULED_TASKS
).reduce<Record<string, ScheduledTask[]>>(
  (registry, [cron, tasks]) => Object.assign(registry, { [cron]: [...tasks] }),
  {}
)
for (const plugin of serverPlugins) {
  for (const [cron, tasks] of Object.entries(plugin.scheduledTasks ?? {})) {
    SCHEDULED_TASKS[cron] = [...(SCHEDULED_TASKS[cron] ?? []), ...tasks]
  }
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

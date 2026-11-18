/**
 * Cron dispatcher: tasks are registered per cron EXPRESSION and looked up by `event.cron`,
 * so adding a schedule is one entry in `[triggers] crons` (wrangler.toml — both files) and one
 * entry here. Every task is try/caught and logged individually; one failing task never blocks
 * the others. Config is validated the same way `fetch` does.
 *
 * Local testing against `wrangler dev` (port 3001):
 *   curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=0+4+*+*+*"
 * (`wrangler dev --test-scheduled` additionally exposes the same thing at `/__scheduled`).
 */
import { ACTIVE_RUN_STATUSES } from '@rocketflare/shared/ai/agents'
import { and, asc, eq, exists, inArray, lt, sql } from 'drizzle-orm'
import { type AppConfig, loadConfig } from '../config'
import { affected, type Database, openDatabase } from '../db/client'
import {
  agentRunEvents,
  agentRuns,
  agentRunTurns,
  aiSpans,
  pluginEvents,
  userSessions,
} from '../db/schema'
import { serverPlugins } from '../plugins/server'
import { pruneMagicLinkTokens } from './auth/magic-link'
import { sweepRun } from './services/agents/runs'
import { pruneInvitationSendCounters, pruneInvitations } from './services/invitations'
import type { AppBindings } from './types'
import { type Logger, loggerFor } from './utils/core/logger'
import { pruneTenantCreationCounters } from './utils/db/tenant-helpers'

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
 * Expired sessions, expired/consumed magic links, expired invitations older than 30 days, and the
 * daily invitation-mail and organisation-creation counters from before yesterday.
 */
export async function runPruneExpired(db: Database) {
  const sessions = (
    await db
      .delete(userSessions)
      .where(sql`${userSessions.expiresAt} < now()`)
      .returning({ id: userSessions.id })
  ).length
  const magicLinks = await pruneMagicLinkTokens(db)
  const invitations = await pruneInvitations(db)
  const invitationSendCounters = await pruneInvitationSendCounters(db)
  const tenantCreationCounters = await pruneTenantCreationCounters(db)
  return { sessions, magicLinks, invitations, invitationSendCounters, tenantCreationCounters }
}

/** Nightly prune of expired rows: counts are logged so the run is auditable. */
export const pruneExpired: ScheduledTask = {
  name: 'pruneExpired',
  async run({ db, logger }) {
    const counts = await runPruneExpired(db)
    logger.info(counts, 'pruneExpired: removed expired sessions, magic links and invitations')
  },
}

/**
 * Drop `ai_spans` older than `OBSERVABILITY_SPAN_RETENTION_DAYS`. The local trace store is
 * written on every traced request whether or not a backend is configured, so without this it grows
 * for ever.
 *
 * ONE statement for every tenant, not one DELETE per tenant: a cross-tenant cutoff does not read
 * the whole table — Postgres answers
 * `started_at < $1` from the `(tenant_id, started_at)` index with a bitmap scan when the cutoff is
 * selective, and a sequential scan only when most rows are going anyway. Per tenant would cost
 * `tenants / 10` round trips, each its own HTTP request under `neon`: minutes for a large
 * fleet.
 */
export async function runPruneAiSpans(db: Database, retentionDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  // No `.returning()`: a first prune after a busy fortnight can be a lot of rows, and the ids are
  // not needed — both drivers report the affected count, which `affected()` reads.
  const spans = affected(await db.delete(aiSpans).where(lt(aiSpans.startedAt, cutoff)))
  return { spans, cutoff: cutoff.toISOString() }
}

/**
 * Drop the tool-loop journal (`agent_run_turns`) of runs that settled more than
 * `AGENT_TRANSCRIPT_RETENTION_DAYS` ago — after that a strict replay of the run reports a miss,
 * which is the documented trade. ONE statement across every tenant, like the span prune: a row
 * goes when it is itself older than the cutoff (the `(tenant_id, updated_at)` index) AND its run
 * settled before it. An ACTIVE run's journal is never touched however old it is — `finished_at`
 * stays NULL until the run settles, and a parked run resumes from it.
 */
export async function runPruneAgentTurns(db: Database, retentionDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const turns = affected(
    await db.delete(agentRunTurns).where(
      and(
        lt(agentRunTurns.updatedAt, cutoff),
        exists(
          db
            .select({ one: sql`1` })
            .from(agentRuns)
            .where(and(eq(agentRuns.id, agentRunTurns.runId), lt(agentRuns.finishedAt, cutoff)))
        )
      )
    )
  )
  return { turns, cutoff: cutoff.toISOString() }
}

/** An active run whose row has not changed for this long is checked against the runtime. */
export const SWEEP_STALE_MS = 10 * 60 * 1000
/** Runs checked per sweep: each costs a Workflow `status()` subrequest. Oldest first. */
export const SWEEP_BATCH = 100

/**
 * Find active runs nobody has touched for {@link SWEEP_STALE_MS} — across every tenant, which is why
 * it lives here — and hand each to `sweepRun`, which settles only what the runtime says has
 * ended. The newest event time goes with each row so a run that wrote an event recently is never
 * probed. One failing row is logged and skipped: the next sweep tries it again.
 */
export async function runSweepLostRuns(
  db: Database,
  env: AppBindings,
  logger: Logger,
  now = new Date()
) {
  const stale = new Date(now.getTime() - SWEEP_STALE_MS)
  const candidates = await db
    .select({
      run: agentRuns,
      // Text, parsed below: a raw subquery's timestamp comes back as a string from both drivers.
      lastEventAt: sql<
        string | null
      >`(SELECT max(${agentRunEvents.at})::text FROM ${agentRunEvents} WHERE ${agentRunEvents.runId} = ${agentRuns.id})`,
    })
    .from(agentRuns)
    .where(and(inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]), lt(agentRuns.updatedAt, stale)))
    .orderBy(asc(agentRuns.updatedAt))
    .limit(SWEEP_BATCH)
  const counts = { checked: candidates.length, dispatched: 0, settled: 0, failed: 0 }
  for (const { run, lastEventAt } of candidates) {
    try {
      const at = lastEventAt ? new Date(lastEventAt) : null
      const { action } = await sweepRun(db, env, run, { lastEventAt: at })
      if (action !== 'none') counts[action]++
    } catch (err) {
      counts.failed++
      logger.warn({ err, runId: run.id }, 'sweepLostRuns: could not check run')
    }
  }
  return counts
}

/** Every ten minutes: settle agent runs whose Workflow instance ended without settling them. */
export const sweepLostRuns: ScheduledTask = {
  name: 'sweepLostRuns',
  async run({ db, env, logger }) {
    const result = await runSweepLostRuns(db, env, logger)
    if (result.checked > 0) logger.info(result, 'sweepLostRuns: checked stale active runs')
  },
}

/** Nightly retention for the tool-loop journal. */
export const pruneAgentTurns: ScheduledTask = {
  name: 'pruneAgentTurns',
  async run({ db, config, logger }) {
    const result = await runPruneAgentTurns(db, config.AGENT_TRANSCRIPT_RETENTION_DAYS)
    logger.info(result, 'pruneAgentTurns: removed expired tool-loop journals')
  },
}

/** Nightly retention for the local trace store. */
export const pruneAiSpans: ScheduledTask = {
  name: 'pruneAiSpans',
  async run({ db, config, logger }) {
    const result = await runPruneAiSpans(db, config.OBSERVABILITY_SPAN_RETENTION_DAYS)
    logger.info(result, 'pruneAiSpans: removed expired trace spans')
  },
}

/**
 * Drop `plugin_events` older than `EVENTS_RETENTION_DAYS` (D42). A payload may hold personal data —
 * a form's fields — so the window is short (7 days) and this runs nightly; one DELETE across every
 * tenant from the `(tenant_id, created_at)` index, for the reason `runPruneAiSpans` gives. A
 * delivery still retrying past the cutoff (it cannot be: the backoff ends within the hour) finds no
 * row and is acknowledged.
 */
export async function runPruneEvents(db: Database, retentionDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const events = affected(await db.delete(pluginEvents).where(lt(pluginEvents.createdAt, cutoff)))
  return { events, cutoff: cutoff.toISOString() }
}

/** Nightly retention for recorded plugin events. */
export const pruneEvents: ScheduledTask = {
  name: 'pruneEvents',
  async run({ db, config, logger }) {
    const result = await runPruneEvents(db, config.EVENTS_RETENTION_DAYS)
    logger.info(result, 'pruneEvents: removed expired plugin events')
  },
}

/** Cron expression → tasks. Keep in sync with `[triggers] crons` in both wrangler tomls. */
const CORE_SCHEDULED_TASKS: Record<string, ScheduledTask[]> = {
  '0 4 * * *': [pruneExpired, pruneAiSpans, pruneEvents, pruneAgentTurns],
  '*/10 * * * *': [sweepLostRuns],
}

/**
 * Core tasks plus every installed plugin's. A plugin naming a cron core already runs
 * APPENDS to it — each task is try/caught on its own, so a plugin's failure cannot stop core's
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

  const handle = openDatabase({ ...config, HYPERDRIVE: env.HYPERDRIVE })
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

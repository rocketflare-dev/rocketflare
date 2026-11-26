/**
 * The agents part of `GET /api/home/summary`: top-level runs per UTC day over `HOME_RUN_DAYS`, by
 * outcome and by agent, the same window before it totalled, and the newest runs with who started
 * them, what they were about and what they used. Scoped exactly like the runs list: a member sees
 * the runs they started, admin-level readers every run. Four queries, whatever the volume.
 */
import { ACTIVE_RUN_STATUSES } from '@rocketflare/shared/ai/agents'
import { MICROCENTS_PER_USD } from '@rocketflare/shared/ai/pricing'
import {
  HOME_RUN_DAYS,
  type HomeAgentLine,
  type HomeAgents,
  lastUtcDays,
  runSubject,
} from '@rocketflare/shared/home'
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { agentRuns, aiUsage, users } from '../../../db/schema'
import { isAdminLevel } from '../../middleware/permissions'
import type { AuthContext } from '../../types'
import { isAgentKey, listAgentInfo } from './registry'

/** How many runs the list under the chart shows. */
export const HOME_RECENT_RUNS = 6

const DAY_MS = 86_400_000

export async function homeAgents(
  db: Database,
  auth: AuthContext & { tenantId: string },
  now: Date = new Date()
): Promise<HomeAgents | null> {
  if (!auth.ability.can('read', 'AgentRun')) return null
  const keys = lastUtcDays(HOME_RUN_DAYS, now)
  const since = new Date(`${keys[0]}T00:00:00.000Z`)
  const before = new Date(since.getTime() - HOME_RUN_DAYS * DAY_MS)
  const visible = and(
    eq(agentRuns.tenantId, auth.tenantId),
    isAdminLevel(auth) ? undefined : eq(agentRuns.requestedByUserId, auth.user.id),
    isNull(agentRuns.parentRunId)
  )
  const day = sql<string>`to_char(${agentRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`
  const [perDay, previous, recent] = await Promise.all([
    db
      .select({
        day,
        agentKey: agentRuns.agentKey,
        succeeded: sql<number>`count(*) filter (where ${agentRuns.status} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')::int`,
        cancelled: sql<number>`count(*) filter (where ${agentRuns.status} = 'cancelled')::int`,
        active: sql<number>`count(*) filter (where ${inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES])})::int`,
        last: sql<string>`max(${agentRuns.createdAt})`,
      })
      .from(agentRuns)
      .where(and(visible, gte(agentRuns.createdAt, since)))
      .groupBy(day, agentRuns.agentKey),
    db
      .select({
        runs: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) filter (where ${agentRuns.status} = 'succeeded')::int`,
      })
      .from(agentRuns)
      .where(and(visible, gte(agentRuns.createdAt, before), lt(agentRuns.createdAt, since))),
    db
      .select({
        id: agentRuns.id,
        agentKey: agentRuns.agentKey,
        input: agentRuns.input,
        status: agentRuns.status,
        error: agentRuns.error,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        finishedAt: agentRuns.finishedAt,
        requesterName: users.name,
        requesterAvatar: users.avatarUrl,
      })
      .from(agentRuns)
      .leftJoin(users, eq(users.id, agentRuns.requestedByUserId))
      .where(visible)
      .orderBy(desc(agentRuns.createdAt))
      .limit(HOME_RECENT_RUNS),
  ])

  const usage =
    recent.length === 0
      ? []
      : await db
          .select({
            runId: aiUsage.agentRunId,
            tokens: sql<number>`sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens})::int`,
            cost: sql<string | null>`sum(${aiUsage.costMicrocents})`,
          })
          .from(aiUsage)
          .where(
            and(
              eq(aiUsage.tenantId, auth.tenantId),
              inArray(
                aiUsage.agentRunId,
                recent.map(r => r.id)
              )
            )
          )
          .groupBy(aiUsage.agentRunId)
  const usageOf = new Map(usage.map(u => [u.runId, u]))

  const titles = new Map(listAgentInfo().map(info => [info.key as string, info.title]))
  const titleOf = (key: string) => (isAgentKey(key) && titles.get(key)) || key

  const index = new Map(keys.map((k, i) => [k, i]))
  const days = keys.map(date => ({ date, succeeded: 0, failed: 0, cancelled: 0, active: 0 }))
  const lines = new Map<string, HomeAgentLine>()
  for (const row of perDay) {
    const i = index.get(row.day)
    const target = i === undefined ? undefined : days[i]
    if (i === undefined || !target) continue
    const succeeded = Number(row.succeeded)
    const failed = Number(row.failed)
    const cancelled = Number(row.cancelled)
    const active = Number(row.active)
    target.succeeded += succeeded
    target.failed += failed
    target.cancelled += cancelled
    target.active += active
    const line = lines.get(row.agentKey) ?? {
      agentKey: row.agentKey,
      agentTitle: titleOf(row.agentKey),
      runs: 0,
      failed: 0,
      lastRunAt: new Date(row.last),
      daily: keys.map(() => 0),
    }
    const total = succeeded + failed + cancelled + active
    line.runs += total
    line.failed += failed
    line.daily[i] = (line.daily[i] ?? 0) + total
    const last = new Date(row.last)
    if (last > line.lastRunAt) line.lastRunAt = last
    lines.set(row.agentKey, line)
  }

  return {
    days,
    recent: recent.map(run => {
      const used = usageOf.get(run.id)
      const cost = used?.cost == null ? null : Number(used.cost) / MICROCENTS_PER_USD
      return {
        id: run.id,
        agentKey: run.agentKey,
        agentTitle: titleOf(run.agentKey),
        subject: runSubject(run.input),
        status: run.status,
        error: run.error,
        requestedBy: run.requesterName
          ? { name: run.requesterName, avatarUrl: run.requesterAvatar ?? null }
          : null,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        tokens: used && Number(used.tokens) > 0 ? Number(used.tokens) : null,
        costUsd: cost,
      }
    }),
    previous: {
      runs: Number(previous[0]?.runs ?? 0),
      succeeded: Number(previous[0]?.succeeded ?? 0),
    },
    byAgent: [...lines.values()].sort(
      (a, b) => b.runs - a.runs || b.lastRunAt.getTime() - a.lastRunAt.getTime()
    ),
  }
}

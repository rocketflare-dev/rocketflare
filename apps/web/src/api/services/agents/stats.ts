/**
 * Per-agent stats for the agents page (`GET /api/agents/stats`): runs, outcomes, tokens, cost and
 * mean duration over a window, plus each agent's newest run. Three grouped queries — counts,
 * spend, the last run — never one per agent, so the page costs the same with fifty agents as two.
 *
 * Scope is the caller's: `requestedByUserId` narrows a member to their own runs, exactly as the runs
 * list does, so a member's metrics never include work they cannot open. Child runs count as runs of
 * their own agent; `lastRun` is top-level only, since the page links straight to it.
 */
import {
  ACTIVE_RUN_STATUSES,
  AGENT_KEYS,
  type AgentKey,
  type AgentStats,
  type AgentStatsResponse,
} from '@rocketflare/shared/ai/agents'
import { MICROCENTS_PER_USD } from '@rocketflare/shared/ai/pricing'
import { and, desc, eq, gte, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { agentRuns, aiUsage } from '../../../db/schema'
import { isAgentKey } from './registry'

export async function agentStats(
  db: Database,
  scope: { tenantId: string; requestedByUserId?: string },
  days: number,
  now: Date = new Date()
): Promise<AgentStatsResponse> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const visible: SQL | undefined = and(
    eq(agentRuns.tenantId, scope.tenantId),
    scope.requestedByUserId ? eq(agentRuns.requestedByUserId, scope.requestedByUserId) : undefined
  )
  const inWindow = and(visible, gte(agentRuns.createdAt, since))

  const [counts, spend, last] = await Promise.all([
    db
      .select({
        agentKey: agentRuns.agentKey,
        runs: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) filter (where ${agentRuns.status} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')::int`,
        active: sql<number>`count(*) filter (where ${inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES])})::int`,
        avgMs: sql<
          number | null
        >`avg(extract(epoch from (${agentRuns.finishedAt} - coalesce(${agentRuns.startedAt}, ${agentRuns.createdAt}))) * 1000) filter (where ${agentRuns.finishedAt} is not null)`,
      })
      .from(agentRuns)
      .where(inWindow)
      .groupBy(agentRuns.agentKey),
    db
      .select({
        agentKey: agentRuns.agentKey,
        tokens: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens} + ${aiUsage.cacheReadTokens} + ${aiUsage.cacheWriteTokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${aiUsage.costMicrocents}), 0)::bigint`,
      })
      .from(aiUsage)
      .innerJoin(agentRuns, eq(agentRuns.id, aiUsage.agentRunId))
      .where(and(eq(aiUsage.tenantId, scope.tenantId), inWindow))
      .groupBy(agentRuns.agentKey),
    db
      .selectDistinctOn([agentRuns.agentKey], {
        agentKey: agentRuns.agentKey,
        id: agentRuns.id,
        status: agentRuns.status,
        createdAt: agentRuns.createdAt,
        finishedAt: agentRuns.finishedAt,
      })
      .from(agentRuns)
      .where(and(visible, isNull(agentRuns.parentRunId)))
      .orderBy(agentRuns.agentKey, desc(agentRuns.createdAt)),
  ])

  const byKey = new Map<AgentKey, AgentStats>(
    AGENT_KEYS.map(agentKey => [
      agentKey,
      {
        agentKey,
        runs: 0,
        succeeded: 0,
        failed: 0,
        active: 0,
        tokens: 0,
        costUsd: 0,
        avgDurationMs: null,
        lastRun: null,
      },
    ])
  )
  // A row of an agent this deployment no longer registers has nowhere to show.
  const entry = (key: string) => (isAgentKey(key) ? byKey.get(key) : undefined)
  for (const row of counts) {
    const stats = entry(row.agentKey)
    if (!stats) continue
    stats.runs = Number(row.runs)
    stats.succeeded = Number(row.succeeded)
    stats.failed = Number(row.failed)
    stats.active = Number(row.active)
    stats.avgDurationMs = row.avgMs === null ? null : Math.round(Number(row.avgMs))
  }
  for (const row of spend) {
    const stats = entry(row.agentKey)
    if (!stats) continue
    stats.tokens = Number(row.tokens)
    stats.costUsd = Number(row.cost) / MICROCENTS_PER_USD
  }
  for (const row of last) {
    const stats = entry(row.agentKey)
    if (!stats) continue
    stats.lastRun = {
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    }
  }
  return { since, items: [...byKey.values()] }
}

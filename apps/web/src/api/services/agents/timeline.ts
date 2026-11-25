/**
 * The run inspector: one chronological timeline of everything a run recorded, for
 * `GET /api/agents/runs/:id/timeline` (the CLI's `agents inspect`, the admin run-timeline page).
 *
 * It reads; it never settles, nudges or writes. Each source keeps its own table — this only merges
 * them by time, so an entry's `detail` is the record trimmed, never a second copy of the truth.
 * Model turns carry their usage and stop reason, never the transcript (that is the replay's and
 * the trace's job, and a timeline is read on a phone).
 */
import type { AgentRunTimeline, AgentTimelineEntry } from '@rocketflare/shared/ai/agent-timeline'
import { MICROCENTS_PER_USD } from '@rocketflare/shared/ai/pricing'
import { and, asc, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AgentRunRow, agentRunEffects, agentRuns, agentRunTurns } from '../../../db/schema'
import { type RunSpend, runSpend } from '../ai/usage'
import { budgetFor } from './budget'
import { listDecisions } from './decisions'
import { listInterrupts } from './interrupts'
import { getAgent, isAgentKey } from './registry'
import { agentVersionOf, listEvents, toAgentRun } from './runs'

/** Runtime bookkeeping effects are shown as what they are, not as an agent's `once`. */
const BOOKKEEPING = ['steering:', 'notify:', 'tool:']

function spendOf(spend: RunSpend) {
  return {
    calls: spend.calls,
    tokens: spend.inputTokens + spend.outputTokens + spend.cacheReadTokens + spend.cacheWriteTokens,
    costUsd: spend.costMicrocents / MICROCENTS_PER_USD,
  }
}

export async function runTimeline(
  db: Database,
  cfg: AppConfig,
  run: AgentRunRow
): Promise<AgentRunTimeline> {
  const { tenantId, id: runId } = run
  const [events, turns, effects, decisions, interrupts, children, own, tree] = await Promise.all([
    listEvents(db, tenantId, runId),
    db
      .select()
      .from(agentRunTurns)
      .where(and(eq(agentRunTurns.tenantId, tenantId), eq(agentRunTurns.runId, runId)))
      .orderBy(asc(agentRunTurns.createdAt)),
    db
      .select()
      .from(agentRunEffects)
      .where(and(eq(agentRunEffects.tenantId, tenantId), eq(agentRunEffects.runId, runId)))
      .orderBy(asc(agentRunEffects.at)),
    listDecisions(db, tenantId, runId),
    listInterrupts(db, tenantId, runId),
    db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.parentRunId, runId)))
      .orderBy(asc(agentRuns.createdAt)),
    runSpend(db, tenantId, runId),
    runSpend(db, tenantId, runId, { descendants: true }),
  ])

  const entries: AgentTimelineEntry[] = []
  for (const event of events) {
    // Text deltas are the chat stream, not the run's story; the turn rows say the same in one line.
    if (event.type === 'text') continue
    const data = event.data as Record<string, unknown>
    const status = typeof data.status === 'string' ? ` ${data.status}` : ''
    const reason = typeof data.reason === 'string' ? ` (${data.reason})` : ''
    entries.push({
      at: event.at,
      kind: 'event',
      label: `${event.type}${status}${reason}`,
      ref: null,
      detail: event.data,
    })
  }
  for (const turn of turns) {
    const scope = turn.loopKey ? ` (${turn.loopKey})` : ''
    if (turn.role === 'model') {
      const content = turn.content as { usage?: unknown; stopReason?: unknown } | null
      entries.push({
        at: turn.createdAt,
        kind: 'turn',
        label: `model turn ${turn.turn}${scope}`,
        ref: null,
        detail: { usage: content?.usage, stopReason: content?.stopReason },
      })
    } else {
      entries.push({
        at: turn.createdAt,
        kind: 'tool',
        label: `tool ${turn.toolName ?? '?'} ${turn.status}${scope}`,
        ref: turn.toolCallId,
      })
    }
  }
  for (const effect of effects) {
    const bookkeeping = BOOKKEEPING.some(prefix => effect.key.startsWith(prefix))
    entries.push({
      at: effect.at,
      kind: effect.key.startsWith('spawn:') ? 'child' : 'effect',
      label: effect.key.startsWith('spawn:')
        ? `child output recorded ${effect.key.slice('spawn:'.length)}`
        : `${bookkeeping ? 'runtime' : 'once'} ${effect.key}`,
      ref: effect.key,
    })
  }
  for (const decision of decisions) {
    entries.push({
      at: decision.createdAt,
      kind: 'decision',
      label: `decide ${decision.key} (${decision.method}, ${decision.model})`,
      ref: decision.key,
      detail: decision.answers,
    })
  }
  for (const ask of interrupts) {
    entries.push({
      at: ask.createdAt,
      kind: 'interrupt',
      label: `asked ${ask.kind} ${ask.key}`,
      ref: ask.id,
      detail: { message: ask.message },
    })
    if (ask.resolvedAt) {
      entries.push({
        at: ask.resolvedAt,
        kind: 'interrupt',
        label: `answered ${ask.key}: ${ask.status}`,
        ref: ask.id,
        detail: { payload: ask.payload, resolvedByUserId: ask.resolvedByUserId },
      })
    }
  }
  for (const child of children) {
    entries.push({
      at: child.createdAt,
      kind: 'child',
      label: `spawned ${child.agentKey}`,
      ref: child.id,
    })
    if (child.finishedAt) {
      entries.push({
        at: child.finishedAt,
        kind: 'child',
        label: `child ${child.agentKey} ${child.status}`,
        ref: child.id,
      })
    }
  }
  // Stable: two records in the same millisecond keep the order their sources gave them.
  entries.sort((a, b) => a.at.getTime() - b.at.getTime())

  const meta = isAgentKey(run.agentKey) ? getAgent(run.agentKey).meta : undefined
  const budget = budgetFor(cfg, meta?.budget, run.budget)
  return {
    run: toAgentRun(run),
    versions: {
      agentVersion: run.agentVersion,
      currentAgentVersion: meta ? agentVersionOf(meta) : null,
      workerVersionId: run.workerVersionId,
    },
    spend: {
      own: spendOf(own),
      tree: spendOf(tree),
      budget: {
        ...(budget.maxTokens !== undefined && { maxTokens: budget.maxTokens }),
        ...(budget.maxCostMicrocents !== undefined && {
          maxCostUsd: budget.maxCostMicrocents / MICROCENTS_PER_USD,
        }),
      },
    },
    children: children.map(child => ({
      id: child.id,
      agentKey: toAgentRun(child).agentKey,
      status: child.status,
      createdAt: child.createdAt,
      finishedAt: child.finishedAt,
    })),
    entries,
  }
}

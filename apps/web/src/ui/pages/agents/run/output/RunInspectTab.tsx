/**
 * The inspector (admins): every record the run left, merged by time — events, model turns, tool
 * calls, `ctx.once` effects, decisions, asks, child runs — with the versions it ran under and its
 * spend against its budget. The same contract as `rocketflare agents inspect <runId>`. The
 * Timeline panel beside it tells the run's story for whoever asked; this tells an operator what
 * actually happened, row by row.
 */

import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import type { AgentTimelineEntry } from '@rocketflare/shared/ai/agent-timeline'
import { Link } from 'react-router'
import { Row, Section } from '@/ui/components/ai/StatRows'
import { EmptyState, SkeletonRows } from '@/ui/components/shared'
import { useAgentRunTimeline } from '@/ui/hooks/useAgents'

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`

const KIND_BADGE: Record<AgentTimelineEntry['kind'], string> = {
  event: 'badge-ghost',
  turn: 'badge-info',
  tool: 'badge-info badge-outline',
  effect: 'badge-neutral badge-outline',
  decision: 'badge-secondary',
  interrupt: 'badge-warning',
  child: 'badge-accent',
}

export function RunInspectTab({ runId }: { runId: string }) {
  const timeline = useAgentRunTimeline(runId)
  if (timeline.isPending) return <SkeletonRows rows={6} />
  if (timeline.isError || !timeline.data) {
    return (
      <EmptyState
        icon={ExclamationTriangleIcon}
        message="Could not load the timeline"
        description={timeline.error?.message}
      />
    )
  }
  const { versions, spend, children, entries, run } = timeline.data
  const start = entries[0]?.at.getTime() ?? 0
  const moved =
    versions.currentAgentVersion !== null && versions.currentAgentVersion !== versions.agentVersion

  return (
    <div className="surface-panel p-0 overflow-hidden">
      <Section title="Versions">
        <Row
          label="Agent version"
          value={
            moved
              ? `v${versions.agentVersion} (deployed: v${versions.currentAgentVersion})`
              : `v${versions.agentVersion}`
          }
        />
        <Row label="Worker version" value={versions.workerVersionId ?? '—'} />
        {run.parentRunId && (
          <Row
            label="Parent run"
            value={
              <Link to={`/agents/runs/${run.parentRunId}`}>{run.parentRunId.slice(0, 8)}</Link>
            }
          />
        )}
      </Section>
      <Section title="Spend">
        <Row
          label="This run"
          value={`${spend.own.tokens} tokens · ${usd(spend.own.costUsd)} · ${spend.own.calls} calls`}
        />
        {children.length > 0 && (
          <Row
            label="With children"
            value={`${spend.tree.tokens} tokens · ${usd(spend.tree.costUsd)}`}
            hint="What the budget is checked against"
          />
        )}
        <Row
          label="Budget"
          value={
            [
              spend.budget.maxTokens !== undefined && `${spend.budget.maxTokens} tokens`,
              spend.budget.maxCostUsd !== undefined && usd(spend.budget.maxCostUsd),
            ]
              .filter(Boolean)
              .join(' · ') || 'no cap'
          }
        />
      </Section>
      {children.length > 0 && (
        <Section title={`Child runs (${children.length})`}>
          {children.map(child => (
            <Row
              key={child.id}
              label={child.agentKey}
              value={
                <Link
                  to={`/agents/runs/${child.id}`}
                >{`${child.id.slice(0, 8)} · ${child.status}`}</Link>
              }
            />
          ))}
        </Section>
      )}
      <Section title={`Records (${entries.length})`}>
        <ol className="text-xs font-mono divide-y divide-[color:var(--border-subtle)]">
          {entries.map((entry, i) => (
            <li
              // Entries carry no id of their own; their order is the point.
              // biome-ignore lint/suspicious/noArrayIndexKey: a read-only, append-ordered list
              key={i}
              className="flex items-baseline gap-2 py-1"
            >
              <span className="w-14 shrink-0 text-right text-base-content/60">
                +{((entry.at.getTime() - start) / 1000).toFixed(1)}s
              </span>
              <span className={`badge badge-xs ${KIND_BADGE[entry.kind]}`}>{entry.kind}</span>
              <span className="break-all">{entry.label}</span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  )
}

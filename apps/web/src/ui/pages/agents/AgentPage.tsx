/**
 * `/agents/:agentKey`: one agent — what it does, its last 30 days as four numbers, and its runs
 * (the shared `RunsTable`, fixed to this agent). Run starts it here. An unknown key is a 404-like
 * empty state rather than a crash: a bookmark outlives an agent.
 */
import { CpuChipIcon, PlayIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { EmptyState, PageHeader, SkeletonRows } from '@/ui/components/shared'
import { useAgentList, useAgentStats } from '@/ui/hooks/useAgents'
import { AgentBadges, STATS_DAYS } from './AgentsPage'
import { formatAvgDuration, formatTokens, formatUsd } from './agentMetrics'
import { RunAgentModal } from './RunAgentModal'
import { RunsTable } from './RunsTable'

export default function AgentPage() {
  const { agentKey } = useParams<{ agentKey: string }>()
  const navigate = useNavigate()
  const agents = useAgentList()
  const stats = useAgentStats(STATS_DAYS)
  const [runOpen, setRunOpen] = useState(false)

  const items = agents.data?.items ?? []
  const agent = items.find(a => a.key === agentKey)
  const titleOf = (key: string) => items.find(a => a.key === key)?.title ?? key
  const mine = stats.data?.items.find(s => s.agentKey === agentKey)

  if (agents.isLoading) return <SkeletonRows rows={6} />
  if (!agent) {
    return (
      <EmptyState
        icon={CpuChipIcon}
        message="No such agent"
        description="It may have been removed or renamed."
        action={
          <Link to="/agents" className="btn btn-sm">
            All agents
          </Link>
        }
      />
    )
  }

  const cards = [
    {
      label: `Runs · ${STATS_DAYS}d`,
      value: mine ? String(mine.runs) : '…',
      hint:
        mine && mine.runs > 0 ? `${mine.succeeded} succeeded · ${mine.failed} failed` : undefined,
    },
    { label: 'Tokens', value: mine ? formatTokens(mine.tokens) : '…' },
    { label: 'Avg time', value: mine ? formatAvgDuration(mine) : '…' },
    { label: 'Cost', value: mine ? formatUsd(mine.costUsd) : '…', hint: 'priced calls only' },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title={agent.title}
        breadcrumbs={[{ label: 'Agents', to: '/agents' }, { label: agent.title }]}
        description={agent.description}
        actions={
          <button
            type="button"
            className="btn btn-primary btn-sm gap-1"
            onClick={() => setRunOpen(true)}
          >
            <PlayIcon className="w-4 h-4" />
            Run
          </button>
        }
      />
      <div className="flex items-center gap-2 flex-wrap">
        <AgentBadges agent={agent} />
      </div>
      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Agent metrics">
        {cards.map(card => (
          <div key={card.label} className="surface-panel px-4 py-3">
            <dt className="text-xs text-secondary">{card.label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{card.value}</dd>
            {card.hint && <dd className="text-xs text-muted">{card.hint}</dd>}
          </div>
        ))}
      </dl>
      <RunsTable titleOf={titleOf} fixedAgentKey={agent.key} />
      <RunAgentModal
        agent={runOpen ? agent : null}
        onClose={() => setRunOpen(false)}
        onStarted={run => {
          setRunOpen(false)
          navigate(`/agents/runs/${run.id}`)
        }}
      />
    </div>
  )
}

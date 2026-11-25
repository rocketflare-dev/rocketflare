/**
 * `/agents`: every registered agent as one row — what it does, its newest run, and its last 30
 * days (runs, tokens, mean duration, cost) — with Run. Built to stay readable at fifty agents: one
 * row each, one request for every metric (`GET /api/agents/stats`), and an agent's runs on its own
 * page (`/agents/:agentKey`) rather than one table of everything beside the list. Every run, across
 * agents, is `/agents/runs` — where the "waiting on you" link points.
 *
 * Members see metrics over their own runs, admin+ over every run — the stats route decides, as the
 * runs list does. Lazy in `App.tsx`.
 */
import { CpuChipIcon, PlayIcon } from '@heroicons/react/24/outline'
import type { AgentInfo, AgentStats } from '@rocketflare/shared/ai/agents'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { EmptyState, PageHeader, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useAgentList, useAgentStats, useAwaitingInterruptCount } from '@/ui/hooks/useAgents'
import { timeAgo } from '@/ui/lib/format'
import { formatAvgDuration, formatTokens, formatUsd, runsSummary } from './agentMetrics'
import { RunAgentModal } from './RunAgentModal'
import { RunStatusBadge } from './RunStatusBadge'
import { ABOVE_ROW, LINK_ROW, ROW_LINK } from './rowLink'

export const STATS_DAYS = 30

export default function AgentsPage() {
  const navigate = useNavigate()
  const agents = useAgentList()
  const stats = useAgentStats(STATS_DAYS)
  const awaiting = useAwaitingInterruptCount()
  const [running, setRunning] = useState<AgentInfo | null>(null)

  const items = agents.data?.items ?? []
  const statsOf = (key: string) => stats.data?.items.find(s => s.agentKey === key)
  // A column of nothing but "—" says nothing: tokens and cost show once any agent has some
  // (a deployment whose model reports no usage, or prices no call, never grows them).
  const statItems = stats.data?.items ?? []
  const columns = {
    tokens: statItems.some(s => s.tokens > 0),
    cost: statItems.some(s => s.costUsd > 0),
  }

  return (
    <div>
      <PageHeader
        title="Agents"
        description="Start an agent and watch it work. Every run is durable — come back to it any time."
        actions={
          <div className="flex items-center gap-2">
            {(awaiting.data ?? 0) > 0 && (
              <Link to="/agents/runs?awaiting=1" className="btn btn-sm btn-warning">
                {awaiting.data} waiting on you
              </Link>
            )}
            <Link to="/agents/runs" className="btn btn-sm">
              All runs
            </Link>
          </div>
        }
      />
      <SectionPanel
        flush
        title={`Last ${STATS_DAYS} days`}
        description={`${metricWords(columns)} for each agent`}
      >
        {agents.isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={4} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={CpuChipIcon} size="sm" message="No agents registered" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table" aria-label="Agents">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Last run</th>
                  <th className="text-right">Runs</th>
                  {columns.tokens && <th className="text-right">Tokens</th>}
                  <th className="text-right">Avg time</th>
                  {columns.cost && <th className="text-right">Cost</th>}
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map(agent => (
                  <AgentRow
                    key={agent.key}
                    agent={agent}
                    stats={statsOf(agent.key)}
                    columns={columns}
                    loading={stats.isLoading}
                    onRun={() => setRunning(agent)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>

      <RunAgentModal
        agent={running}
        onClose={() => setRunning(null)}
        onStarted={run => {
          setRunning(null)
          navigate(`/agents/runs/${run.id}`)
        }}
      />
    </div>
  )
}

/** "Runs, tokens, time and cost" — only the metrics the table shows. */
function metricWords(columns: { tokens: boolean; cost: boolean }): string {
  const words = ['Runs', ...(columns.tokens ? ['tokens'] : []), 'average time']
  if (columns.cost) words.push('cost')
  return words.length === 2
    ? words.join(' and ')
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

export function AgentBadges({ agent }: { agent: AgentInfo }) {
  return (
    <>
      {agent.exclusive && (
        <span
          className="badge badge-ghost badge-sm"
          title="Starting it while a run is still going opens that run instead of a second one"
        >
          One run at a time
        </span>
      )}
    </>
  )
}

function AgentRow({
  agent,
  stats,
  columns,
  loading,
  onRun,
}: {
  agent: AgentInfo
  stats: AgentStats | undefined
  columns: { tokens: boolean; cost: boolean }
  loading: boolean
  onRun: () => void
}) {
  const metric = (value: string) => (loading ? '…' : value)
  return (
    <tr data-agent-key={agent.key} className={LINK_ROW}>
      <td className="min-w-[18rem]">
        <div className="flex items-center gap-2 flex-wrap">
          {/* A real link: the agent's page is where its runs are. */}
          <Link to={`/agents/${agent.key}`} className={`font-medium link link-hover ${ROW_LINK}`}>
            {agent.title}
          </Link>
          <AgentBadges agent={agent} />
        </div>
        <p className="text-xs text-secondary line-clamp-1 max-w-2xl" title={agent.description}>
          {agent.description}
        </p>
      </td>
      <td className="whitespace-nowrap">
        {stats?.lastRun ? (
          <Link
            to={`/agents/runs/${stats.lastRun.id}`}
            className={`inline-flex items-center gap-2 link link-hover ${ABOVE_ROW}`}
            aria-label={`Last run of ${agent.title}`}
          >
            <RunStatusBadge status={stats.lastRun.status} />
            <span className="text-xs text-secondary">{timeAgo(stats.lastRun.createdAt)}</span>
          </Link>
        ) : (
          <span className="text-xs text-muted">{loading ? '…' : 'never run'}</span>
        )}
      </td>
      <td className="text-right tabular-nums whitespace-nowrap">
        {metric(stats ? runsSummary(stats) : '—')}
      </td>
      {columns.tokens && (
        <td className="text-right tabular-nums">
          {metric(stats ? formatTokens(stats.tokens) : '—')}
        </td>
      )}
      <td className="text-right tabular-nums">{metric(stats ? formatAvgDuration(stats) : '—')}</td>
      {columns.cost && (
        <td className="text-right tabular-nums">
          {metric(stats ? formatUsd(stats.costUsd) : '—')}
        </td>
      )}
      <td className="text-right">
        <button
          type="button"
          className={`btn btn-primary btn-xs gap-1 ${ABOVE_ROW}`}
          onClick={onRun}
          aria-label={`Run ${agent.title}`}
        >
          <PlayIcon className="w-3.5 h-3.5" />
          Run
        </button>
      </td>
    </tr>
  )
}

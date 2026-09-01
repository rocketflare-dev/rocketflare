/**
 * `/agents` and `/agents/runs/:runId` (D7, D8, D17, D20): the registered agents on the left (title,
 * description, exclusive badge, Run → `RunAgentModal`), the runs table on the right (status with a
 * live dot, agent, requested by, started/finished, duration; agent + status filters; paginated).
 * A row opens `RunDetailDrawer` at `/agents/runs/:id`, so a run is a URL you can share. The list
 * refreshes on the `agent-run` nudge and polls while any row is active. Members see their own
 * runs, admin+ every run — the route decides. Lazy in App.tsx: this chunk carries `Markdown`.
 */

import { CpuChipIcon, PlayIcon } from '@heroicons/react/24/outline'
import {
  AGENT_KEYS,
  type AgentInfo,
  type AgentRun,
  type AgentRunStatus,
  agentRunStatusSchema,
} from '@rocketflare/shared/ai/agents'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  EmptyState,
  PageHeader,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAgentList, useAgentRuns } from '@/ui/hooks/useAgents'
import { useAuth } from '@/ui/hooks/useAuth'
import { formatDateTime } from '@/ui/lib/format'
import { RunAgentModal } from './RunAgentModal'
import { RunDetailDrawer, runDuration } from './RunDetailDrawer'
import { RunStatusBadge } from './RunStatusBadge'

const STATUS_LABELS: Record<AgentRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export default function AgentsPage() {
  const { runId } = useParams<{ runId: string }>()
  const navigate = useNavigate()
  const agents = useAgentList()
  const [running, setRunning] = useState<AgentInfo | null>(null)

  const items = agents.data?.items ?? []
  const titleOf = (key: string) => items.find(a => a.key === key)?.title ?? key

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Agents"
        description="Start an agent and watch it work. Every run is durable — come back to it any time."
      />
      <div className="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-4 items-start">
        <SectionPanel flush title="Available agents">
          {agents.isLoading ? (
            <div className="p-4">
              <SkeletonRows rows={2} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon={CpuChipIcon} size="sm" message="No agents registered" />
          ) : (
            <ul className="divide-y divide-[color:var(--border-subtle)]">
              {items.map(agent => (
                <li key={agent.key} className="p-4 space-y-2" data-agent-key={agent.key}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{agent.title}</span>
                    {agent.exclusive && (
                      <span className="badge badge-ghost badge-sm" title="One run at a time">
                        exclusive
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-secondary">{agent.description}</p>
                  <button
                    type="button"
                    className="btn btn-primary btn-xs gap-1"
                    onClick={() => setRunning(agent)}
                    aria-label={`Run ${agent.title}`}
                  >
                    <PlayIcon className="w-3.5 h-3.5" />
                    Run
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionPanel>

        <RunsTable titleOf={titleOf} onOpen={id => navigate(`/agents/runs/${id}`)} />
      </div>

      <RunAgentModal
        agent={running}
        onClose={() => setRunning(null)}
        onStarted={run => {
          setRunning(null)
          navigate(`/agents/runs/${run.id}`)
        }}
      />

      {runId && <RunDetailDrawer runId={runId} onClose={() => navigate('/agents')} />}
    </div>
  )
}

function RunsTable({
  titleOf,
  onOpen,
}: {
  titleOf: (agentKey: string) => string
  onOpen: (id: string) => void
}) {
  const { user } = useAuth()
  const [page, setPage] = useState(1)
  const [agentKey, setAgentKey] = useState('')
  const [status, setStatus] = useState<AgentRunStatus | ''>('')
  const runs = useAgentRuns({ page, agentKey, status })
  const rows = runs.data?.items ?? []

  const requestedBy = (run: AgentRun) =>
    run.requestedByUserId === null ? (
      <span className="text-muted">system</span>
    ) : run.requestedByUserId === user?.id ? (
      'You'
    ) : (
      <span className="font-mono text-xs text-muted" title={run.requestedByUserId}>
        {run.requestedByUserId.slice(0, 8)}
      </span>
    )

  return (
    <SectionPanel
      flush
      title="Runs"
      actions={
        <div className="flex items-center gap-2">
          <label htmlFor="runs-agent" className="sr-only">
            Agent
          </label>
          <select
            id="runs-agent"
            className="select select-xs"
            value={agentKey}
            onChange={e => {
              setAgentKey(e.target.value)
              setPage(1)
            }}
          >
            <option value="">All agents</option>
            {AGENT_KEYS.map(key => (
              <option key={key} value={key}>
                {titleOf(key)}
              </option>
            ))}
          </select>
          <label htmlFor="runs-status" className="sr-only">
            Status
          </label>
          <select
            id="runs-status"
            className="select select-xs"
            value={status}
            onChange={e => {
              setStatus(e.target.value as AgentRunStatus | '')
              setPage(1)
            }}
          >
            <option value="">Any status</option>
            {agentRunStatusSchema.options.map(s => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {runs.isLoading ? (
        <div className="p-4">
          <SkeletonRows rows={4} />
        </div>
      ) : runs.isError ? (
        <p className="p-4 text-sm text-error" role="alert">
          Runs could not be loaded.
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CpuChipIcon}
          size="sm"
          message="No runs yet"
          description="Run an agent from the list to see it here."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table" aria-label="Agent runs">
            <thead>
              <tr>
                <th>Status</th>
                <th>Agent</th>
                <th>Requested by</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(run => (
                <tr
                  key={run.id}
                  className="cursor-pointer"
                  onClick={() => onOpen(run.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpen(run.id)
                    }
                  }}
                  tabIndex={0}
                  aria-label={`Open run ${run.id.slice(0, 8)}`}
                >
                  <td>
                    <RunStatusBadge status={run.status} />
                  </td>
                  <td className="font-medium">{titleOf(run.agentKey)}</td>
                  <td>{requestedBy(run)}</td>
                  <td className="whitespace-nowrap text-secondary">
                    {formatDateTime(run.startedAt ?? run.createdAt)}
                  </td>
                  <td className="whitespace-nowrap text-secondary">
                    {formatDateTime(run.finishedAt)}
                  </td>
                  <td className="tabular-nums text-secondary">{runDuration(run) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.data && (
        <div className="px-5 pb-5">
          <PaginationControls
            pagination={runs.data.pagination}
            onPageChange={setPage}
            isLoading={runs.isFetching}
          />
        </div>
      )}
    </SectionPanel>
  )
}

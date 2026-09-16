/**
 * `/agents` (D7, D8, D17, D20, issue #17): the registered agents on the left (title, description,
 * exclusive badge, Run → `RunAgentModal`), the runs table on the right (status with a live dot,
 * agent, requested by, started/finished, duration; agent + status filters and an "awaiting input"
 * chip; paginated). The list refreshes on the `agent-run` nudge and polls while any row still owes
 * an answer. Members see their own runs, admin+ every run — the route decides.
 *
 * Two deliberate details. **Every row is a real `<Link>`**: middle-click and open-in-new-tab are
 * half the point of a run being a page rather than a modal, and a `<tr onClick>` gives neither.
 * And **the filters live in `useSearchParams`**, not `useState`, so `/agents?awaiting=1` is a URL
 * the status badge, the SideNav badge and a notification can all point at.
 *
 * Lazy in `App.tsx`: this chunk carries `Markdown` through the run page's tree.
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
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  EmptyState,
  PageHeader,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAgentList, useAgentRuns } from '@/ui/hooks/useAgents'
import { useAuth } from '@/ui/hooks/useAuth'
import { formatDateTime, runDuration } from '@/ui/lib/format'
import { RunAgentModal } from './RunAgentModal'
import { RunStatusBadge, STATUS_LABELS } from './RunStatusBadge'

export default function AgentsPage() {
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

        <RunsTable titleOf={titleOf} />
      </div>

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

/** The filter state, read from and written to the URL so every filtered view is linkable. */
function useRunFilters() {
  const [params, setParams] = useSearchParams()
  const awaiting = params.get('awaiting') === '1'
  const page = Number(params.get('page') ?? '1')
  const status = (params.get('status') ?? '') as AgentRunStatus | ''
  const patch = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
    }
    // Any filter change resets paging: page 3 of the old filter is nowhere in the new one.
    if (!('page' in changes)) next.delete('page')
    setParams(next, { replace: true })
  }
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    agentKey: params.get('agentKey') ?? '',
    // `?awaiting=1` is a chip over the same status filter, not a second dimension.
    status: awaiting ? ('awaiting_input' as AgentRunStatus) : status,
    awaiting,
    patch,
  }
}

function RunsTable({ titleOf }: { titleOf: (agentKey: string) => string }) {
  const { user } = useAuth()
  const { page, agentKey, status, awaiting, patch } = useRunFilters()
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
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            className={`btn btn-xs ${awaiting ? 'btn-warning' : 'btn-ghost'}`}
            aria-pressed={awaiting}
            onClick={() => patch({ awaiting: awaiting ? null : '1', status: null })}
          >
            Awaiting input
          </button>
          <label htmlFor="runs-agent" className="sr-only">
            Agent
          </label>
          <select
            id="runs-agent"
            className="select select-xs"
            value={agentKey}
            onChange={e => patch({ agentKey: e.target.value })}
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
            onChange={e => patch({ status: e.target.value, awaiting: null })}
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
          message={awaiting ? 'Nothing is waiting on you' : 'No runs yet'}
          description={awaiting ? undefined : 'Run an agent from the list to see it here.'}
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
                <tr key={run.id}>
                  <td>
                    <RunStatusBadge status={run.status} />
                  </td>
                  <td className="font-medium">
                    {/* A real link, so middle-click and open-in-new-tab work — half the point of
                        a run being a page. */}
                    <Link to={`/agents/runs/${run.id}`} className="link link-hover">
                      {titleOf(run.agentKey)}
                    </Link>
                  </td>
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
            onPageChange={next => patch({ page: String(next) })}
            isLoading={runs.isFetching}
          />
        </div>
      )}
    </SectionPanel>
  )
}

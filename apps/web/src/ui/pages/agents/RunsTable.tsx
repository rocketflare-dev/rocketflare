/**
 * The runs table, shared by `/agents/runs` (every agent) and `/agents/:agentKey` (one agent,
 * `fixedAgentKey`, which drops the agent filter and column). Status filters and paging live in the
 * URL (`useSearchParams`), so `/agents/runs?awaiting=1` is a link the badges can point at, and every
 * row is a real `<Link>`, so a run opens in a new tab. Below `sm` each row stacks (agent, then
 * status and when) — `lib/stacked-table.ts`.
 */
import { CpuChipIcon } from '@heroicons/react/24/outline'
import {
  AGENT_KEYS,
  type AgentKey,
  type AgentRunListItem,
  type AgentRunStatus,
  agentRunStatusSchema,
} from '@rocketflare/shared/ai/agents'
import { Link, useSearchParams } from 'react-router'
import {
  Avatar,
  EmptyState,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAgentRuns } from '@/ui/hooks/useAgents'
import { useAuth } from '@/ui/hooks/useAuth'
import { eventLabel, formatDateTime, runDuration, timeAgoShort } from '@/ui/lib/format'
import {
  STACK_BODY,
  STACK_CELL,
  STACK_HEAD,
  STACK_HIDE,
  STACK_LEAD,
  STACK_ROW,
  STACK_TABLE,
} from '@/ui/lib/stacked-table'
import { RunStatusBadge, STATUS_LABELS } from './RunStatusBadge'
import { LINK_ROW, ROW_LINK } from './rowLink'

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

export function RunsTable({
  titleOf,
  fixedAgentKey,
  title,
}: {
  titleOf: (agentKey: string) => string
  /** One agent's runs: no agent filter, no agent column. */
  fixedAgentKey?: AgentKey
  /** Omit where the page heading already names the list. */
  title?: string
}) {
  const { user } = useAuth()
  const { page, agentKey: chosenAgent, status, awaiting, patch } = useRunFilters()
  const agentKey = fixedAgentKey ?? chosenAgent
  const runs = useAgentRuns({ page, agentKey, status })
  const rows = runs.data?.items ?? []

  const requestedBy = (run: AgentRunListItem) =>
    run.triggerEvent ? (
      // Started by a plugin event: the event, in words, is who asked.
      <span className="text-secondary" title={`Started by the ${run.triggerEvent} event`}>
        {eventLabel(run.triggerEvent)}
      </span>
    ) : run.requestedByUserId === null ? (
      <span className="text-muted">Automatic</span>
    ) : run.requestedByUserId === user?.id ? (
      <Person name={user.name ?? 'You'} label="You" />
    ) : run.requestedBy ? (
      <Person name={run.requestedBy.name} />
    ) : (
      <span className="text-muted">A former member</span>
    )

  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      {!fixedAgentKey && (
        <>
          <label htmlFor="runs-agent" className="sr-only">
            Agent
          </label>
          <select
            id="runs-agent"
            className="select select-sm w-auto"
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
        </>
      )}
      <label htmlFor="runs-status" className="sr-only">
        Status
      </label>
      <select
        id="runs-status"
        className="select select-sm w-auto"
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
      <button
        type="button"
        className={`btn btn-sm ${awaiting ? 'btn-warning' : 'btn-outline'}`}
        aria-pressed={awaiting}
        onClick={() => patch({ awaiting: awaiting ? null : '1', status: null })}
      >
        Awaiting input
      </button>
    </div>
  )

  return (
    <SectionPanel flush title={title} actions={title ? filters : undefined}>
      {/* No title: the filters are the panel's first line, across its width. */}
      {!title && <div className="px-5 pt-4 pb-3">{filters}</div>}
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
          description={
            awaiting
              ? undefined
              : fixedAgentKey
                ? 'Run it to see it here.'
                : 'Run an agent to see it here.'
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className={`data-table ${STACK_TABLE}`} aria-label="Agent runs">
            <thead className={STACK_HEAD}>
              <tr>
                <th>{fixedAgentKey ? 'Run' : 'Agent'}</th>
                <th>Status</th>
                <th>Requested by</th>
                <th>Started</th>
                <th className="text-right">Duration</th>
              </tr>
            </thead>
            <tbody className={STACK_BODY}>
              {rows.map(run => {
                const started = run.startedAt ?? run.createdAt
                return (
                  <tr key={run.id} className={`${LINK_ROW} ${STACK_ROW}`}>
                    <td className={`font-medium ${STACK_LEAD}`}>
                      {/* A real link, so middle-click and open-in-new-tab work — half the point
                          of a run being a page. */}
                      <Link to={`/agents/runs/${run.id}`} className={`link link-hover ${ROW_LINK}`}>
                        {fixedAgentKey ? (
                          <span className="font-mono text-xs">{run.id.slice(0, 8)}</span>
                        ) : (
                          titleOf(run.agentKey)
                        )}
                      </Link>
                    </td>
                    <td className={STACK_CELL}>
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className={STACK_HIDE}>{requestedBy(run)}</td>
                    <td
                      className={`whitespace-nowrap text-secondary max-sm:text-sm ${STACK_CELL}`}
                      title={formatDateTime(started)}
                    >
                      {timeAgoShort(started)}
                    </td>
                    <td className={`text-right tabular-nums text-secondary ${STACK_HIDE}`}>
                      {runDuration(run) ?? '—'}
                    </td>
                  </tr>
                )
              })}
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

/** A requester: their initials and their name ("You" for the reader). */
function Person({ name, label }: { name: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <Avatar person={{ id: name, name }} size="sm" />
      {label ?? name}
    </span>
  )
}

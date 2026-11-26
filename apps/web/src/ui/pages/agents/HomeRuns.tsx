/**
 * Home's agents area (feature-agents' section in `pages/home-sections.ts`). Inside the area, in
 * order: the fortnight's summary in the panel header (one line: how many runs, how many
 * succeeded, against the fortnight before), a `RunsChart` stacked by outcome, the newest runs, and — when more than one agent ran —
 * each agent's own fortnight. With no runs in the window there is no chart, only a line saying so.
 *
 * Success is the quiet default: a succeeded run carries a muted check, not a badge; only a run
 * that failed, waits on someone, is in flight or was cancelled shows its status, and a failed one
 * its error. Clicking a day narrows the list to that day (one request to the runs list,
 * `since`/`until`); clicking it again clears it. With no runs at all the area offers one: "Try
 * Research a topic", started from here.
 */
import { CheckIcon, CpuChipIcon, PlayIcon, XMarkIcon } from '@heroicons/react/24/outline'
import {
  type AgentInfo,
  type AgentRunStatus,
  agentRunStatusSchema,
} from '@rocketflare/shared/ai/agents'
import type { HomeAgentLine, HomeAgents, HomeRun } from '@rocketflare/shared/home'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  Avatar,
  type ChartDay,
  ChartLegend,
  type ChartSeries,
  chartDayLabel,
  presentSeries,
  RunsChart,
  SectionPanel,
  SectionPanelSkeleton,
  SkeletonRows,
  TrendLine,
} from '@/ui/components/shared'
import { agentsQueryOptions, useAgentRuns } from '@/ui/hooks/useAgents'
import { useHomeSummary } from '@/ui/hooks/useHome'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { runDuration, timeAgoShort } from '@/ui/lib/format'
import { RunAgentModal } from './RunAgentModal'
import { RunStatusBadge } from './RunStatusBadge'

/**
 * Bottom of the stack first. Success is a calm neutral (the muted text grey), never a brand step:
 * the brand hue may sit close to the error red, and the bars that need someone — failed, in
 * progress — must be the ones the eye finds. In progress takes the info tone its badge already
 * wears; cancelled the lighter grey.
 */
export const RUN_SERIES: readonly ChartSeries[] = [
  { key: 'succeeded', label: 'succeeded', color: '--text-muted' },
  { key: 'cancelled', label: 'cancelled', color: '--border-strong' },
  { key: 'active', label: 'in progress', color: '--color-info' },
  { key: 'failed', label: 'failed', color: '--color-error' },
]

/** The agent an empty workspace is offered first. */
export const STARTER_AGENT = 'research-topic'

export function chartDays(days: HomeAgents['days']): ChartDay[] {
  return days.map(({ date, ...values }) => ({ date, values }))
}

const statusOf = (status: string): AgentRunStatus => {
  const parsed = agentRunStatusSchema.safeParse(status)
  return parsed.success ? parsed.data : 'failed'
}

const dayBounds = (date: string) => {
  const since = new Date(`${date}T00:00:00.000Z`)
  return {
    since: since.toISOString(),
    until: new Date(since.getTime() + 86_400_000).toISOString(),
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The fortnight in figures, compared with the one before. Pure. */
export function runHeadline(agents: Pick<HomeAgents, 'days' | 'previous'>) {
  const runs = agents.days.reduce((n, d) => n + d.succeeded + d.failed + d.cancelled + d.active, 0)
  const succeeded = agents.days.reduce((n, d) => n + d.succeeded, 0)
  const failed = agents.days.reduce((n, d) => n + d.failed, 0)
  const settled = runs - agents.days.reduce((n, d) => n + d.active, 0)
  const successRate = settled > 0 ? Math.round((succeeded / settled) * 100) : null
  const delta = runs - agents.previous.runs
  const span = agents.days.length
  const change =
    agents.previous.runs === 0 && runs > 0
      ? `none in the ${span} days before`
      : delta === 0
        ? `the same as the ${span} days before`
        : `${Math.abs(delta)} ${delta > 0 ? 'more' : 'fewer'} than the ${span} days before`
  return { runs, failed, successRate, delta, change }
}

/** "21 runs in 14 days · 81% succeeded · 3 failed · 4 more than the 14 days before". Pure. */
export function runSummary(headline: ReturnType<typeof runHeadline>, span: number): string {
  return [
    `${plural(headline.runs, 'run')} in ${span} days`,
    headline.successRate === null ? null : `${headline.successRate}% succeeded`,
    headline.failed > 0 ? `${headline.failed} failed` : null,
    headline.change,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** "Olivia · 52s · 1.2k tokens · $0.004": what a settled run took. Pure. */
export function runMeta(run: HomeRun): string {
  const parts = [
    run.requestedBy?.name.split(/\s+/)[0] ?? null,
    runDuration(run),
    run.tokens === null
      ? null
      : run.tokens >= 1000
        ? `${(run.tokens / 1000).toFixed(1)}k tokens`
        : `${run.tokens} tokens`,
    run.costUsd === null || run.costUsd === 0
      ? null
      : run.costUsd < 0.01
        ? `$${run.costUsd.toFixed(3)}`
        : `$${run.costUsd.toFixed(2)}`,
  ]
  return parts.filter(Boolean).join(' · ')
}

export default function HomeRuns() {
  const { data, isLoading } = useHomeSummary()
  const [day, setDay] = useState<string | null>(null)
  if (isLoading) return <SectionPanelSkeleton rows={4} />
  const agents = data?.agents
  if (!agents) return null

  const headline = runHeadline(agents)
  if (headline.runs === 0 && agents.recent.length === 0) return <StartFirstRun />
  const days = chartDays(agents.days)

  return (
    <SectionPanel
      title="Agent runs"
      description={headline.runs > 0 ? runSummary(headline, agents.days.length) : undefined}
      actions={
        <div className="flex items-center gap-3">
          {headline.runs > 0 && (
            <ChartLegend series={presentSeries(days, RUN_SERIES)} className="hidden sm:flex" />
          )}
          <Link to="/agents/runs" className="btn btn-ghost btn-xs">
            All runs
          </Link>
        </div>
      }
    >
      {headline.runs > 0 ? (
        <div className="mb-5">
          <RunsChart
            days={days}
            series={RUN_SERIES}
            noun="runs"
            selected={day}
            onSelectDay={setDay}
            heightClass="h-24"
            legend={false}
          />
          <ChartLegend series={presentSeries(days, RUN_SERIES)} className="sm:hidden mt-2 ml-7" />
        </div>
      ) : (
        <p className="text-sm text-muted mb-3">
          No runs in the last {agents.days.length} days. The latest are below.
        </p>
      )}
      {day ? (
        <DayRuns day={day} titles={agents.recent} onClear={() => setDay(null)} />
      ) : (
        <RunList runs={agents.recent} />
      )}
      {agents.byAgent.length > 1 && <ByAgent lines={agents.byAgent} />}
    </SectionPanel>
  )
}

function DayRuns({
  day,
  titles,
  onClear,
}: {
  day: string
  titles: readonly HomeRun[]
  onClear: () => void
}) {
  const runs = useAgentRuns({ ...dayBounds(day), pageSize: 6 })
  const registry = useQuery(agentsQueryOptions())
  const titleOf = (key: string) =>
    registry.data?.items.find(a => a.key === key)?.title ??
    titles.find(r => r.agentKey === key)?.agentTitle ??
    key
  const items: HomeRun[] = (runs.data?.items ?? []).map(run => ({
    id: run.id,
    agentKey: run.agentKey,
    agentTitle: titleOf(run.agentKey),
    subject: null,
    status: run.status,
    error: run.error,
    requestedBy: null,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    tokens: null,
    costUsd: null,
  }))
  const total = runs.data?.pagination.total ?? 0
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="text-sm font-medium">
          {chartDayLabel(day)}
          {runs.data && <span className="text-muted font-normal"> · {plural(total, 'run')}</span>}
        </p>
        <button type="button" className="btn btn-ghost btn-xs gap-1" onClick={onClear}>
          <XMarkIcon className="w-3.5 h-3.5" />
          Show latest
        </button>
      </div>
      {runs.isLoading ? (
        <SkeletonRows rows={3} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted py-2">No runs that day.</p>
      ) : (
        <RunList runs={items} />
      )}
    </div>
  )
}

export function RunList({ runs }: { runs: readonly HomeRun[] }) {
  return (
    <ul className="divide-y divide-[color:var(--border-subtle)] -my-1">
      {runs.map(run => (
        <li key={run.id}>
          <RunRow run={run} />
        </li>
      ))}
    </ul>
  )
}

function RunRow({ run }: { run: HomeRun }) {
  const status = statusOf(run.status)
  const meta = runMeta(run)
  return (
    <Link
      to={`/agents/runs/${run.id}`}
      className="flex items-center gap-3 py-2.5 -mx-2 px-2 rounded-[var(--radius-control)] hover:bg-[color:var(--surface-hover)]"
    >
      {run.requestedBy ? (
        <Avatar
          size="sm"
          person={{ id: run.id, name: run.requestedBy.name, avatarUrl: run.requestedBy.avatarUrl }}
        />
      ) : (
        <span
          className="w-7 h-7 rounded-full inline-flex items-center justify-center shrink-0 bg-[color:var(--surface-inset)] text-muted"
          aria-hidden
        >
          <CpuChipIcon className="w-4 h-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        {/* `line-clamp-*` sets its own display: no `block` beside it, or the clamp is lost. */}
        <span className="text-sm line-clamp-2 sm:line-clamp-1 break-words">
          <span className="font-medium">{run.agentTitle}</span>
          {run.subject && <span className="text-secondary"> · {run.subject}</span>}
        </span>
        {/* Narrow: the status and the time join the meta line, so the title keeps the row's
            width, and a failure's reason takes a line of its own. */}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 text-xs">
          {status !== 'succeeded' && (
            <span className="sm:hidden shrink-0">
              <RunStatusBadge status={status} />
            </span>
          )}
          {status === 'failed' && run.error ? (
            <span
              className="text-error min-w-0 basis-full sm:basis-auto order-last sm:order-none line-clamp-2 sm:line-clamp-1 break-words"
              title={run.error}
            >
              {run.error}
            </span>
          ) : (
            meta && <span className="text-muted truncate min-w-0">{meta}</span>
          )}
          <RunTime at={run.createdAt} className="sm:hidden" />
        </span>
      </span>
      {status === 'succeeded' ? (
        <span role="img" aria-label="Succeeded" className="shrink-0 text-muted">
          <CheckIcon className="w-4 h-4" />
        </span>
      ) : (
        <span className="hidden sm:inline-flex shrink-0">
          <RunStatusBadge status={status} />
        </span>
      )}
      <RunTime at={run.createdAt} className="hidden sm:block w-14 text-right shrink-0" />
    </Link>
  )
}

function RunTime({ at, className }: { at: Date; className: string }) {
  return (
    <time
      dateTime={at.toISOString()}
      title={at.toLocaleString()}
      className={`text-xs text-muted whitespace-nowrap tabular-nums ${className}`}
    >
      {timeAgoShort(at)}
    </time>
  )
}

/** Each agent's fortnight, busiest first: its count beside its own line, and when it last ran. */
function ByAgent({ lines }: { lines: readonly HomeAgentLine[] }) {
  return (
    <div className="mt-5 pt-4 border-t border-[color:var(--border-subtle)]">
      <h3 className="text-sm font-medium mb-2">By agent</h3>
      <ul className="grid gap-2">
        {lines.map(line => (
          <li key={line.agentKey} className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate">{line.agentTitle}</span>
            <span className="tabular-nums text-secondary whitespace-nowrap">
              {plural(line.runs, 'run')}
              {line.failed > 0 && <span className="text-error"> · {line.failed} failed</span>}
            </span>
            <TrendLine
              values={line.daily}
              label={`${line.agentTitle}: runs per day over the last ${line.daily.length} days`}
              className="hidden sm:block"
            />
            <time
              dateTime={line.lastRunAt.toISOString()}
              className="text-xs text-muted whitespace-nowrap tabular-nums w-14 text-right shrink-0"
            >
              {timeAgoShort(line.lastRunAt)}
            </time>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The empty area is the onboarding: one agent worth trying, started from here. */
function StartFirstRun() {
  const { can } = usePermissions()
  const navigate = useNavigate()
  const registry = useQuery(agentsQueryOptions())
  const [running, setRunning] = useState<AgentInfo | null>(null)
  const items = registry.data?.items ?? []
  const starter = items.find(a => a.key === STARTER_AGENT) ?? items[0]
  const canRun = can('create', 'AgentRun')

  return (
    <SectionPanel title="Agent runs">
      <div className="flex flex-wrap items-center gap-4">
        <CpuChipIcon className="w-6 h-6 text-muted shrink-0" />
        <div className="flex-1 min-w-[14rem]">
          {starter ? (
            <>
              <p className="text-sm">
                No runs yet. Try <em className="font-medium not-italic">{starter.title}</em>
              </p>
              <p className="text-sm text-secondary max-w-prose">{starter.description}</p>
            </>
          ) : (
            <p className="text-sm text-secondary">
              No runs yet. Agents work through longer tasks while you get on with yours.
            </p>
          )}
        </div>
        {starter && canRun && (
          <button
            type="button"
            className="btn btn-primary btn-sm gap-1.5"
            onClick={() => setRunning(starter)}
          >
            <PlayIcon className="w-4 h-4" />
            {starter.title}
          </button>
        )}
      </div>
      <RunAgentModal
        agent={running}
        onClose={() => setRunning(null)}
        onStarted={run => {
          setRunning(null)
          navigate(`/agents/runs/${run.id}`)
        }}
      />
    </SectionPanel>
  )
}

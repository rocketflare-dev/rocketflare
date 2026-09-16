/**
 * `/agents/runs/:runId` — a run as a PAGE (issue #17), not a modal over a list.
 *
 * A modal is the wrong home for something a person is asked to *act* on, arrives at from a
 * notification, may need to read a document before deciding, and may leave and come back to. So:
 * its own route, its own URL, a breadcrumb, no `role="dialog"`, and nothing that closes on Escape.
 *
 * The layout says what the page is for. The **action panel is above the timeline**, full width and
 * sticky, because somebody arriving from a notification is here to decide, not to read; then the
 * **input**, because "what was it asked?" is the first question anybody has about a run they did
 * not start; below them the timeline and the answer sit side by side. Under `lg` they stack **tabs
 * first, timeline second** — on a phone the answer is what people came for. `run.error` renders
 * above the tab bar, always: **a failure is not a tab.**
 *
 * **The split follows the run's state, until the reader says otherwise** (`runLayout`, pure): while
 * it is working the timeline is the major column and the output pane is an empty state; once it
 * settles the answer is what they came for. An override wins permanently, because a run settling
 * mid-read must not swap the columns under somebody.
 *
 * **Built against the poll path.** `GET /runs/:id` is the whole data source — the row, its durable
 * events, its asks and its artifacts — refreshed by the `agent-run` nudge and polled while the
 * server still owes an answer. `useRunStream` is layered on top purely for CADENCE: when it reports
 * a `seq` the page has not seen, the page re-reads the run, so the timeline fills in ~500 ms
 * instead of 3 s lumps. Delete the hook and the page still works, which is the property phase 6 was
 * built to preserve.
 *
 * Everything the right pane shows that is not `run.output` is a selector over the same rows, never
 * a second fetch.
 */
import { ArrowsRightLeftIcon, CpuChipIcon } from '@heroicons/react/24/outline'
import type { AgentInfo, AgentRunWithEvents } from '@rocketflare/shared/ai/agents'
import { isRunActive } from '@rocketflare/shared/ai/agents'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EmptyState, PageHeader, SectionPanel, SkeletonRows, URLTabs } from '@/ui/components/shared'
import { useAgentList, useAgentRun } from '@/ui/hooks/useAgents'
import { useAuth } from '@/ui/hooks/useAuth'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { streamEnabled, useRunStream } from '@/ui/hooks/useRunStream'
import { outputFor } from './outputs'
import { RunStatusBadge } from './RunStatusBadge'
import { ActionRequiredPanel } from './run/ActionRequiredPanel'
import { RunArtifactsTab } from './run/output/RunArtifactsTab'
import { RunOutputTab } from './run/output/RunOutputTab'
import { RunUsageTab } from './run/output/RunUsageTab'
import { RunErrorAlert } from './run/RunErrorAlert'
import { RunHeader } from './run/RunHeader'
import { RunInputSummary } from './run/RunInputSummary'
import { SteerComposer } from './run/SteerComposer'
import { RunTimeline } from './run/timeline/RunTimeline'
import {
  buildTimeline,
  type RunLayoutSplit,
  runLayout,
  selectArtifacts,
  selectPendingInterrupts,
  selectWorkStats,
} from './run/timeline/timelineModel'

/** The two splits as grid templates. Timeline left, output right, in both — only the share moves. */
const LAYOUT_COLUMNS: Record<RunLayoutSplit, string> = {
  'timeline-major': 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]',
  'output-major': 'lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]',
}

export default function RunPage() {
  const { runId } = useParams<{ runId: string }>()
  const run = useAgentRun(runId)
  const agents = useAgentList()
  const agent = agents.data?.items.find(item => item.key === run.data?.agentKey)
  const title = agent?.title ?? run.data?.agentKey ?? 'Run'

  return (
    <div className="max-w-7xl">
      <PageHeader
        breadcrumbs={[{ label: 'Agents', to: '/agents' }, { label: title }]}
        title={title}
        badge={run.data && <RunStatusBadge status={run.data.status} />}
      />
      {run.isLoading ? (
        <SkeletonRows rows={5} />
      ) : run.isError || !run.data ? (
        <EmptyState
          icon={CpuChipIcon}
          message="This run could not be loaded"
          description="It may belong to someone else, or no longer exist."
          action={
            <Link to="/agents" className="btn btn-sm">
              Back to agents
            </Link>
          }
        />
      ) : (
        <RunWorkspace run={run.data} agent={agent} />
      )}
    </div>
  )
}

function RunWorkspace({ run, agent }: { run: AgentRunWithEvents; agent?: AgentInfo }) {
  const approvers = agent?.approvers ?? 'requester'
  const { user } = useAuth()
  const { isAdminLevel } = usePermissions()
  const live = useLiveRun(run)
  const [layoutOverride, setLayoutOverride] = useState<RunLayoutSplit | null>(null)
  const layout = runLayout(run.status, layoutOverride)

  const rows = useMemo(() => buildTimeline(run.events), [run.events])
  const pending = useMemo(() => selectPendingInterrupts(run.interrupts), [run.interrupts])
  const stats = useMemo(() => selectWorkStats(rows), [rows])
  const artifacts = useMemo(() => {
    const stored = selectArtifacts(rows, run.artifacts)
    if (stored.length > 0) return stored
    // The fallback for an agent that declares none: derive them from the output it already returns.
    const entry = outputFor(run.agentKey)
    const parsed = entry?.schema.safeParse(run.output)
    return parsed?.success && entry?.artifacts ? entry.artifacts(parsed.data, run.id) : []
  }, [rows, run.artifacts, run.agentKey, run.output, run.id])

  const requestedBy =
    run.requestedByUserId === null
      ? 'system'
      : run.requestedByUserId === user?.id
        ? 'you'
        : run.requestedByUserId.slice(0, 8)

  // The agent's approver policy, mirrored client-side so the panel can explain itself. The SERVER
  // decides — a member under `approvers: 'admin'` gets a 403 either way — this only chooses between
  // showing the form and showing one sentence.
  const canAnswer = approvers === 'admin' ? isAdminLevel() : true

  const tabs = [
    {
      id: 'output',
      label: 'Output',
      content: (
        <RunOutputTab
          agentKey={run.agentKey}
          runId={run.id}
          output={run.output}
          pending={isRunActive(run.status)}
        />
      ),
    },
    {
      id: 'artifacts',
      label: 'Artifacts',
      ...(artifacts.length > 0 ? { badge: artifacts.length } : {}),
      content: <RunArtifactsTab artifacts={artifacts} />,
    },
    {
      id: 'usage',
      label: 'Usage',
      content: <RunUsageTab run={run} stats={stats} requestedBy={requestedBy} />,
    },
  ]

  return (
    <div className="space-y-4">
      {/* Above the fold and above the timeline: the decision comes first. */}
      {run.status === 'awaiting_input' && pending[0] && (
        <div className="sticky top-0 z-20 pb-1 bg-[color:var(--surface-page,transparent)]">
          <ActionRequiredPanel
            runId={run.id}
            interrupt={pending[0]}
            canAnswer={canAnswer}
            approverLabel="an administrator"
          />
        </div>
      )}

      <RunHeader run={run} live={live} />

      <RunInputSummary input={run.input} schema={agent?.inputJsonSchema ?? null} />

      {/* Tabs first under `lg`: on a phone the answer is what people came for. */}
      <div
        className={`grid grid-cols-1 ${LAYOUT_COLUMNS[layout]} gap-4 items-start`}
        data-layout={layout}
      >
        <SectionPanel
          title="Timeline"
          className="order-2 lg:order-1"
          actions={
            <button
              type="button"
              className="btn btn-ghost btn-xs gap-1 hidden lg:inline-flex"
              aria-pressed={layoutOverride !== null}
              onClick={() =>
                setLayoutOverride(layout === 'timeline-major' ? 'output-major' : 'timeline-major')
              }
            >
              <ArrowsRightLeftIcon className="w-3.5 h-3.5" aria-hidden="true" />
              {layout === 'timeline-major' ? 'Widen output' : 'Widen timeline'}
            </button>
          }
        >
          <RunTimeline events={run.events} />
          {isRunActive(run.status) && <SteerComposer runId={run.id} />}
        </SectionPanel>
        <div className="order-1 lg:order-2 space-y-3 min-w-0">
          {run.error && <RunErrorAlert error={run.error} />}
          <URLTabs tabs={tabs} defaultTab="output" />
        </div>
      </div>
    </div>
  )
}

/**
 * The stream as a CADENCE upgrade over the poll, and nothing else.
 *
 * `useRunStream` owns `['agent-run-agui', id]` and never touches the run row — that rule is phase
 * 6's and it stays. Here we read only its cursor: when the server has written a `seq` this page has
 * not rendered, re-read the run. That keeps ONE representation of the log (the durable rows) rather
 * than a second, lossy one reconstructed from AG-UI, and an idle run makes no requests at all where
 * the poll made twenty a minute.
 *
 * The re-read is bursty by nature, which is why the SERVER holds the other half of the bargain:
 * `GET /runs/:id` hands `reconcileRun` the newest event's timestamp, so a run that is actively
 * writing rows costs no Workflow subrequest to re-read. Coalescing here is one fetch in flight at a
 * time and nothing more — a debounce would spend exactly the latency phase 6 was built to buy.
 *
 * Deleting this hook leaves `useAgentRun`'s own `refetchInterval`, which is a working page.
 */
function useLiveRun(run: AgentRunWithEvents): boolean {
  const stream = useRunStream(run.id, { enabled: streamEnabled(run.status) })
  const seenSeq = run.events.at(-1)?.seq ?? 0
  const refetch = useAgentRun(run.id).refetch
  const inFlight = useRef(false)

  useEffect(() => {
    if (stream.lastSeq <= seenSeq || inFlight.current) return
    inFlight.current = true
    void refetch().finally(() => {
      inFlight.current = false
    })
  }, [stream.lastSeq, seenSeq, refetch])

  return stream.connected
}

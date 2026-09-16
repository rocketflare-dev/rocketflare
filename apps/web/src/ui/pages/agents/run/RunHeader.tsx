/**
 * The run's identity line: which agent, what state, how long, and the one destructive control.
 *
 * Cancel stays CLICKABLE once a cancel has been asked for — the second press forces it (the server
 * terminates the Workflow instance and settles the row), so a run whose loop stopped polling can
 * never strand somebody on "Cancelling…" or hold an exclusive agent's only slot forever.
 */
import type { AgentRun } from '@rocketflare/shared/ai/agents'
import { isRunActive } from '@rocketflare/shared/ai/agents'
import { useCancelAgentRun } from '@/ui/hooks/useAgents'
import { formatDateTime, formatDuration, runDuration } from '@/ui/lib/format'

export function RunHeader({
  run,
  requestedBy,
  live,
}: {
  run: AgentRun
  requestedBy: string
  /** A connection is open: the timeline is filling as it happens rather than on a timer. */
  live: boolean
}) {
  const cancel = useCancelAgentRun()
  const active = isRunActive(run.status)
  const elapsed =
    runDuration(run) ??
    (run.startedAt ? formatDuration(Date.now() - run.startedAt.getTime()) : null)

  return (
    <section className="flex flex-wrap items-start justify-between gap-4" aria-label="Run summary">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-xs flex-1 min-w-0">
        <dt className="text-muted">Requested</dt>
        <dd className="truncate">
          {formatDateTime(run.createdAt)} <span className="text-muted">by {requestedBy}</span>
        </dd>
        <dt className="text-muted">Started</dt>
        <dd>{formatDateTime(run.startedAt)}</dd>
        <dt className="text-muted">Finished</dt>
        <dd>{formatDateTime(run.finishedAt)}</dd>
        <dt className="text-muted">Duration</dt>
        <dd className="tabular-nums">
          {elapsed ?? '—'}
          <span className="text-muted"> · attempt {run.attempt}</span>
        </dd>
      </dl>
      <div className="flex items-center gap-2 shrink-0">
        {live && (
          <span className="text-xs text-muted inline-flex items-center gap-1.5" role="status">
            <span className="w-1.5 h-1.5 rounded-full bg-success" aria-hidden="true" />
            Live
          </span>
        )}
        {active && (
          <button
            type="button"
            className="btn btn-sm btn-outline btn-error"
            onClick={() => cancel.mutate(run.id)}
            disabled={cancel.isPending}
            title={
              run.cancelRequestedAt
                ? 'Cancellation was requested but the run has not stopped — force it to stop now'
                : undefined
            }
          >
            {run.cancelRequestedAt ? 'Force cancel' : 'Cancel run'}
          </button>
        )}
      </div>
    </section>
  )
}

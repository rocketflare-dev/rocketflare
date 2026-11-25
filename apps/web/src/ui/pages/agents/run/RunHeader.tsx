/**
 * The run's identity line: how long it has been going, whether it is live, and the one destructive
 * control. The status badge is the page header's, beside the title.
 *
 * **Duration is the only figure here.** Requested / Started / Finished were three more rows of
 * chrome above the fold, read once in a hundred visits and never glanced at; they now sit in the
 * Usage tab with everything else the rows know about this run. Elapsed time is the one a person
 * actually watches, so it stays where they are already looking. A run that waited for a person
 * says so apart — "Ran 12s · Waited 18h 2m" — because a wall clock that includes a night parked on
 * a question reads as a slow agent.
 *
 * Cancel stays CLICKABLE once a cancel has been asked for — the second press forces it (the server
 * terminates the Workflow instance and settles the row), so a run whose loop stopped polling can
 * never strand somebody on "Cancelling…" or hold an exclusive agent's only slot forever.
 */
import type { AgentRun } from '@rocketflare/shared/ai/agents'
import { isRunActive } from '@rocketflare/shared/ai/agents'
import { useCancelAgentRun } from '@/ui/hooks/useAgents'
import { formatDuration } from '@/ui/lib/format'

export function RunHeader({
  run,
  live,
  waitedMs = 0,
}: {
  run: AgentRun
  /** A connection is open: the timeline is filling as it happens rather than on a timer. */
  live: boolean
  /** Time parked awaiting input (`runWaitMs`); shown apart from the time the agent worked. */
  waitedMs?: number
}) {
  const cancel = useCancelAgentRun()
  const active = isRunActive(run.status)
  const elapsedMs = run.startedAt
    ? (run.finishedAt ?? new Date()).getTime() - run.startedAt.getTime()
    : null
  // Under a second of waiting is the window between an answer and its resume, not a wait.
  const waited = elapsedMs !== null && waitedMs >= 1000

  return (
    <section className="flex flex-wrap items-start justify-between gap-4" aria-label="Run summary">
      <dl className="flex items-baseline gap-2 text-xs flex-1 min-w-0">
        <dt className="text-muted">{waited ? 'Ran' : 'Duration'}</dt>
        <dd className="tabular-nums">
          {elapsedMs === null ? '—' : formatDuration(waited ? elapsedMs - waitedMs : elapsedMs)}
          {waited && (
            <>
              <span className="text-muted"> · Waited </span>
              {formatDuration(waitedMs)}
            </>
          )}
          {/* Only a restarted run names its attempt: "attempt 1" beside an error that speaks of
              the model provider's own retries reads as a contradiction. */}
          {run.attempt > 1 && (
            <span className="text-muted" title="The run was restarted after an interruption">
              {' '}
              · attempt {run.attempt}
            </span>
          )}
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

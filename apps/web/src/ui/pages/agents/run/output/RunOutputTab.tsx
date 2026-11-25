/**
 * What the run produced, typed by `outputs/` — a registry, never hard-coded
 * `agentKey === '…'` branches in this panel. An agent with no entry, or one
 * whose output no longer matches its schema, falls through to the raw JSON, which is a real answer
 * rather than an apology.
 */
import { CpuChipIcon, EllipsisHorizontalIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { FeedbackThumbs } from '@/ui/components/ai/FeedbackThumbs'
import { EmptyStateCard } from '@/ui/components/shared'
import { useMyFeedback } from '@/ui/hooks/useFeedback'
import { outputFor } from '../../outputs'
import { pretty, truncate } from '../timeline/toolResults'

export function RunOutputTab({
  agentKey,
  runId,
  output,
  pending,
  settledAs,
}: {
  agentKey: string
  runId: string
  output: unknown
  /** The run has not produced one yet — a different sentence from "it produced nothing". */
  pending: boolean
  /** How a run with no output ended, so the empty pane can say why. */
  settledAs?: 'failed' | 'cancelled'
}) {
  const [raw, setRaw] = useState(false)
  const hasOutput = output !== null && output !== undefined
  // The run's output is an answer like any chat reply, and a thumbs-down here is a candidate
  // for `rocketflare evals promote`.
  const { data: myVotes } = useMyFeedback('agent_run', hasOutput ? [runId] : [])
  if (output === null || output === undefined) {
    return (
      <EmptyStateCard
        icon={CpuChipIcon}
        size="sm"
        message={
          pending
            ? 'No answer yet'
            : settledAs === 'failed'
              ? 'No answer: the run failed'
              : settledAs === 'cancelled'
                ? 'No answer: the run was cancelled'
                : 'This run produced no output'
        }
        description={
          pending
            ? 'The answer appears here the moment the run finishes.'
            : settledAs === 'failed'
              ? 'Why it failed is above.'
              : undefined
        }
      />
    )
  }

  const entry = outputFor(agentKey)
  const parsed = entry?.schema.safeParse(output)

  return (
    <section className="surface-panel space-y-3" aria-label="Output">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs text-muted">
          Was this useful?
          <FeedbackThumbs target="agent_run" targetId={runId} rating={myVotes?.get(runId)} />
        </span>
        {parsed?.success && (
          // A quiet menu, not a peer button beside the answer: the JSON is for whoever debugs it.
          <details className="dropdown dropdown-end">
            <summary
              className="btn btn-ghost btn-sm btn-square list-none"
              aria-label="More output options"
              title="More"
            >
              <EllipsisHorizontalIcon className="w-5 h-5" aria-hidden="true" />
            </summary>
            <ul className="dropdown-content menu popover-surface z-20 mt-1 w-48 p-1 text-sm">
              <li>
                <button
                  type="button"
                  aria-pressed={raw}
                  onClick={e => {
                    setRaw(value => !value)
                    e.currentTarget.closest('details')?.removeAttribute('open')
                  }}
                >
                  {raw ? 'Show formatted' : 'Show raw JSON'}
                </button>
              </li>
            </ul>
          </details>
        )}
      </div>
      {parsed?.success && !raw && entry ? (
        <entry.Component output={parsed.data} runId={runId} />
      ) : (
        <pre className="surface-inset p-3 text-xs whitespace-pre-wrap break-words max-h-[32rem] overflow-auto">
          {truncate(pretty(output), 20_000)}
        </pre>
      )}
    </section>
  )
}

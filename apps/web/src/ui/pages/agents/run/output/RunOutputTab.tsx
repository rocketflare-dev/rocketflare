/**
 * What the run produced, typed by `outputs/` (issue #17) — the registry that replaced the two
 * hard-coded `agentKey === '…'` branches this panel used to carry. An agent with no entry, or one
 * whose output no longer matches its schema, falls through to the raw JSON, which is a real answer
 * rather than an apology.
 */
import { CpuChipIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { FeedbackThumbs } from '@/ui/components/ai/FeedbackThumbs'
import { EmptyState } from '@/ui/components/shared'
import { useMyFeedback } from '@/ui/hooks/useFeedback'
import { outputFor } from '../../outputs'
import { pretty, truncate } from '../timeline/toolResults'

export function RunOutputTab({
  agentKey,
  runId,
  output,
  pending,
}: {
  agentKey: string
  runId: string
  output: unknown
  /** The run has not produced one yet — a different sentence from "it produced nothing". */
  pending: boolean
}) {
  const [raw, setRaw] = useState(false)
  const hasOutput = output !== null && output !== undefined
  // D33: the run's output is an answer like any chat reply, and a thumbs-down here is a candidate
  // for `rocketflare evals promote`.
  const { data: myVotes } = useMyFeedback('agent_run', hasOutput ? [runId] : [])
  if (output === null || output === undefined) {
    return (
      <EmptyState
        icon={CpuChipIcon}
        size="sm"
        message={pending ? 'No answer yet' : 'This run produced no output'}
        description={pending ? 'The answer appears here the moment the run finishes.' : undefined}
      />
    )
  }

  const entry = outputFor(agentKey)
  const parsed = entry?.schema.safeParse(output)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs text-muted">
          Was this useful?
          <FeedbackThumbs target="agent_run" targetId={runId} rating={myVotes?.get(runId)} />
        </span>
        {parsed?.success && (
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            aria-pressed={raw}
            onClick={() => setRaw(value => !value)}
          >
            {raw ? 'Formatted' : 'Raw JSON'}
          </button>
        )}
      </div>
      {parsed?.success && !raw && entry ? (
        <entry.Component output={parsed.data} runId={runId} />
      ) : (
        <pre className="surface-inset rounded-lg p-3 text-xs whitespace-pre-wrap break-words max-h-[32rem] overflow-auto">
          {truncate(pretty(output), 20_000)}
        </pre>
      )}
    </div>
  )
}

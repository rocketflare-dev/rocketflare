/**
 * Run status as the kit's `.status-badge` (D7, issue #17): the tone comes from `data-status` in
 * `index.css` (`queued`/`running` info, `succeeded` success, `failed`/`cancelled` error,
 * `awaiting_input` the existing warning tone — parked is neither progress nor failure). Tokens
 * only, never a palette class.
 *
 * **Only a run the SERVER still owes an answer pulses and announces itself.** `isRunActive` now
 * includes `awaiting_input`, and a badge keyed off it would pulse and `aria-live` a parked run for
 * the whole `AGENT_INTERRUPT_TIMEOUT` — days of motion and screen-reader chatter about a thing
 * that is, precisely, not moving. `runOwesAnswer` is the predicate for "in flight".
 *
 * `STATUS_LABELS` is exported because the runs table's status filter renders the same words, and a
 * single `Record<AgentRunStatus, string>` is what makes the compiler name every place a new status
 * has to be spelled.
 */
import { PauseCircleIcon } from '@heroicons/react/24/outline'
import type { AgentRunStatus } from '@rocketflare/shared/ai/agents'
import { runOwesAnswer } from '@/ui/hooks/useAgents'

export const STATUS_LABELS: Record<AgentRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  awaiting_input: 'Awaiting input',
}

/** `succeeded` shares the success tone `completed` already has in the stylesheet. */
const TONE: Record<AgentRunStatus, string> = {
  queued: 'queued',
  running: 'running',
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  // The stylesheet's existing warning tone: parked is neither progress nor failure.
  awaiting_input: 'awaiting-review',
}

export function RunStatusBadge({ status }: { status: AgentRunStatus }) {
  const live = runOwesAnswer(status)
  const parked = status === 'awaiting_input'
  return (
    <span
      className={`status-badge ${live ? 'animate-pulse' : ''} ${parked ? 'gap-1' : ''}`}
      data-status={TONE[status]}
      data-run-status={status}
      aria-live={live ? 'polite' : undefined}
    >
      {parked && <PauseCircleIcon className="w-3.5 h-3.5" aria-hidden="true" />}
      {STATUS_LABELS[status]}
    </span>
  )
}

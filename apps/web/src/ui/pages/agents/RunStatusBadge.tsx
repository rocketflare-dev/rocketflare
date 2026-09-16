/**
 * Run status as the kit's `.status-badge` (D7): the tone comes from `data-status` in `index.css`
 * (`queued`/`running` info, `succeeded` success, `failed`/`cancelled` error) and an ACTIVE run
 * pulses its dot so a live row reads as live at a glance. Tokens only — never a palette class.
 */
import { type AgentRunStatus, isRunActive } from '@rocketflare/shared/ai/agents'

const LABELS: Record<AgentRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  awaiting_input: 'Waiting for you',
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
  const active = isRunActive(status)
  return (
    <span
      className={`status-badge ${active ? 'animate-pulse' : ''}`}
      data-status={TONE[status]}
      data-run-status={status}
      aria-live={active ? 'polite' : undefined}
    >
      {LABELS[status]}
    </span>
  )
}

/**
 * One stage of a run, and everything that happened inside it. Collapsed it reads
 * `✓ Searching knowledge · 1.4s · 3 tools`; expanded it is the rows themselves.
 *
 * Expansion is `defaultExpanded` XOR a local set of the reader's own toggles (owned by
 * `RunTimeline`), so a new event never yanks open a group somebody deliberately closed — and never
 * closes one they opened.
 */
import {
  CheckCircleIcon,
  ChevronRightIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/24/outline'
import { formatDuration } from '@/ui/lib/format'
import { TimelineRow } from './TimelineRow'
import { type TimelineGroup as Group, PREAMBLE_KEY, TAIL_KEY } from './timelineModel'

const time = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function TimelineGroup({
  group,
  expanded,
  onToggle,
}: {
  group: Group
  expanded: boolean
  onToggle: () => void
}) {
  const rows = (
    <div className="space-y-2 pl-6 border-l border-[color:var(--border-subtle)] ml-2">
      {group.rows.map(row => (
        <TimelineRow key={row.id} row={row} />
      ))}
    </div>
  )

  // The synthetic stretches have no stage to name, so they are never a header — they are simply
  // the rows that happened before the first stage or after the last one.
  if (group.step === null) {
    return (
      <li
        className="space-y-2"
        data-group-key={group.key}
        data-group-kind={group.key === PREAMBLE_KEY ? 'preamble' : TAIL_KEY.slice(2, -2)}
      >
        <div className="space-y-2">
          {group.rows.map(row => (
            <TimelineRow key={row.id} row={row} />
          ))}
        </div>
      </li>
    )
  }

  return (
    <li className="space-y-2" data-group-key={group.key}>
      <button
        type="button"
        className="flex w-full items-start gap-2.5 text-left text-sm"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <GroupIcon status={group.status} />
        <span className="min-w-0 flex-1">
          <span className={group.status === 'done' ? 'font-medium text-secondary' : 'font-medium'}>
            {group.step.label}
          </span>
          {group.step.detail && <span className="text-muted"> · {group.step.detail}</span>}
          {group.durationMs !== undefined && (
            <span className="text-muted tabular-nums"> · {formatDuration(group.durationMs)}</span>
          )}
          {!expanded && group.toolCount > 0 && (
            <span className="text-muted">
              {' '}
              · {group.toolCount} tool{group.toolCount === 1 ? '' : 's'}
            </span>
          )}
        </span>
        <time
          className="text-xs text-muted tabular-nums shrink-0"
          dateTime={group.at.toISOString()}
        >
          {time(group.at)}
        </time>
        <ChevronRightIcon
          className={`w-4 h-4 mt-0.5 shrink-0 text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
      </button>
      {expanded && group.rows.length > 0 && rows}
    </li>
  )
}

function GroupIcon({ status }: { status: Group['status'] }) {
  if (status === 'done') return <CheckCircleIcon className="w-4 h-4 mt-0.5 shrink-0 text-success" />
  if (status === 'error')
    return <ExclamationCircleIcon className="w-4 h-4 mt-0.5 shrink-0 text-error" />
  return <span className="loading loading-spinner loading-xs mt-0.5 shrink-0 text-primary" />
}

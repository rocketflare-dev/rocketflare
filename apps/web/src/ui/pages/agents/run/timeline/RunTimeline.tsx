/**
 * A run's durable event stream, grouped by stage (issue #17).
 *
 * Everything decided here is decided in `timelineModel.ts`, which is pure; this file is scrolling,
 * expansion and keys. Three behaviours worth knowing:
 *
 * - **Window, do not virtualise.** Row heights vary wildly (markdown, card strips, `<pre>`), so a
 *   virtualiser needs measurement, and measurement fights both auto-scroll and collapsing. The last
 *   `TIMELINE_WINDOW_GROUPS` stages render; the rest are one "Show earlier activity" button.
 * - **Auto-scroll only when the reader is at the bottom AND a new row arrived** — never on a height
 *   change, which is what expanding an old group is.
 * - **Expansion is the default XOR the reader's toggles**, keyed by `headerId`, so a live run never
 *   reopens something somebody closed.
 */
import { ArrowDownIcon, CpuChipIcon } from '@heroicons/react/24/outline'
import { useMemo, useState } from 'react'
import { EmptyState } from '@/ui/components/shared'
import { TimelineGroup } from './TimelineGroup'
import {
  buildTimeline,
  defaultExpanded,
  groupTimeline,
  type TimelineEvent,
  windowGroups,
} from './timelineModel'
import { useStickToBottom } from './useStickToBottom'

export function RunTimeline({
  events,
  className = '',
}: {
  events: readonly TimelineEvent[]
  className?: string
}) {
  const [toggled, setToggled] = useState<Set<string>>(() => new Set())
  const [showAll, setShowAll] = useState(false)

  const rows = useMemo(() => buildTimeline(events), [events])
  const groups = useMemo(() => groupTimeline(rows), [rows])
  const expandedByDefault = useMemo(() => defaultExpanded(groups), [groups])
  const { visible, hiddenGroups, hiddenRows } = useMemo(
    () => windowGroups(groups, showAll),
    [groups, showAll]
  )

  const lastRow = rows.at(-1)
  const { sentinelRef, atBottom, unseen, scrollToBottom } = useStickToBottom(
    lastRow?.id,
    rows.length
  )

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={CpuChipIcon}
        size="sm"
        className={className}
        message="No progress reported yet"
        description="The run posts a row for every stage, tool call and reply as it goes."
      />
    )
  }

  return (
    <div className={`relative ${className}`}>
      {hiddenGroups > 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-xs mb-3"
          onClick={() => setShowAll(true)}
        >
          Show earlier activity · {hiddenRows.toLocaleString()} events
        </button>
      )}
      <ol className="space-y-3" aria-label="Run timeline">
        {visible.map(group => {
          const isDefault = expandedByDefault.has(group.headerId)
          const expanded = toggled.has(group.headerId) ? !isDefault : isDefault
          return (
            <TimelineGroup
              key={group.headerId}
              group={group}
              expanded={expanded}
              onToggle={() =>
                setToggled(previous => {
                  const next = new Set(previous)
                  if (next.has(group.headerId)) next.delete(group.headerId)
                  else next.add(group.headerId)
                  return next
                })
              }
            />
          )
        })}
      </ol>
      <div ref={sentinelRef} aria-hidden="true" />
      {!atBottom && unseen > 0 && (
        <button
          type="button"
          className="btn btn-sm btn-primary gap-1.5 sticky bottom-2 left-1/2 -translate-x-1/2"
          onClick={scrollToBottom}
        >
          <ArrowDownIcon className="w-4 h-4" />
          Jump to latest · {unseen} new
        </button>
      )}
    </div>
  )
}

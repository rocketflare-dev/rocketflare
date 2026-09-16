/**
 * A run's durable event stream, grouped by stage (issue #17).
 *
 * Everything decided here is decided in `timelineModel.ts`, which is pure; this file is scrolling,
 * expansion and keys. Three behaviours worth knowing:
 *
 * - **The list scrolls, the panel does not grow.** From `lg` up it is a viewport-relative
 *   `max-h` + `overflow-y-auto`, which is also what gives the sentinel a real scroll root: without
 *   it the `<ol>` grew without bound, the panel grew with it, and `scrollIntoView` moved the PAGE
 *   rather than the list. Below `lg` the columns stack and the bound is deliberately dropped — a
 *   fixed-height inner scroller on a phone is a worse version of the page scrolling.
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

/**
 * Viewport-relative so a tall screen gets a longer list, with a floor so a short one still shows
 * something. The subtraction is the page header, the run header and the input block above it; the
 * action panel is sticky ABOVE this and scrolls the page, so it does not need to be in the sum.
 */
const TIMELINE_MAX_HEIGHT = 'lg:max-h-[max(24rem,calc(100vh-22rem))]'

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
      <div className={`lg:overflow-y-auto lg:overscroll-contain lg:pr-1 ${TIMELINE_MAX_HEIGHT}`}>
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
      </div>
      {/* Absolute over the scroller rather than `sticky` inside it: the pill then lands in the same
          place whether the list scrolls (lg) or the page does (below lg). */}
      {!atBottom && unseen > 0 && (
        <button
          type="button"
          className="btn btn-sm btn-primary gap-1.5 absolute bottom-2 left-1/2 -translate-x-1/2 z-10 shadow-lg"
          onClick={scrollToBottom}
        >
          <ArrowDownIcon className="w-4 h-4" />
          Jump to latest · {unseen} new
        </button>
      )}
    </div>
  )
}

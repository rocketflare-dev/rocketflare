/**
 * Home's activity feed (core, admin-level — the activity log's own rule): what just happened, in
 * plain words (`activitySentence`), consecutive repeats by one person folded into one line
 * (`groupActivity`). Home's one authored motion: an item that arrives while you
 * watch — Home re-reads itself on the realtime nudge behind it — slides in. Items already there
 * on the first render never move, and `prefers-reduced-motion` turns it off (`.activity-arrive`).
 */
import { ClockIcon } from '@heroicons/react/24/outline'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { EmptyState, SectionPanel, SectionPanelSkeleton } from '@/ui/components/shared'
import { useHomeSummary } from '@/ui/hooks/useHome'
import { activityGroupSentence, groupActivity } from '@/ui/lib/activity-words'
import { timeAgoShort } from '@/ui/lib/format'

/** The ids in `current` that `previous` did not have; nothing on the first render. Pure. */
export function arrivedIds(
  previous: ReadonlySet<string> | null,
  current: readonly string[]
): Set<string> {
  if (previous === null) return new Set()
  return new Set(current.filter(id => !previous.has(id)))
}

/** Which ids are new since the list was last committed. */
function useArrivals(ids: readonly string[], loaded: boolean): Set<string> {
  const seen = useRef<Set<string> | null>(null)
  const arrived = arrivedIds(seen.current, ids)
  const key = ids.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `ids` by value
  useEffect(() => {
    if (loaded) seen.current = new Set(ids)
  }, [key, loaded])
  return arrived
}

export function HomeActivity() {
  const { data, isLoading } = useHomeSummary()
  const items = data?.activity ?? []
  // "Marcus started 4 conversations" rather than the same line four times.
  const groups = groupActivity(items)
  const arrived = useArrivals(
    groups.map(g => g.event.id),
    Boolean(data?.activity)
  )
  if (isLoading) return <SectionPanelSkeleton rows={4} />
  if (!data?.activity) return null

  return (
    <SectionPanel
      title="Activity"
      actions={
        <Link to="/activity" className="btn btn-ghost btn-xs">
          All activity
        </Link>
      }
    >
      {items.length === 0 ? (
        <EmptyState icon={ClockIcon} message="Nothing has happened yet" size="sm" />
      ) : (
        <ul className="-my-1.5 text-sm" aria-live="polite" aria-relevant="additions">
          {groups.map(({ event, count }) => (
            <li
              key={event.id}
              data-arrived={arrived.has(event.id) || undefined}
              className={`flex items-baseline justify-between gap-3 py-1.5 ${arrived.has(event.id) ? 'activity-arrive' : ''}`}
            >
              <span className="min-w-0">{activityGroupSentence({ event, count })}</span>
              <time
                dateTime={event.createdAt.toISOString()}
                title={event.createdAt.toLocaleString()}
                className="text-xs text-muted whitespace-nowrap tabular-nums"
              >
                {timeAgoShort(event.createdAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </SectionPanel>
  )
}

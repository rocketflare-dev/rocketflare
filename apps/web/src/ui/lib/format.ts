/**
 * Date formatting for tables and cards (every timestamp on the wire is a `z.coerce.date`). One
 * vocabulary everywhere: a relative time is the short form ("3h ago"), and an absolute date leaves
 * out the year while it is the current one ("25 Nov, 18:32"; "3 Dec 2025, 09:10").
 */
import { format } from 'date-fns'

function sameYear(value: Date, now: Date): boolean {
  return value.getFullYear() === now.getFullYear()
}

export function formatDate(
  value: Date | null | undefined,
  fallback = '—',
  now = new Date()
): string {
  if (!value) return fallback
  return format(value, sameYear(value, now) ? 'd MMM' : 'd MMM yyyy')
}

export function formatDateTime(
  value: Date | null | undefined,
  fallback = '—',
  now = new Date()
): string {
  if (!value) return fallback
  return format(value, sameYear(value, now) ? 'd MMM, HH:mm' : 'd MMM yyyy, HH:mm')
}

/** "3h ago" — for activity feeds and "last seen"; the same short form as `timeAgoShort`. */
export function timeAgo(value: Date | null | undefined, fallback = 'never'): string {
  return value ? timeAgoShort(value) : fallback
}

/**
 * "3h ago", "2d ago" — for a column of times in a list, where "about 3 hours ago" would not fit.
 * A week or more reads as the date (`formatDate`). Pure: `now` is a parameter for tests.
 */
export function timeAgoShort(value: Date | null | undefined, now = new Date()): string {
  if (!value) return '—'
  const minutes = Math.floor((now.getTime() - value.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatDate(value, '—', now)
}

/** "Olive Owner" → "OO"; falls back to the first letter of the email. */
export function initials(name: string | null | undefined, email?: string): string {
  const source = name?.trim() || email || '?'
  const parts = source.split(/\s+/).filter(Boolean)
  const letters = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2)
  return letters.toUpperCase()
}

/** "1.4 MB" — binary units, one decimal past KB, for file sizes on cards and detail rows. */
export function formatBytes(bytes: number | null | undefined, fallback = '—'): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return fallback
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * `840ms`, `12s`, `1m 12s`, `18h 2m`, `3d 4h` — how long something took, for run headers, steps
 * and tool calls. Two units at most: past a minute the seconds stop mattering to the reader.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/**
 * Elapsed for a settled run; `null` while it still owes an answer or never started. Here rather
 * than beside the run page because the runs TABLE needs it too — that shared need is what made it
 * a real coupling when it lived in the detail component.
 */
export function runDuration(run: {
  startedAt: Date | null
  finishedAt: Date | null
}): string | null {
  if (!run.startedAt || !run.finishedAt) return null
  return formatDuration(run.finishedAt.getTime() - run.startedAt.getTime())
}

/**
 * A plugin event's name as a person reads it: `example-feature.note.created` → "Note created".
 * The first segment is the plugin's id, which says nothing to the person reading.
 */
export function eventLabel(name: string): string {
  const parts = name.split('.')
  const words = (parts.length > 1 ? parts.slice(1) : parts).join(' ').replace(/[-_]+/g, ' ').trim()
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : name
}

/**
 * How much of a run's wall clock it spent parked on a person: the union of its asks' open
 * intervals (raised → answered; a pending ask runs to `now`, an expired one to when it last
 * changed), clipped to the run's own start and finish. Overlapping asks count once.
 */
export function runWaitMs(
  run: { startedAt: Date | null; finishedAt: Date | null },
  interrupts: readonly {
    status: string
    createdAt: Date
    resolvedAt: Date | null
    updatedAt: Date
  }[],
  now: Date = new Date()
): number {
  if (!run.startedAt) return 0
  const from = run.startedAt.getTime()
  const to = (run.finishedAt ?? now).getTime()
  const spans = interrupts
    .map(ask => {
      const end = ask.resolvedAt ?? (ask.status === 'pending' ? now : ask.updatedAt)
      return [Math.max(from, ask.createdAt.getTime()), Math.min(to, end.getTime())] as const
    })
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])
  let total = 0
  let cursor = Number.NEGATIVE_INFINITY
  for (const [start, end] of spans) {
    const begin = Math.max(start, cursor)
    if (end > begin) total += end - begin
    cursor = Math.max(cursor, end)
  }
  return total
}

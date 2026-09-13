/** Date formatting for tables and cards (D13 — every timestamp on the wire is a `z.coerce.date`). */
import { format, formatDistanceToNow } from 'date-fns'

export function formatDate(value: Date | null | undefined, fallback = '—'): string {
  return value ? format(value, 'd MMM yyyy') : fallback
}

export function formatDateTime(value: Date | null | undefined, fallback = '—'): string {
  return value ? format(value, 'd MMM yyyy, HH:mm') : fallback
}

/** "3 hours ago" — for activity feeds and "last seen". */
export function timeAgo(value: Date | null | undefined, fallback = 'never'): string {
  return value ? formatDistanceToNow(value, { addSuffix: true }) : fallback
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

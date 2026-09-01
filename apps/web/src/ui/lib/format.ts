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

/**
 * How the agents pages print a metric. One place, so the list's columns and an agent's cards
 * agree on what "1.2k tokens" and "$0.0031" mean.
 */
import type { AgentStats } from '@rocketflare/shared/ai/agents'
import { formatDuration } from '@/ui/lib/format'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

export const formatTokens = (n: number) => (n === 0 ? '—' : compact.format(n))

/** Small amounts keep four decimals: a cent-rounded $0.00 reads as "free". */
export const formatUsd = (usd: number) =>
  usd === 0 ? '—' : usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`

export const formatAvgDuration = (stats: AgentStats) =>
  stats.avgDurationMs === null ? '—' : formatDuration(stats.avgDurationMs)

/** "12 · 1 failed · 2 active", or "—" with no runs. */
export function runsSummary(stats: AgentStats): string {
  if (stats.runs === 0) return '—'
  const parts = [String(stats.runs)]
  if (stats.failed > 0) parts.push(`${stats.failed} failed`)
  if (stats.active > 0) parts.push(`${stats.active} active`)
  return parts.join(' · ')
}

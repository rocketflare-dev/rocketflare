/**
 * AI usage (D18): `GET /api/ai/usage/summary?from&to` — token totals per (provider, model,
 * feature) for the tenant. Admin+ (`manage AiConfig`). The query is keyed on the PRESET
 * (`{ days }`), not on the timestamps: computing `new Date()` into the key would change it on
 * every render and refetch forever. The window is derived inside `queryFn`.
 */
import { aiUsageSummarySchema } from '@rocketflare/shared/ai/usage'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const USAGE_RANGE_PRESETS = [7, 30, 90] as const
export type UsageRangeDays = (typeof USAGE_RANGE_PRESETS)[number]

const DAY_MS = 24 * 60 * 60 * 1000

/** `[from, to]` for "the last N days", ending now. Exported for the test's expectations. */
export function usageWindow(days: number, now = new Date()): { from: string; to: string } {
  return { from: new Date(now.getTime() - days * DAY_MS).toISOString(), to: now.toISOString() }
}

export function aiUsageSummaryQueryOptions(days: UsageRangeDays) {
  return queryOptions({
    queryKey: queryKeys.ai.usage.summary({ days }),
    queryFn: () =>
      api.get(`/api/ai/usage/summary${toSearchParams(usageWindow(days))}`, {
        schema: aiUsageSummarySchema,
      }),
  })
}

export function useAiUsageSummary(days: UsageRangeDays) {
  return useQuery(aiUsageSummaryQueryOptions(days))
}

/** `costMicrocents` → dollars string, or null when no pricing has been supplied. */
export function formatCost(microcents: number | null | undefined): string | null {
  if (microcents === null || microcents === undefined) return null
  return `$${(microcents / 100_000_000).toFixed(4)}`
}

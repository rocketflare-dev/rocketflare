/**
 * Dashboard date range (D19, D20): the page-level "last 7 / 30 / 90 days / custom" control,
 * synced to the URL (`?range=7d|30d|90d|custom&from=YYYY-MM-DD&to=YYYY-MM-DD`) so a dashboard
 * link carries its window and the browser back button restores it. The value feeds the
 * template's `isUniversalTime` dashboard filter: `dashboardDateFilters(config, range)` returns
 * override copies of every universal-time filter with the new `values`, and drizzle-cube merges
 * them into the dashboard by filter id (`AnalyticsDashboard dashboardFilters`). Only strings the
 * server's relative-range parser recognises are ever emitted (`last N days`, or an ISO pair):
 * an unknown string is not a harmless no-op — drizzle-cube drops the condition and silently
 * queries all time — so anything unparseable in the URL falls back to the default.
 */
import type { DashboardConfig } from 'drizzle-cube/client'
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

/** One dashboard-level filter as drizzle-cube types it (`DashboardConfig['filters'][n]`). */
export type DashboardFilter = NonNullable<DashboardConfig['filters']>[number]

export type DateRangePreset = '7d' | '30d' | '90d' | 'custom'

export const DATE_RANGE_PRESETS: { key: Exclude<DateRangePreset, 'custom'>; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
]

/** Matches the template's `'last 90 days'` default. */
export const DEFAULT_DATE_RANGE_PRESET: Exclude<DateRangePreset, 'custom'> = '90d'

/** drizzle-cube's relative form: `last <n> days`. */
const PRESET_VALUES: Record<Exclude<DateRangePreset, 'custom'>, string> = {
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
}

/** A cube date range: one relative string or an inclusive ISO-date pair. */
export type DateRangeValue = string | [string, string]

export interface DateFilterState {
  preset: DateRangePreset
  /** ISO dates, only meaningful when `preset === 'custom'`. */
  from?: string
  to?: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))
}

/** URL → state; anything unparseable (unknown preset, bad or inverted dates) is the default. */
export function parseDateFilterParams(params: URLSearchParams): DateFilterState {
  const range = params.get('range')
  if (range === '7d' || range === '30d' || range === '90d') return { preset: range }
  if (range === 'custom') {
    const from = params.get('from')
    const to = params.get('to')
    if (isIsoDate(from) && isIsoDate(to) && from <= to) return { preset: 'custom', from, to }
  }
  return { preset: DEFAULT_DATE_RANGE_PRESET }
}

/** State → the query-string entries (only the keys the state needs). */
export function dateFilterParams(state: DateFilterState): Record<string, string> {
  if (state.preset === 'custom' && state.from && state.to) {
    return { range: 'custom', from: state.from, to: state.to }
  }
  return { range: state.preset === 'custom' ? DEFAULT_DATE_RANGE_PRESET : state.preset }
}

/** State → the value drizzle-cube receives in `filter.values`. */
export function dateRangeValue(state: DateFilterState): DateRangeValue {
  if (state.preset === 'custom' && state.from && state.to) return [state.from, state.to]
  const preset = state.preset === 'custom' ? DEFAULT_DATE_RANGE_PRESET : state.preset
  return PRESET_VALUES[preset]
}

/**
 * Overrides for every `isUniversalTime` filter in `config` carrying `range` as its values —
 * drizzle-cube merges them by `id`, so portlets mapped to the filter follow the page control and
 * portlets with their own window (a "last 30 days" KPI) are untouched. Pure — unit-tested.
 */
export function dashboardDateFilters(
  config: Pick<DashboardConfig, 'filters'> | undefined,
  range: DateRangeValue
): DashboardFilter[] {
  const values = Array.isArray(range) ? range : [range]
  return (config?.filters ?? [])
    .filter(f => f.isUniversalTime && f.id)
    .map(f => ({ ...f, filter: { ...f.filter, values } }))
}

/** Human label for the control's current value. */
export function dateRangeLabel(state: DateFilterState): string {
  if (state.preset === 'custom' && state.from && state.to) return `${state.from} → ${state.to}`
  const preset = state.preset === 'custom' ? DEFAULT_DATE_RANGE_PRESET : state.preset
  return DATE_RANGE_PRESETS.find(p => p.key === preset)?.label ?? preset
}

/** The URL-synced control state. Other query params on the page are preserved. */
export function useDashboardDateFilter() {
  const [params, setParams] = useSearchParams()
  const state = useMemo(() => parseDateFilterParams(params), [params])
  const range = useMemo(() => dateRangeValue(state), [state])

  const apply = useCallback(
    (next: DateFilterState) => {
      setParams(
        prev => {
          const out = new URLSearchParams(prev)
          for (const key of ['range', 'from', 'to']) out.delete(key)
          for (const [k, v] of Object.entries(dateFilterParams(next))) out.set(k, v)
          return out
        },
        { replace: true }
      )
    },
    [setParams]
  )

  const setPreset = useCallback(
    (preset: Exclude<DateRangePreset, 'custom'>) => apply({ preset }),
    [apply]
  )
  const setCustom = useCallback(
    (from: string, to: string) => {
      if (isIsoDate(from) && isIsoDate(to) && from <= to) apply({ preset: 'custom', from, to })
    },
    [apply]
  )

  return { state, range, label: dateRangeLabel(state), setPreset, setCustom }
}

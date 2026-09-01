/**
 * Dashboard date range (D19): URL ↔ state round-trips, only server-parseable values are ever
 * emitted (unknown / inverted → the 90-day default), and `dashboardDateFilters` overrides ONLY the
 * `isUniversalTime` filters of a config, leaving the others untouched.
 */
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import {
  dashboardDateFilters,
  dateFilterParams,
  dateRangeLabel,
  dateRangeValue,
  parseDateFilterParams,
  useDashboardDateFilter,
} from '@/ui/hooks/useDashboardDateFilter'
import { TEMPLATE_CONFIG } from './helpers/analytics'

const params = (s: string) => new URLSearchParams(s)

describe('date filter — pure helpers', () => {
  it('parses presets and a valid custom range', () => {
    expect(parseDateFilterParams(params('range=7d'))).toEqual({ preset: '7d' })
    expect(parseDateFilterParams(params('range=30d'))).toEqual({ preset: '30d' })
    expect(parseDateFilterParams(params('range=custom&from=2025-01-01&to=2025-01-31'))).toEqual({
      preset: 'custom',
      from: '2025-01-01',
      to: '2025-01-31',
    })
  })

  it('falls back to the default for anything the server could not resolve', () => {
    for (const q of [
      '',
      'range=last-week',
      'range=custom',
      'range=custom&from=2025-01-31&to=2025-01-01', // inverted
      'range=custom&from=yesterday&to=2025-01-01',
      'range=custom&from=2025-13-40&to=2025-12-31',
    ]) {
      expect(parseDateFilterParams(params(q))).toEqual({ preset: '90d' })
    }
  })

  it('emits exactly the relative strings drizzle-cube parses, or an ISO pair', () => {
    expect(dateRangeValue({ preset: '7d' })).toBe('last 7 days')
    expect(dateRangeValue({ preset: '30d' })).toBe('last 30 days')
    expect(dateRangeValue({ preset: '90d' })).toBe('last 90 days')
    expect(dateRangeValue({ preset: 'custom', from: '2025-01-01', to: '2025-02-01' })).toEqual([
      '2025-01-01',
      '2025-02-01',
    ])
    // A custom preset without dates cannot be represented: default, never an unknown string
    expect(dateRangeValue({ preset: 'custom' })).toBe('last 90 days')
    expect(dateFilterParams({ preset: 'custom' })).toEqual({ range: '90d' })
    expect(dateFilterParams({ preset: 'custom', from: '2025-01-01', to: '2025-02-01' })).toEqual({
      range: 'custom',
      from: '2025-01-01',
      to: '2025-02-01',
    })
    expect(dateRangeLabel({ preset: '30d' })).toBe('Last 30 days')
    expect(dateRangeLabel({ preset: 'custom', from: '2025-01-01', to: '2025-02-01' })).toBe(
      '2025-01-01 → 2025-02-01'
    )
  })

  it('overrides only the universal-time filters of a config', () => {
    const overrides = dashboardDateFilters(TEMPLATE_CONFIG as never, 'last 7 days')
    expect(overrides).toHaveLength(1)
    expect(overrides[0]).toMatchObject({
      id: 'time-filter',
      label: 'Date Range',
      isUniversalTime: true,
      filter: { member: '__universal_time__', operator: 'inDateRange', values: ['last 7 days'] },
    })
    expect(
      dashboardDateFilters(TEMPLATE_CONFIG as never, ['2025-01-01', '2025-01-31'])[0]
    ).toMatchObject({ filter: { values: ['2025-01-01', '2025-01-31'] } })
    expect(dashboardDateFilters(undefined, 'last 7 days')).toEqual([])
    expect(dashboardDateFilters({ filters: [] }, 'last 7 days')).toEqual([])
    // The source config is not mutated
    expect(TEMPLATE_CONFIG.filters[0].filter.values).toEqual(['last 90 days'])
  })
})

describe('useDashboardDateFilter — URL sync', () => {
  function setup(initial = '/analytics/x') {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter
        initialEntries={[initial]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        {children}
      </MemoryRouter>
    )
    return renderHook(() => ({ filter: useDashboardDateFilter(), location: useLocation() }), {
      wrapper,
    })
  }

  it('reads the URL, writes presets and custom ranges back, and keeps other params', () => {
    const { result } = setup('/analytics/x?tab=charts&range=30d')
    expect(result.current.filter.state).toEqual({ preset: '30d' })
    expect(result.current.filter.range).toBe('last 30 days')

    act(() => result.current.filter.setPreset('7d'))
    expect(result.current.location.search).toBe('?tab=charts&range=7d')
    expect(result.current.filter.range).toBe('last 7 days')

    act(() => result.current.filter.setCustom('2025-01-01', '2025-01-31'))
    expect(new URLSearchParams(result.current.location.search).get('range')).toBe('custom')
    expect(new URLSearchParams(result.current.location.search).get('from')).toBe('2025-01-01')
    expect(new URLSearchParams(result.current.location.search).get('to')).toBe('2025-01-31')
    expect(new URLSearchParams(result.current.location.search).get('tab')).toBe('charts')
    expect(result.current.filter.range).toEqual(['2025-01-01', '2025-01-31'])

    // Back to a preset drops the custom dates
    act(() => result.current.filter.setPreset('90d'))
    expect(result.current.location.search).toBe('?tab=charts&range=90d')
  })

  it('ignores an invalid custom range and defaults an unknown URL value', () => {
    const { result } = setup('/analytics/x?range=bogus')
    expect(result.current.filter.state).toEqual({ preset: '90d' })
    act(() => result.current.filter.setCustom('2025-02-01', '2025-01-01'))
    expect(result.current.location.search).toBe('?range=bogus')
    expect(result.current.filter.range).toBe('last 90 days')
  })
})

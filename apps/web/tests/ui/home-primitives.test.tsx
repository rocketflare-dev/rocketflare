/**
 * The chart primitives Home uses: `RunsChart` (summary in words, a button per day, select and
 * clear), `TrendLine` (named, the points scaled into its box) and `AvatarStack` (named with the
 * people, "+N", initials when a photo fails).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AvatarStack, avatarStackLabel } from '@/ui/components/shared/AvatarStack'
import {
  type ChartSeries,
  chartDayDescription,
  chartScale,
  chartSummary,
  RunsChart,
} from '@/ui/components/shared/RunsChart'
import { TrendLine, trendPoints } from '@/ui/components/shared/TrendLine'

const SERIES: ChartSeries[] = [
  { key: 'ok', label: 'succeeded', color: '--series-1' },
  { key: 'bad', label: 'failed', color: '--color-error' },
]
const QUIET = { date: '2025-05-30', values: { ok: 0, bad: 0 } }
const BUSY = { date: '2025-05-31', values: { ok: 2, bad: 1 } }
const DAYS = [QUIET, BUSY]

describe('RunsChart', () => {
  it('describes the whole chart and each day in words', () => {
    expect(chartSummary(DAYS, SERIES, 'runs')).toBe(
      '3 runs in the last 2 days: 2 succeeded, 1 failed'
    )
    expect(chartSummary([QUIET], SERIES, 'runs')).toBe('No runs in the last 1 days')
    expect(chartDayDescription(BUSY, SERIES, 'runs')).toMatch(/: 3 runs, 2 succeeded, 1 failed$/)
    expect(chartDayDescription(QUIET, SERIES, 'runs')).toMatch(/: no runs$/)
  })

  it('scales to at least the floor, to a number whose half is whole', () => {
    expect(chartScale(DAYS)).toBe(4)
    expect(chartScale([{ date: 'x', values: { ok: 7 } }])).toBe(8)
    expect(chartScale([{ date: 'x', values: { ok: 23 } }])).toBe(30)
    expect(chartScale([QUIET], 6)).toBe(6)
  })

  it('draws from tokens, bars to scale, and selects, then clears, a day', () => {
    const onSelectDay = vi.fn()
    const { container, rerender } = render(
      <RunsChart days={DAYS} series={SERIES} noun="runs" onSelectDay={onSelectDay} />
    )
    expect(screen.getByRole('group', { name: /3 runs in the last 2 days/ })).toBeInTheDocument()
    const fills = [...container.querySelectorAll<HTMLElement>('[data-series]')].map(
      el => el.style.background
    )
    expect(fills).toEqual(['var(--series-1)', 'var(--color-error)'])
    // 3 of a scale of 4.
    const bar = container.querySelector<HTMLElement>('[data-series]')?.parentElement
    expect(bar?.style.height).toBe('75%')
    // The key lists only the series the bars show.
    expect(screen.getByText('succeeded')).toBeInTheDocument()

    const day = screen.getByRole('button', { name: /: 3 runs/ })
    fireEvent.click(day)
    expect(onSelectDay).toHaveBeenLastCalledWith('2025-05-31')

    rerender(
      <RunsChart
        days={DAYS}
        series={SERIES}
        noun="runs"
        selected="2025-05-31"
        onSelectDay={onSelectDay}
      />
    )
    expect(screen.getByRole('button', { name: /: 3 runs/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /: 3 runs/ }))
    expect(onSelectDay).toHaveBeenLastCalledWith(null)
  })

  it('a day shows its counts on hover or focus, in a tooltip inside its button', () => {
    render(<RunsChart days={DAYS} series={SERIES} noun="runs" onSelectDay={() => {}} />)
    const day = screen.getByRole('button', { name: /: 3 runs/ })
    expect(day).toHaveTextContent('2 succeeded')
    expect(day).toHaveTextContent('1 failed')
  })

  it('has no day buttons without onSelectDay', () => {
    render(<RunsChart days={DAYS} series={SERIES} noun="runs" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('TrendLine', () => {
  it('is one named image, its points inside the box', () => {
    render(<TrendLine values={[0, 1, 4]} label="Agent spend per day, rising" />)
    expect(screen.getByRole('img', { name: 'Agent spend per day, rising' })).toBeInTheDocument()
    const points = trendPoints([0, 1, 4])
    expect(points).toHaveLength(3)
    // Highest value at the top of the box, lowest at the bottom.
    expect(points[2]?.[1]).toBeLessThan(points[0]?.[1] ?? 0)
    expect(trendPoints([])).toEqual([])
    expect(new Set(trendPoints([2, 2, 2]).map(p => p[1])).size).toBe(1)
  })
})

describe('AvatarStack', () => {
  it('names the people and counts the rest', () => {
    expect(avatarStackLabel(['Ana'], 1)).toBe('Ana')
    expect(avatarStackLabel(['Ana', 'Bob'], 2)).toBe('Ana and Bob')
    expect(avatarStackLabel(['Ana', 'Bob'], 5)).toBe('Ana, Bob and 3 others')
    const people = ['Ana Lopez', 'Bob Stone', 'Cy Ode'].map((name, i) => ({ id: String(i), name }))
    render(<AvatarStack people={people} total={9} max={2} />)
    expect(
      screen.getByRole('img', { name: 'Ana Lopez, Bob Stone and 7 others' })
    ).toBeInTheDocument()
    expect(screen.getByText('+7')).toBeInTheDocument()
  })

  it('falls back to initials when a photo fails to load', () => {
    const { container } = render(
      <AvatarStack people={[{ id: '1', name: 'Ana Lopez', avatarUrl: '/broken.png' }]} />
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    fireEvent.error(img as HTMLImageElement)
    expect(screen.getByText('AL')).toBeInTheDocument()
  })
})

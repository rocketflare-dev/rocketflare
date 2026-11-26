/**
 * Bars over days, each stacked by series, coloured from tokens. Built for agent runs by outcome
 * (hence the name) but takes any series: a series' `color` is a CSS custom property, a calm
 * `--series-*` step for the everyday outcome and a state colour (`--color-error`) only where the
 * bar means that state.
 *
 * Drawn as HTML boxes rather than a stretched SVG so the gaps stay gaps and the rounded tops stay
 * round at any width. The height means something: a fixed floor for the scale (`minScale`, so two
 * runs never fill the chart), a hairline at its half and its top with their numbers, a baseline.
 *
 * Accessible twice: the whole chart is a group named by its summary in words, and every day is a
 * real button carrying its own numbers (a keyboard can pick a day; focus shows the same tooltip as
 * hover). Clicking the selected day again clears the selection (`onSelectDay(null)`).
 */

export interface ChartSeries {
  key: string
  /** Lower-case noun for the words: "failed", "succeeded". */
  label: string
  /** A CSS custom property name: `--series-1`, `--color-error`. */
  color: string
}

export interface ChartDay {
  /** `YYYY-MM-DD` (UTC). */
  date: string
  values: Record<string, number>
}

export interface RunsChartProps {
  days: readonly ChartDay[]
  /** Bottom of the stack first. */
  series: readonly ChartSeries[]
  /** What one unit is, plural: "runs". */
  noun: string
  /** The selected day, if any — the others dim. */
  selected?: string | null
  onSelectDay?: (date: string | null) => void
  /** The bars' height as a Tailwind class. */
  heightClass?: string
  /** The scale never tops out below this, so a quiet fortnight still reads as quiet. */
  minScale?: number
  /** The key under the chart; off when the caller shows `ChartLegend` elsewhere. */
  legend?: boolean
  className?: string
}

/** "12 Nov" for a UTC day key, in the reader's locale. */
export function chartDayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
}

/** "M" for a Monday: the axis under each bar. */
export function chartWeekdayInitial(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'narrow',
    timeZone: 'UTC',
  })
}

const totalOf = (day: ChartDay) => Object.values(day.values).reduce((n, v) => n + v, 0)

/**
 * The top of the scale: at least `minScale`, then rounded up to a number whose half is whole
 * (even up to 10, a multiple of 10 beyond), so the half-way gridline reads as a plain number.
 */
export function chartScale(days: readonly ChartDay[], minScale = 4): number {
  const max = Math.max(minScale, ...days.map(totalOf))
  if (max <= 10) return Math.ceil(max / 2) * 2
  return Math.ceil(max / 10) * 10
}

/** One day in words: "12 Nov: 5 runs, 4 succeeded, 1 failed" — the button's accessible name. */
export function chartDayDescription(
  day: ChartDay,
  series: readonly ChartSeries[],
  noun: string
): string {
  const total = totalOf(day)
  if (total === 0) return `${chartDayLabel(day.date)}: no ${noun}`
  const parts = series
    .filter(s => (day.values[s.key] ?? 0) > 0)
    .map(s => `${day.values[s.key]} ${s.label}`)
  return `${chartDayLabel(day.date)}: ${total} ${noun}, ${parts.join(', ')}`
}

/** The whole chart in one sentence — the group's accessible name. */
export function chartSummary(
  days: readonly ChartDay[],
  series: readonly ChartSeries[],
  noun: string
): string {
  const total = days.reduce((n, d) => n + totalOf(d), 0)
  const span = `the last ${days.length} days`
  if (total === 0) return `No ${noun} in ${span}`
  const bySeries = series
    .map(s => ({ s, n: days.reduce((m, d) => m + (d.values[s.key] ?? 0), 0) }))
    .filter(x => x.n > 0)
    .map(x => `${x.n} ${x.s.label}`)
  return `${total} ${noun} in ${span}: ${bySeries.join(', ')}`
}

/** The series that actually appear: a swatch with no bar is a question with no answer. */
export function presentSeries(
  days: readonly ChartDay[],
  series: readonly ChartSeries[]
): ChartSeries[] {
  return series.filter(s => days.some(d => (d.values[s.key] ?? 0) > 0))
}

export function ChartLegend({
  series,
  className = '',
}: {
  series: readonly ChartSeries[]
  className?: string
}) {
  return (
    <ul
      className={`flex flex-wrap gap-x-3 gap-y-1 text-xs text-secondary ${className}`}
      aria-hidden
    >
      {series.map(s => (
        <li key={s.key} className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm" style={{ background: `var(${s.color})` }} />
          {s.label}
        </li>
      ))}
    </ul>
  )
}

export function RunsChart({
  days,
  series,
  noun,
  selected = null,
  onSelectDay,
  heightClass = 'h-24',
  minScale = 4,
  legend = true,
  className = '',
}: RunsChartProps) {
  const scale = chartScale(days, minScale)
  const today = days.at(-1)?.date

  return (
    <figure role="group" aria-label={chartSummary(days, series, noun)} className={className}>
      <div className="flex gap-2">
        {/* The scale's numbers, at its top and its half. */}
        <div
          className={`relative w-5 shrink-0 text-xs text-muted tabular-nums ${heightClass}`}
          aria-hidden
        >
          <span className="absolute right-0 top-0 -translate-y-1/2 leading-none">{scale}</span>
          <span className="absolute right-0 top-1/2 -translate-y-1/2 leading-none">
            {scale / 2}
          </span>
        </div>
        <div className="relative flex-1 min-w-0">
          <div className={`relative ${heightClass}`}>
            <span
              className="absolute inset-x-0 top-0 border-t border-[color:var(--border-subtle)]"
              aria-hidden
            />
            <span
              className="absolute inset-x-0 top-1/2 border-t border-[color:var(--border-subtle)]"
              aria-hidden
            />
            <div className="absolute inset-0 flex items-stretch border-b border-[color:var(--border-default)]">
              {days.map(day => (
                <DayColumn
                  key={day.date}
                  day={day}
                  series={series}
                  noun={noun}
                  scale={scale}
                  isToday={day.date === today}
                  dim={selected !== null && selected !== day.date}
                  pressed={selected === day.date}
                  onSelect={
                    onSelectDay
                      ? () => onSelectDay(selected === day.date ? null : day.date)
                      : undefined
                  }
                />
              ))}
            </div>
          </div>
          <div className="flex mt-1.5 text-xs text-muted" aria-hidden>
            {days.map(day => (
              <span
                key={day.date}
                className={`flex-1 text-center ${day.date === today ? 'font-semibold text-[color:var(--text-primary)]' : ''}`}
              >
                {chartWeekdayInitial(day.date)}
              </span>
            ))}
          </div>
        </div>
      </div>
      {legend && <ChartLegend series={presentSeries(days, series)} className="mt-2 ml-7" />}
    </figure>
  )
}

function DayColumn({
  day,
  series,
  noun,
  scale,
  isToday,
  dim,
  pressed,
  onSelect,
}: {
  day: ChartDay
  series: readonly ChartSeries[]
  noun: string
  scale: number
  isToday: boolean
  dim: boolean
  pressed: boolean
  onSelect?: () => void
}) {
  const total = totalOf(day)
  const segments = series.filter(s => (day.values[s.key] ?? 0) > 0)
  const description = chartDayDescription(day, series, noun)
  const bar = (
    <span
      className={`flex flex-col-reverse w-[min(60%,1.25rem)] transition-opacity ${dim ? 'opacity-35' : ''}`}
      style={{ height: `${(Math.min(total, scale) / scale) * 100}%` }}
    >
      {segments.map((s, i) => (
        <span
          key={s.key}
          data-series={s.key}
          className={i === segments.length - 1 ? 'rounded-t-[3px]' : ''}
          style={{
            height: `${((day.values[s.key] ?? 0) / total) * 100}%`,
            background: `var(${s.color})`,
          }}
        />
      ))}
    </span>
  )
  const tooltip = (
    <span
      role="presentation"
      className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-10 hidden group-hover:block group-focus-visible:block popover-surface px-2.5 py-1.5 text-xs text-left whitespace-nowrap"
    >
      <span className="block font-medium text-[color:var(--text-primary)]">
        {chartDayLabel(day.date)}
        {isToday ? ' · today' : ''}
      </span>
      {total === 0 ? (
        <span className="block text-muted">No {noun}</span>
      ) : (
        segments.map(s => (
          <span key={s.key} className="flex items-center gap-1.5 text-secondary tabular-nums">
            <span className="w-2 h-2 rounded-sm" style={{ background: `var(${s.color})` }} />
            {day.values[s.key]} {s.label}
          </span>
        ))
      )}
    </span>
  )
  const columnClass = `group relative flex-1 h-full flex items-end justify-center ${
    isToday ? 'bg-[color:var(--surface-inset)] rounded-t-[4px]' : ''
  }`
  if (!onSelect) {
    return (
      <span className={columnClass} title={description}>
        {bar}
        {tooltip}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={`${columnClass} cursor-pointer hover:bg-[color:var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[color:var(--focus-ring)] rounded-t-[4px]`}
      aria-label={description}
      aria-pressed={pressed}
      onClick={onSelect}
    >
      {bar}
      {tooltip}
    </button>
  )
}

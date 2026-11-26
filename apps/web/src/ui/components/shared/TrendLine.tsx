/**
 * A small line of a number's recent history — hand-rolled SVG in the first series colour. Only
 * ever placed BESIDE the number it explains (the number is the content; this is its context), and
 * its accessible name says what it shows in words.
 */
export interface TrendLineProps {
  /** Oldest first. */
  values: readonly number[]
  /** What the line shows, in words: "Agent spend per day over the last 14 days, rising". */
  label: string
  className?: string
}

const WIDTH = 96
const HEIGHT = 28
const PAD = 3

/** The polyline's points in the viewBox, the last one returned separately for its dot. */
export function trendPoints(values: readonly number[]): Array<[number, number]> {
  if (values.length === 0) return []
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const step = values.length > 1 ? (WIDTH - PAD * 2) / (values.length - 1) : 0
  return values.map((v, i) => [
    PAD + i * step,
    max === min ? HEIGHT - PAD : HEIGHT - PAD - ((v - min) / range) * (HEIGHT - PAD * 2),
  ])
}

export function TrendLine({ values, label, className = '' }: TrendLineProps) {
  const points = trendPoints(values)
  const end = points.at(-1)
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={`w-24 h-7 shrink-0 ${className}`}
    >
      <polyline
        points={points.map(([x, y]) => `${x},${y}`).join(' ')}
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ stroke: 'var(--series-1)' }}
      />
      {end && <circle cx={end[0]} cy={end[1]} r={2.5} style={{ fill: 'var(--series-1)' }} />}
    </svg>
  )
}

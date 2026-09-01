/**
 * The dashboard page's date range control (D19, D20): preset buttons (7 / 30 / 90 days) and a
 * custom ISO from/to pair, bound to `useDashboardDateFilter` (URL-synced). Presentational —
 * the state and its validation live in the hook.
 */
import { useState } from 'react'
import {
  DATE_RANGE_PRESETS,
  type DateFilterState,
  type DateRangePreset,
} from '@/ui/hooks/useDashboardDateFilter'

interface DateRangeControlProps {
  state: DateFilterState
  onPreset: (preset: Exclude<DateRangePreset, 'custom'>) => void
  onCustom: (from: string, to: string) => void
}

export function DateRangeControl({ state, onPreset, onCustom }: DateRangeControlProps) {
  const [customOpen, setCustomOpen] = useState(state.preset === 'custom')
  const [from, setFrom] = useState(state.from ?? '')
  const [to, setTo] = useState(state.to ?? '')
  const showCustom = customOpen || state.preset === 'custom'

  return (
    <section className="flex flex-wrap items-center gap-2" aria-label="Date range">
      <div className="join">
        {DATE_RANGE_PRESETS.map(p => (
          <button
            key={p.key}
            type="button"
            className={`btn btn-xs join-item ${state.preset === p.key ? 'btn-active' : ''}`}
            aria-pressed={state.preset === p.key}
            onClick={() => {
              setCustomOpen(false)
              onPreset(p.key)
            }}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className={`btn btn-xs join-item ${state.preset === 'custom' ? 'btn-active' : ''}`}
          aria-pressed={state.preset === 'custom'}
          onClick={() => setCustomOpen(o => !o)}
        >
          Custom
        </button>
      </div>
      {showCustom && (
        <form
          className="flex items-center gap-1"
          onSubmit={e => {
            e.preventDefault()
            onCustom(from, to)
          }}
        >
          <input
            type="date"
            className="input input-xs"
            aria-label="From"
            value={from}
            max={to || undefined}
            onChange={e => setFrom(e.target.value)}
            required
          />
          <span className="text-xs text-muted">to</span>
          <input
            type="date"
            className="input input-xs"
            aria-label="To"
            value={to}
            min={from || undefined}
            onChange={e => setTo(e.target.value)}
            required
          />
          <button type="submit" className="btn btn-xs btn-primary" disabled={!from || !to}>
            Apply
          </button>
        </form>
      )}
    </section>
  )
}

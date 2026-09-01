/**
 * Settings → Usage (D18): AI token totals for the last 7 / 30 / 90 days from
 * `GET /api/ai/usage/summary` — grand totals as cards, then one row per (provider, model,
 * feature). Cost comes from the kit's price table (`@rocketflare/shared/ai/pricing`) and is
 * labelled an ESTIMATE, with the count of calls whose model has no price — a total that quietly
 * omits half the calls is worse than one that says so.
 * Admin+ (`manage AiConfig`); the tab is hidden otherwise.
 */

import { ChartBarIcon } from '@heroicons/react/24/outline'
import { shortModelName } from '@rocketflare/shared/ai/config'
import { PRICES_UPDATED } from '@rocketflare/shared/ai/pricing'
import { useState } from 'react'
import { EmptyState, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import {
  formatCost,
  USAGE_RANGE_PRESETS,
  type UsageRangeDays,
  useAiUsageSummary,
} from '@/ui/hooks/useAiUsage'
import { formatDate } from '@/ui/lib/format'

export default function UsageSettings() {
  const [days, setDays] = useState<UsageRangeDays>(30)
  const { data, isLoading, isError, isFetching } = useAiUsageSummary(days)
  const totals = data?.totals
  const cost = formatCost(totals?.costMicrocents)

  return (
    <SectionPanel
      flush
      title="AI usage"
      description={
        data
          ? `${formatDate(data.from)} – ${formatDate(data.to)}`
          : 'Tokens spent by this workspace, per provider, model and feature.'
      }
      actions={
        <div className="join" role="group" aria-label="Date range">
          {USAGE_RANGE_PRESETS.map(preset => (
            <button
              key={preset}
              type="button"
              className={`btn btn-sm join-item ${preset === days ? 'btn-primary' : ''}`}
              aria-pressed={preset === days}
              onClick={() => setDays(preset)}
            >
              {preset} days
            </button>
          ))}
        </div>
      }
    >
      {isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={3} />
        </div>
      ) : isError || !data ? (
        <p className="px-5 pb-5 text-sm text-error" role="alert">
          Usage could not be loaded.
        </p>
      ) : (
        <div className={isFetching ? 'opacity-70 transition-opacity' : ''}>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 px-5 pb-4">
            <Stat label="Calls" value={data.totals.calls} />
            <Stat label="Input tokens" value={data.totals.inputTokens} />
            <Stat label="Output tokens" value={data.totals.outputTokens} />
            {cost ? (
              <Stat label="Cost (estimated)" value={cost} />
            ) : (
              <Stat
                label="Cache read / write"
                value={`${data.totals.cacheReadTokens.toLocaleString()} / ${data.totals.cacheWriteTokens.toLocaleString()}`}
              />
            )}
          </dl>

          {data.rows.length === 0 ? (
            <EmptyState
              icon={ChartBarIcon}
              message="No AI usage in this period"
              description="Every chat reply and connection test lands here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table" aria-label="Usage by provider, model and feature">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Model</th>
                    <th>Feature</th>
                    <th className="text-right">Calls</th>
                    <th className="text-right">Input</th>
                    <th className="text-right">Output</th>
                    <th className="text-right">Cache read</th>
                    <th className="text-right">Cache write</th>
                    {cost && <th className="text-right">Cost</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(row => (
                    <tr key={`${row.provider}:${row.model}:${row.feature}`}>
                      <td className="text-secondary">{row.provider}</td>
                      <td className="font-mono text-xs" title={row.model}>
                        {shortModelName(row.model)}
                      </td>
                      <td>{row.feature}</td>
                      <td className="text-right tabular-nums">{row.calls.toLocaleString()}</td>
                      <td className="text-right tabular-nums">
                        {row.inputTokens.toLocaleString()}
                      </td>
                      <td className="text-right tabular-nums">
                        {row.outputTokens.toLocaleString()}
                      </td>
                      <td className="text-right tabular-nums text-secondary">
                        {row.cacheReadTokens.toLocaleString()}
                      </td>
                      <td className="text-right tabular-nums text-secondary">
                        {row.cacheWriteTokens.toLocaleString()}
                      </td>
                      {cost && (
                        <td className="text-right tabular-nums">
                          {formatCost(row.costMicrocents) ?? '—'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cost && (
            <p className="px-5 pb-5 pt-3 text-xs text-muted">
              Estimated from the built-in price list (checked {PRICES_UPDATED}) — not a bill.
              {data.totals.unpricedCalls > 0 &&
                ` ${data.totals.unpricedCalls.toLocaleString()} call(s) use a model with no price and are not included.`}{' '}
              Prices live in <code>packages/shared/src/ai/pricing.ts</code>.
            </p>
          )}
        </div>
      )}
    </SectionPanel>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="surface-inset rounded-lg p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums mt-0.5">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </dd>
    </div>
  )
}

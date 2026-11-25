/**
 * Home's AI spend (core, admin-level): one line per daily budget this deployment sets — today's
 * spend against the budget, with its last fortnight beside it. Absent when no budget is set: with
 * nothing to measure against, a cost figure tells nobody what to do.
 */
import type { HomeSpendLine, HomeSpendScope } from '@rocketflare/shared/home'
import { Link } from 'react-router'
import { SectionPanel, TrendLine } from '@/ui/components/shared'
import { useHomeSummary } from '@/ui/hooks/useHome'
import { settingsTabPath } from '../settings/tabs'

const SCOPE_WORDS: Record<HomeSpendScope, string> = {
  agents: 'Agents',
  knowledge: 'Knowledge base',
}

const usd = (n: number) => `$${n.toFixed(2)}`

/** "rising", "falling" or "steady": the later half of the window against the earlier. */
export function spendDirection(days: readonly { costUsd: number }[]): string {
  const half = Math.floor(days.length / 2)
  const sum = (xs: readonly { costUsd: number }[]) => xs.reduce((n, d) => n + d.costUsd, 0)
  const before = sum(days.slice(0, half))
  const after = sum(days.slice(half))
  if (after > before * 1.2 && after - before > 0.01) return 'rising'
  if (after < before * 0.8 && before - after > 0.01) return 'falling'
  return 'steady'
}

export function HomeSpend() {
  const { data } = useHomeSummary()
  const lines = data?.spend?.lines
  if (!lines || lines.length === 0) return null
  return (
    <SectionPanel
      title="AI spend today"
      actions={
        <Link to={settingsTabPath('usage')} className="btn btn-ghost btn-xs">
          Usage
        </Link>
      }
    >
      <ul className="space-y-3">
        {lines.map(line => (
          <SpendRow key={line.scope} line={line} />
        ))}
      </ul>
    </SectionPanel>
  )
}

function SpendRow({ line }: { line: HomeSpendLine }) {
  const over = line.dailyBudgetUsd > 0 && line.todayUsd >= line.dailyBudgetUsd
  return (
    <li className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-secondary">{SCOPE_WORDS[line.scope]}</p>
        <p className="text-sm tabular-nums">
          <span className={`font-semibold ${over ? 'text-error' : ''}`}>{usd(line.todayUsd)}</span>
          <span className="text-muted"> of {usd(line.dailyBudgetUsd)} a day</span>
        </p>
        {over && (
          <p className="text-xs text-error">
            {line.scope === 'agents'
              ? 'Budget reached: new runs wait for tomorrow'
              : 'Budget reached: fact extraction waits for tomorrow'}
          </p>
        )}
      </div>
      <TrendLine
        values={line.days.map(d => d.costUsd)}
        label={`${SCOPE_WORDS[line.scope]} spend per day over the last ${line.days.length} days, ${spendDirection(line.days)}`}
      />
    </li>
  )
}

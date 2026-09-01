/**
 * Settings → Usage (D18): the 30-day default requests `from`/`to`, renders totals (cost labelled
 * an estimate, unpriced calls named, an unpriced row dashed) and the
 * per-(provider, model, feature) rows; switching the preset re-queries a shorter window; an empty
 * period shows the empty state.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usageWindow } from '@/ui/hooks/useAiUsage'
import UsageSettings from '@/ui/pages/settings/Usage'
import { makeSession, renderWithProviders, stubFetch } from './helpers/renderWithProviders'

const summary = (from: string, to: string, rows: unknown[]) => ({
  from,
  to,
  rows,
  totals: rows.length
    ? {
        calls: 14,
        inputTokens: 12_300,
        outputTokens: 4_500,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        // Priced from the table: the page shows an estimate and says so.
        costMicrocents: 4_200_000_000,
        unpricedCalls: 2,
      }
    : {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicrocents: null,
        unpricedCalls: 0,
      },
})

const chatRow = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  feature: 'chat',
  calls: 12,
  inputTokens: 12_000,
  outputTokens: 4_400,
  cacheReadTokens: 800,
  cacheWriteTokens: 0,
  costMicrocents: 4_200_000_000,
  unpricedCalls: 0,
}
const testRow = {
  provider: 'anthropic_compatible',
  model: 'accounts/fireworks/models/kimi-k2-instruct',
  feature: 'connection-test',
  calls: 2,
  inputTokens: 300,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  // A self-hosted model the price table does not know: shown as "—", counted as unpriced.
  costMicrocents: null,
  unpricedCalls: 2,
}

const DAY_MS = 24 * 60 * 60 * 1000

describe('Settings → Usage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('requests the last 30 days by default and renders totals + rows', async () => {
    const seen: URL[] = []
    stubFetch({
      '/api/ai/usage/summary': (_init: RequestInit | undefined, url: URL) => {
        seen.push(url)
        return summary(url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? '', [
          chatRow,
          testRow,
        ])
      },
    })
    renderWithProviders(<UsageSettings />, { session: makeSession() })

    expect(await screen.findByText('12,300')).toBeInTheDocument()
    expect(screen.getByText('4,500')).toBeInTheDocument()
    expect(screen.getByText('14')).toBeInTheDocument()
    // Priced rows → the fourth card is the cost, labelled an estimate, with the unpriced calls
    // named rather than silently dropped from the total.
    expect(screen.getByText('Cost (estimated)')).toBeInTheDocument()
    expect(screen.getAllByText('$42.0000').length).toBeGreaterThan(0) // total card + the chat row
    expect(screen.getByText(/2 call\(s\) use a model with no price/)).toBeInTheDocument()
    // The unknown model's own row shows a dash, not a made-up number.
    const rows = screen.getAllByRole('row')
    const unpriced = rows.find(r => r.textContent?.includes('kimi-k2-instruct'))
    expect(unpriced?.textContent).toContain('—')

    expect(screen.getByText('chat')).toBeInTheDocument()
    expect(screen.getByText('connection-test')).toBeInTheDocument()
    // Long model ids are shortened to their last segment
    expect(screen.getByText('kimi-k2-instruct')).toBeInTheDocument()

    const url = seen[0]
    const from = new Date(url.searchParams.get('from') ?? '')
    const to = new Date(url.searchParams.get('to') ?? '')
    expect(Math.round((to.getTime() - from.getTime()) / DAY_MS)).toBe(30)
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('switches presets and shows the empty state for a quiet window', async () => {
    const seen: URL[] = []
    stubFetch({
      '/api/ai/usage/summary': (_init: RequestInit | undefined, url: URL) => {
        seen.push(url)
        const from = new Date(url.searchParams.get('from') ?? '')
        const to = new Date(url.searchParams.get('to') ?? '')
        const days = Math.round((to.getTime() - from.getTime()) / DAY_MS)
        return summary(from.toISOString(), to.toISOString(), days === 7 ? [] : [chatRow])
      },
    })
    renderWithProviders(<UsageSettings />, { session: makeSession() })
    expect(await screen.findByText('chat')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '7 days' }))
    expect(await screen.findByText('No AI usage in this period')).toBeInTheDocument()
    await waitFor(() => expect(seen).toHaveLength(2))
    const [, second] = seen
    const window7 = usageWindow(7)
    expect(second.searchParams.get('from')?.slice(0, 10)).toBe(window7.from.slice(0, 10))
    expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true')
  })
})

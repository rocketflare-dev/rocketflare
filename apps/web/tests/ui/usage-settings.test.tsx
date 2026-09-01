/**
 * Settings → Usage (D18): the 30-day default requests `from`/`to`, renders totals and the
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
        costMicrocents: null,
      }
    : {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicrocents: null,
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
  costMicrocents: null,
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
  costMicrocents: null,
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
    // No pricing supplied → the fourth card is the cache figures, not a cost
    expect(screen.getByText('Cache read / write')).toBeInTheDocument()
    expect(screen.queryByText('Cost')).not.toBeInTheDocument()

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

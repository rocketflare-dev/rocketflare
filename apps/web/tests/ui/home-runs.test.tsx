/**
 * Home's agents area: the fortnight's headline, the chart, the newest runs (a failed one with its
 * error, a succeeded one quiet), a clicked day narrowing the list through the runs route
 * (`since`/`until`), each agent's own line, and — with no runs — the onboarding that starts one.
 * The agent is the test fixture.
 */
import type { HomeSummary } from '@rocketflare/shared/home'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/ui/lib/query-keys'
import HomeRuns, { chartDays, runHeadline, runMeta } from '@/ui/pages/agents/HomeRuns'
import { FIXTURE_AGENT } from '../helpers/fixture-agents'
import {
  IDS,
  makeSession,
  makeTenant,
  paged,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)

const RUN_A = '99999999-9999-4999-8999-999999999991'
const RUN_B = '99999999-9999-4999-8999-999999999992'
const at = '2025-06-01T10:00:00.000Z'

const days = Array.from({ length: 14 }, (_, i) => ({
  date: `2025-05-${String(i + 19).padStart(2, '0')}`.replace('2025-05-32', '2025-06-01'),
  succeeded: i === 13 ? 3 : 0,
  failed: i === 13 ? 1 : 0,
  cancelled: 0,
  active: 0,
}))

const TODAY = days[13] as (typeof days)[number]

const AGENTS = {
  items: [
    {
      key: FIXTURE_AGENT,
      title: 'Fixture agent',
      description: 'A test fixture agent.',
      promptKey: FIXTURE_AGENT,
      exclusive: true,
      inputJsonSchema: {
        type: 'object',
        properties: { text: { type: 'string', title: 'Fixture text' } },
        required: ['text'],
      },
    },
  ],
}

const agentsPart = (
  part: Pick<NonNullable<HomeSummary['agents']>, 'days' | 'recent'>
): HomeSummary['agents'] => ({ previous: { runs: 1, succeeded: 1 }, byAgent: [], ...part })

function summary(agents: HomeSummary['agents']): HomeSummary {
  return { chat: null, agents, knowledge: null, team: null, spend: null, activity: null }
}

const homeRun = (id: string, status: string, error: string | null = null) => ({
  id,
  agentKey: FIXTURE_AGENT,
  agentTitle: 'Fixture agent',
  subject: 'Supply-chain risk in Q4',
  status,
  error,
  requestedBy: { name: 'Olivia Bennett', avatarUrl: null },
  createdAt: new Date(at),
  startedAt: new Date(at),
  finishedAt: new Date(Date.parse(at) + 52_000),
  tokens: 1234,
  costUsd: 0.004,
})

function render(
  data: HomeSummary,
  routes: Parameters<typeof stubFetch>[0] = {},
  session = makeSession()
) {
  const fetch = stubFetch({ 'GET /api/home/summary': data, ...routes })
  const result = renderWithProviders(<HomeRuns />, { session })
  result.queryClient.setQueryData(queryKeys.home.summary, data)
  return { fetch, ...result }
}

describe('HomeRuns', () => {
  it('leads with the fortnight in figures, then the chart, then the runs', async () => {
    render(
      summary(
        agentsPart({
          days,
          recent: [
            homeRun(RUN_A, 'failed', 'The model refused the request'),
            homeRun(RUN_B, 'succeeded'),
          ],
        })
      )
    )
    // One plain line in the panel header, no giant number and no sparkline repeating the chart.
    expect(
      await screen.findByText(
        '4 runs in 14 days · 75% succeeded · 1 failed · 3 more than the 14 days before'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /Runs per day/ })).not.toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: '4 runs in the last 14 days: 3 succeeded, 1 failed' })
    ).toBeInTheDocument()
    // A failed run says so and why; a succeeded one is quiet — a check, no badge.
    expect(screen.getByText('The model refused the request')).toBeInTheDocument()
    // Twice: on the meta line under the title when narrow, in its own column from sm up.
    expect(screen.getAllByText('Failed')).toHaveLength(2)
    expect(screen.queryByText('Succeeded')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Succeeded' })).toBeInTheDocument()
    // What it was about, who started it, what it took.
    expect(screen.getAllByText('· Supply-chain risk in Q4')).toHaveLength(2)
    expect(screen.getByText('Olivia · 52s · 1.2k tokens · $0.004')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /Fixture agent/ })[0]).toHaveAttribute(
      'href',
      `/agents/runs/${RUN_A}`
    )
  })

  it('narrows the list to a clicked day through the runs route, and clears it', async () => {
    const dayRun = {
      id: RUN_B,
      tenantId: IDS.tenant,
      agentKey: FIXTURE_AGENT,
      status: 'cancelled',
      input: { text: 'x' },
      output: null,
      error: null,
      requestedByUserId: IDS.user,
      instanceId: RUN_B,
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      createdAt: at,
    }
    const { fetch } = render(summary(agentsPart({ days, recent: [homeRun(RUN_A, 'succeeded')] })), {
      'GET /api/agents/runs': paged([dayRun], 6),
      'GET /api/agents': AGENTS,
    })
    const today = TODAY.date
    fireEvent.click(await screen.findByRole('button', { name: /: 4 runs, 3 succeeded, 1 failed$/ }))
    await waitFor(() => expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0))
    const url = fetch.mock.calls
      .map(([input]) => new URL(String(input), 'http://localhost'))
      .find(u => u.pathname === '/api/agents/runs')
    expect(url?.searchParams.get('since')).toBe(`${today}T00:00:00.000Z`)
    expect(url?.searchParams.get('until')).toBe(
      new Date(Date.parse(`${today}T00:00:00.000Z`) + 86_400_000).toISOString()
    )
    fireEvent.click(screen.getByRole('button', { name: /Show latest/ }))
    expect(await screen.findByRole('img', { name: 'Succeeded' })).toBeInTheDocument()
  })

  it('shows no chart for an empty fortnight, only a line and the latest runs', async () => {
    const empty = days.map(d => ({ ...d, succeeded: 0, failed: 0 }))
    render(summary(agentsPart({ days: empty, recent: [homeRun(RUN_A, 'succeeded')] })))
    expect(await screen.findByText(/No runs in the last 14 days/)).toBeInTheDocument()
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  it('lists each agent when more than one ran', async () => {
    const line = (agentTitle: string, runs: number) => ({
      agentKey: agentTitle,
      agentTitle,
      runs,
      failed: 0,
      lastRunAt: new Date(at),
      daily: days.map(() => 1),
    })
    render(
      summary({
        ...agentsPart({ days, recent: [homeRun(RUN_A, 'succeeded')] }),
        byAgent: [line('Fixture agent', 3), line('Other agent', 1)],
      } as HomeSummary['agents'])
    )
    expect(await screen.findByRole('heading', { name: 'By agent' })).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: 'Other agent: runs per day over the last 14 days' })
    ).toBeInTheDocument()
  })

  it('offers to start an agent when there are no runs', async () => {
    const empty = days.map(d => ({ ...d, succeeded: 0, failed: 0 }))
    render(summary(agentsPart({ days: empty, recent: [] })), { 'GET /api/agents': AGENTS })
    expect(await screen.findByText('Fixture agent', { selector: 'em' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fixture agent' }))
    expect(await screen.findByLabelText(/Fixture text/)).toBeInTheDocument()
  })

  it('renders nothing when the reader may not read runs', async () => {
    const { container } = render(
      summary(null),
      {},
      makeSession({ tenant: makeTenant({ role: 'member' }) })
    )
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('chartDays keeps the outcome counts as the series values', () => {
    expect(chartDays([TODAY])).toEqual([
      { date: TODAY.date, values: { succeeded: 3, failed: 1, cancelled: 0, active: 0 } },
    ])
  })

  it('runHeadline compares the fortnight with the one before', () => {
    const quiet = days.map(d => ({ ...d, succeeded: 0, failed: 0 }))
    expect(runHeadline({ days, previous: { runs: 0, succeeded: 0 } })).toMatchObject({
      runs: 4,
      failed: 1,
      successRate: 75,
      change: 'none in the 14 days before',
    })
    expect(runHeadline({ days: quiet, previous: { runs: 2, succeeded: 2 } })).toMatchObject({
      runs: 0,
      successRate: null,
      change: '2 fewer than the 14 days before',
    })
  })

  it('runMeta leaves out what the run did not record', () => {
    const run = homeRun(RUN_A, 'succeeded')
    expect(runMeta({ ...run, requestedBy: null, tokens: null, costUsd: null })).toBe('52s')
    expect(runMeta({ ...run, tokens: 800, costUsd: 0.25 })).toBe(
      'Olivia · 52s · 800 tokens · $0.25'
    )
  })
})

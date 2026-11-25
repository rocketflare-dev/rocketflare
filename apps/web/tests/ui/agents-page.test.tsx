/**
 * `/agents`: the registry renders with the exclusive badge; a 202 `deduplicated` answer
 * toasts and opens the existing run; a 503 `agent_runs_not_configured` renders the explanatory
 * empty state instead of a toast; the runs table shows status, agent and filters. The agent is the
 * test fixture (`tests/helpers/fixture-agents.ts`) with a schema-generated form; the example
 * agent's own hand-written form is tested in that example's own file.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared/Toast'
import AgentPage from '@/ui/pages/agents/AgentPage'
import AgentsPage from '@/ui/pages/agents/AgentsPage'
import AllRunsPage from '@/ui/pages/agents/AllRunsPage'
import RunPage from '@/ui/pages/agents/RunPage'
import { FIXTURE_AGENT } from '../helpers/fixture-agents'
import {
  errorResponse,
  IDS,
  jsonResponse,
  makeSession,
  paged,
  type RouteTable,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

vi.mock('@rocketflare/shared/plugins', async importOriginal =>
  (await import('../helpers/fixture-agents')).withFixtureShared(await importOriginal())
)

const now = '2025-06-01T00:00:00Z'
const RUN_ID = '99999999-9999-4999-8999-999999999999'

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

const run = (overrides: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  tenantId: IDS.tenant,
  agentKey: FIXTURE_AGENT,
  status: 'queued',
  input: { text: 'hello' },
  output: null,
  error: null,
  requestedByUserId: IDS.user,
  instanceId: RUN_ID,
  attempt: 0,
  startedAt: null,
  finishedAt: null,
  cancelRequestedAt: null,
  createdAt: now,
  ...overrides,
})

const stats = (overrides: Record<string, unknown> = {}) => ({
  since: '2025-05-02T00:00:00Z',
  items: [
    {
      agentKey: FIXTURE_AGENT,
      runs: 12,
      succeeded: 10,
      failed: 1,
      active: 1,
      tokens: 15300,
      costUsd: 0.0123,
      avgDurationMs: 42_000,
      lastRun: { id: RUN_ID, status: 'succeeded', createdAt: now, finishedAt: now },
      ...overrides,
    },
  ],
})

function mount(routes: RouteTable = {}, route = '/agents') {
  const fetchMock = stubFetch({
    '/api/agents': AGENTS,
    '/api/agents/runs': paged([]),
    '/api/agents/stats': stats(),
    '/api/agents/interrupts': paged([]),
    ...routes,
  })
  // The same route pair App.tsx mounts — two PAGES now, not one page and a drawer — so
  // `navigate('/agents/runs/:id')` really lands on the run workspace.
  renderWithProviders(
    <Routes>
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/agents/runs" element={<AllRunsPage />} />
      <Route path="/agents/:agentKey" element={<AgentPage />} />
      <Route path="/agents/runs/:runId" element={<RunPage />} />
    </Routes>,
    { session: makeSession(), route }
  )
  return fetchMock
}

describe('Agents page', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useToastStore.setState({ toasts: [] })
  })

  it('lists each agent once, with its last run and 30-day metrics, and no runs table', async () => {
    const fetchMock = mount()
    const table = await screen.findByRole('table', { name: 'Agents' })
    const row = within(table).getByText('Fixture agent').closest('tr') as HTMLElement
    expect(within(row).getByRole('link', { name: 'Fixture agent' })).toHaveAttribute(
      'href',
      `/agents/${FIXTURE_AGENT}`
    )
    expect(within(row).getByText('exclusive')).toBeInTheDocument()
    expect(await within(row).findByText('12 · 1 failed · 1 active')).toBeInTheDocument()
    expect(within(row).getByText(/^15\.3k$/i)).toBeInTheDocument()
    expect(within(row).getByText('42s')).toBeInTheDocument()
    expect(within(row).getByText('$0.0123')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Last run of Fixture agent' })).toHaveAttribute(
      'href',
      `/agents/runs/${RUN_ID}`
    )
    expect(screen.queryByRole('table', { name: 'Agent runs' })).toBeNull()
    // One request for every agent's metrics, never one per agent.
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/agents/stats'))
    ).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'All runs' })).toHaveAttribute('href', '/agents/runs')
  })

  it("an agent's page shows its metrics and only its runs", async () => {
    const fetchMock = mount(
      {
        '/api/agents/runs': paged([
          run({ status: 'succeeded', startedAt: now, finishedAt: '2025-06-01T00:00:04Z' }),
        ]),
      },
      `/agents/${FIXTURE_AGENT}`
    )
    expect(await screen.findByRole('heading', { name: 'Fixture agent' })).toBeInTheDocument()
    const metrics = await screen.findByLabelText('Agent metrics')
    expect(await within(metrics).findByText('12')).toBeInTheDocument()
    expect(within(metrics).getByText('10 succeeded · 1 failed')).toBeInTheDocument()
    const table = await screen.findByRole('table', { name: 'Agent runs' })
    expect(within(table).getByText('Succeeded')).toBeInTheDocument()
    expect(within(table).getByText('You')).toBeInTheDocument()
    expect(within(table).getByText('4s')).toBeInTheDocument()
    // Fixed to this agent: no agent filter, and every request names it.
    expect(screen.queryByLabelText('Agent')).toBeNull()
    const runCalls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter(u => u.includes('/api/agents/runs?'))
    expect(runCalls.length).toBeGreaterThan(0)
    expect(runCalls.every(u => u.includes(`agentKey=${FIXTURE_AGENT}`))).toBe(true)
  })

  it('an unknown agent key is an empty state, not a crash', async () => {
    mount({}, '/agents/no-such-agent')
    expect(await screen.findByText('No such agent')).toBeInTheDocument()
  })

  it('toasts and opens the existing run when the 202 is deduplicated', async () => {
    const fetchMock = mount({
      'POST /api/agents/runs': () => jsonResponse({ ...run(), deduplicated: true }, 202),
      [`/api/agents/runs/${RUN_ID}`]: { ...run(), events: [], interrupts: [], artifacts: [] },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Run Fixture agent' }))
    fireEvent.change(screen.getByLabelText(/Fixture text/), { target: { value: 'hello' } })
    fireEvent.submit(document.getElementById('run-agent-form') as HTMLFormElement)

    await waitFor(() =>
      expect(useToastStore.getState().toasts.map(t => t.message)).toContain(
        'This agent is already running — showing the existing run'
      )
    )
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes(`/api/agents/runs/${RUN_ID}`))
      ).toBe(true)
    )
  })

  it('renders the not-configured empty state on a 503 agent_runs_not_configured, without a toast', async () => {
    mount({
      'POST /api/agents/runs': () =>
        errorResponse(503, 'Agent runs are not configured', 'agent_runs_not_configured'),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Run Fixture agent' }))
    fireEvent.change(screen.getByLabelText(/Fixture text/), { target: { value: 'hello' } })
    fireEvent.submit(document.getElementById('run-agent-form') as HTMLFormElement)

    expect(await screen.findByText('Agent runs are not configured')).toBeInTheDocument()
    expect(screen.getByText(/AGENT_RUN_WORKFLOW/)).toBeInTheDocument()
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('all runs: sends the agent and status filters as query params', async () => {
    const fetchMock = mount({}, '/agents/runs')
    await screen.findByText('No runs yet')
    expect(screen.getByLabelText('Agent')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } })
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('status=failed'))).toBe(
        true
      )
    )
    const url = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find(u => u.includes('status=failed'))
    expect(url).toContain('/api/agents/runs?')
    expect(url).toContain('page=1')
  })
})

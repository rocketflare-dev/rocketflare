/**
 * `/agents` (D7): the registry renders with the exclusive badge; the run modal validates with the
 * shared input schema and posts the exact `{ agentKey, input }` body; a 202 `deduplicated` answer
 * toasts and opens the existing run; a 503 `agent_runs_not_configured` renders the explanatory
 * empty state instead of a toast; the runs table shows status, agent and filters.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared/Toast'
import AgentsPage from '@/ui/pages/agents/AgentsPage'
import {
  errorResponse,
  IDS,
  jsonResponse,
  makeSession,
  paged,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const now = '2025-06-01T00:00:00Z'
const RUN_ID = '99999999-9999-4999-8999-999999999999'

const AGENTS = {
  items: [
    {
      key: 'summarize-text',
      title: 'Summarize text',
      description: 'Summarises a block of text.',
      promptKey: 'summarize-text',
      exclusive: true,
    },
  ],
}

const run = (overrides: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  tenantId: IDS.tenant,
  agentKey: 'summarize-text',
  status: 'queued',
  input: { text: 'hello', style: 'bullets', index: false },
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

function mount(routes: RouteTable = {}, route = '/agents') {
  const fetchMock = stubFetch({
    '/api/agents': AGENTS,
    '/api/agents/runs': paged([]),
    ...routes,
  })
  // The same route pair App.tsx mounts, so `navigate('/agents/runs/:id')` opens the drawer.
  renderWithProviders(
    <Routes>
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/agents/runs/:runId" element={<AgentsPage />} />
    </Routes>,
    { session: makeSession(), route }
  )
  return fetchMock
}

const openDialog = () => document.querySelector('dialog[open]') as HTMLElement

describe('Agents page', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useToastStore.setState({ toasts: [] })
  })

  it('lists the registry with the exclusive badge and the runs table', async () => {
    mount({
      '/api/agents/runs': paged([
        run({ status: 'succeeded', startedAt: now, finishedAt: '2025-06-01T00:00:04Z' }),
      ]),
    })
    expect(await screen.findByText('Summarize text', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('exclusive')).toBeInTheDocument()
    const table = await screen.findByRole('table', { name: 'Agent runs' })
    expect(within(table).getByText('Succeeded')).toBeInTheDocument()
    expect(within(table).getByText('You')).toBeInTheDocument()
    expect(within(table).getByText('4s')).toBeInTheDocument()
    expect(screen.getByLabelText('Agent')).toHaveValue('')
    expect(screen.getByLabelText('Status')).toHaveValue('')
  })

  it('validates with the shared schema and posts the exact run body', async () => {
    const fetchMock = mount({
      'POST /api/agents/runs': (init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body)) as { input: unknown }
        return jsonResponse(run({ input: body.input }), 202)
      },
      [`/api/agents/runs/${RUN_ID}`]: { ...run(), events: [] },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize text' }))
    const form = document.getElementById('run-agent-form') as HTMLFormElement
    expect(openDialog()).toBeTruthy()

    // Empty text → a field error, no request
    fireEvent.submit(form)
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0)
    expect(requestBody(fetchMock, 'POST /api/agents/runs')).toBeUndefined()

    fireEvent.change(screen.getByLabelText('Text to summarise'), {
      target: { value: '  Some long text  ' },
    })
    fireEvent.change(screen.getByLabelText('Style'), { target: { value: 'paragraph' } })
    fireEvent.click(screen.getByLabelText('Index the result for search'))
    fireEvent.submit(form)

    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/agents/runs')).toEqual({
        agentKey: 'summarize-text',
        // Trimmed by the shared schema; defaults applied
        input: { text: 'Some long text', style: 'paragraph', index: true },
      })
    )
    // Navigated to the run: the detail drawer loads it
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes(`/api/agents/runs/${RUN_ID}`))
      ).toBe(true)
    )
  })

  it('toasts and opens the existing run when the 202 is deduplicated', async () => {
    const fetchMock = mount({
      'POST /api/agents/runs': () => jsonResponse({ ...run(), deduplicated: true }, 202),
      [`/api/agents/runs/${RUN_ID}`]: { ...run(), events: [] },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize text' }))
    fireEvent.change(screen.getByLabelText('Text to summarise'), { target: { value: 'hello' } })
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
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize text' }))
    fireEvent.change(screen.getByLabelText('Text to summarise'), { target: { value: 'hello' } })
    fireEvent.submit(document.getElementById('run-agent-form') as HTMLFormElement)

    expect(await screen.findByText('Agent runs are not configured')).toBeInTheDocument()
    expect(screen.getByText(/AGENT_RUN_WORKFLOW/)).toBeInTheDocument()
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('sends the agent and status filters as query params', async () => {
    const fetchMock = mount()
    await screen.findByText('No runs yet')
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

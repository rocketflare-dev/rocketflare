/**
 * The `summarize-text` example's hand-written run form (`forms/summarize-text.tsx`) on `/agents`:
 * it validates with the shared `summarizeTextInputSchema` and posts the exact `{ agentKey, input }`
 * body, trimmed and with defaults filled. Part of the example's surface — deleting the example
 * deletes this file; the page itself is `agents-page.test.tsx`.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared/Toast'
import AgentsPage from '@/ui/pages/agents/AgentsPage'
import RunPage from '@/ui/pages/agents/RunPage'
import {
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
  // The same route pair App.tsx mounts — two PAGES now, not one page and a drawer — so
  // `navigate('/agents/runs/:id')` really lands on the run workspace.
  renderWithProviders(
    <Routes>
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/agents/runs/:runId" element={<RunPage />} />
    </Routes>,
    { session: makeSession(), route }
  )
  return fetchMock
}

const openDialog = () => document.querySelector('dialog[open]') as HTMLElement

describe('the summarize-text run form', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useToastStore.setState({ toasts: [] })
  })

  it('validates with the shared schema and posts the exact run body', async () => {
    const fetchMock = mount({
      'POST /api/agents/runs': (init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body)) as { input: unknown }
        return jsonResponse(run({ input: body.input }), 202)
      },
      [`/api/agents/runs/${RUN_ID}`]: { ...run(), events: [], interrupts: [], artifacts: [] },
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
})

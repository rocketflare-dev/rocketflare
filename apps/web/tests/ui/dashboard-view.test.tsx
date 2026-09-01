/**
 * `/analytics/:pageId` (D19): the edit toggle turns the library dashboard editable, a config
 * change autosaves as ONE debounced whole-config PATCH (not per keystroke), the page's date range
 * reaches the dashboard as an override of the template's universal-time filter, "Reset to
 * template" confirms then POSTs `/reset`, template pages offer no delete (user pages no reset),
 * and members get no admin controls. drizzle-cube itself is stood in for: the real
 * `AnalyticsDashboard` needs a Cube API — the stand-in records its props and exposes buttons that
 * fire the same callbacks.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared/Toast'
import DashboardViewPage from '@/ui/pages/analytics/DashboardViewPage'
import { analyticsPage, customPage, PAGE_IDS } from './helpers/analytics'
import {
  jsonResponse,
  makeSession,
  makeTenant,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

type FakeConfig = { portlets: { id: string }[]; [k: string]: unknown }
type FakeProps = {
  config: FakeConfig
  editable?: boolean
  dashboardFilters?: { id: string; filter: { values: unknown[] } }[]
  onConfigChange?: (c: FakeConfig) => void
  onSave?: (c: FakeConfig) => Promise<void> | void
}

vi.mock('drizzle-cube/client/styles.css', () => ({}))
vi.mock('drizzle-cube/client/providers', () => ({
  CubeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="cube-provider">{children}</div>
  ),
}))
vi.mock('drizzle-cube/client', () => ({
  AnalyticsDashboard: (props: FakeProps) => (
    <div
      data-testid="analytics-dashboard"
      data-editable={String(Boolean(props.editable))}
      data-portlets={props.config.portlets.length}
      data-filters={JSON.stringify(props.dashboardFilters ?? [])}
    >
      <button
        type="button"
        onClick={() =>
          props.onConfigChange?.({
            ...props.config,
            portlets: [...props.config.portlets, { id: `p${props.config.portlets.length + 1}` }],
          })
        }
      >
        fake-add-portlet
      </button>
      <button type="button" onClick={() => props.onSave?.(props.config)}>
        fake-save
      </button>
    </div>
  ),
}))

function mount(page: Record<string, unknown>, routes: RouteTable = {}, session = makeSession()) {
  const id = page.id as string
  const fetchMock = stubFetch({
    [`/api/analytics/pages/${id}`]: page,
    [`PATCH /api/analytics/pages/${id}`]: (init: RequestInit | undefined) => {
      const patch = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({ ...page, ...patch, updatedAt: '2025-06-02T00:00:00Z' })
    },
    ...routes,
  })
  renderWithProviders(
    <Routes>
      <Route path="/analytics/:pageId" element={<DashboardViewPage />} />
      <Route path="/analytics" element={<div>list page</div>} />
    </Routes>,
    { session, route: `/analytics/${id}` }
  )
  return fetchMock
}

const patchCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')

describe('Dashboard view page', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useToastStore.setState({ toasts: [] })
  })

  it('renders the dashboard read-only with the date range applied to the universal-time filter', async () => {
    mount(analyticsPage())
    const dash = await screen.findByTestId('analytics-dashboard')
    expect(dash).toHaveAttribute('data-editable', 'false')
    expect(dash).toHaveAttribute('data-portlets', '1')
    // Default preset is 90 days; only the isUniversalTime filter is overridden
    const filters = JSON.parse(
      dash.getAttribute('data-filters') ?? '[]'
    ) as FakeProps['dashboardFilters']
    expect(filters).toHaveLength(1)
    expect(filters?.[0]).toMatchObject({ id: 'time-filter', filter: { values: ['last 90 days'] } })
    expect(screen.getByTestId('cube-provider')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }))
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId('analytics-dashboard').getAttribute('data-filters') ?? '[]')
      ).toMatchObject([{ filter: { values: ['last 7 days'] } }])
    )
  })

  it('edit mode → onConfigChange → one debounced PATCH of the whole config', async () => {
    const fetchMock = mount(analyticsPage())
    await screen.findByTestId('analytics-dashboard')

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    expect(screen.getByTestId('analytics-dashboard')).toHaveAttribute('data-editable', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'fake-add-portlet' }))
    fireEvent.click(screen.getByRole('button', { name: 'fake-add-portlet' }))
    // Local state moves at once; nothing is saved yet
    expect(screen.getByTestId('analytics-dashboard')).toHaveAttribute('data-portlets', '3')
    expect(screen.getByTestId('dashboard-loader')).toHaveAttribute('data-dirty', 'true')
    expect(patchCalls(fetchMock)).toHaveLength(0)

    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1), { timeout: 4000 })
    const body = requestBody(fetchMock, `PATCH /api/analytics/pages/${PAGE_IDS.template}`) as {
      config: { portlets: unknown[] }
    }
    expect(Object.keys(body)).toEqual(['config'])
    expect(body.config.portlets).toHaveLength(3)
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-loader')).toHaveAttribute('data-dirty', 'false')
    )
  })

  it("the editor's explicit save flushes immediately", async () => {
    const fetchMock = mount(analyticsPage())
    await screen.findByTestId('analytics-dashboard')
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'fake-save' }))
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1), { timeout: 1000 })
  })

  it('template page: reset confirms then POSTs /reset; no delete offered', async () => {
    const fetchMock = mount(analyticsPage(), {
      [`POST /api/analytics/pages/${PAGE_IDS.template}/reset`]: analyticsPage({
        updatedAt: '2025-06-03T00:00:00Z',
      }),
    })
    await screen.findByTestId('analytics-dashboard')
    fireEvent.click(screen.getByLabelText('More actions'))
    expect(screen.queryByRole('button', { name: /Delete dashboard/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Reset to template/ }))
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/reset'))).toBe(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => String(input).endsWith('/reset') && init?.method === 'POST'
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map(t => t.message)).toContain(
        'Dashboard reset to its template'
      )
    )
  })

  it('user-created page: delete confirms, DELETEs and returns to the list; no reset offered', async () => {
    const fetchMock = mount(customPage(), {
      [`DELETE /api/analytics/pages/${PAGE_IDS.custom}`]: new Response(null, { status: 204 }),
    })
    await screen.findByTestId('analytics-dashboard')
    fireEvent.click(screen.getByLabelText('More actions'))
    expect(screen.queryByRole('button', { name: /Reset to template/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Delete dashboard/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    )
    expect(await screen.findByText('list page')).toBeInTheDocument()
  })

  it('members see the dashboard but none of the admin controls', async () => {
    mount(analyticsPage(), {}, makeSession({ tenant: makeTenant({ role: 'member' }) }))
    await screen.findByTestId('analytics-dashboard')
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('More actions')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toBeInTheDocument()
  })
})

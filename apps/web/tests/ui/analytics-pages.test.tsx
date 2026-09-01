/**
 * `/analytics` list (D19): the default page is listed first regardless of server order; "New
 * dashboard" posts the shared create body (blank, or with the chosen template's config copied
 * from the registry); admin-only controls (create, recreate, fact-table badges) are hidden for
 * members and the admin-only status request is never made for them.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listTemplates } from '@/dashboards'
import { useToastStore } from '@/ui/components/shared/Toast'
import DashboardListPage from '@/ui/pages/analytics/DashboardListPage'
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

const FACTS = {
  items: [{ table: 'tenant_activity_daily_facts', refreshedAt: null, lagSeconds: 0, stale: false }],
}

function mount(routes: RouteTable = {}, session = makeSession()) {
  const fetchMock = stubFetch({
    // Server order: custom (order 100) after template — but the DEFAULT flag is on the custom one
    '/api/analytics/pages': {
      items: [analyticsPage({ isDefault: false }), customPage({ isDefault: true })],
    },
    '/api/analytics/templates': {
      items: listTemplates().map(t => ({ key: t.key, name: t.name, description: t.description })),
    },
    '/api/analytics/facts/status': FACTS,
    ...routes,
  })
  renderWithProviders(<DashboardListPage />, { session, route: '/analytics' })
  return fetchMock
}

describe('Analytics list page', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useToastStore.setState({ toasts: [] })
  })

  it('lists the default dashboard first and marks templates', async () => {
    mount()
    const list = await screen.findByRole('list', { name: 'Dashboards' })
    const cards = within(list).getAllByTestId('dashboard-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveTextContent('Sales')
    expect(within(cards[0]).getByText('Default')).toBeInTheDocument()
    expect(cards[1]).toHaveTextContent('Organisation Overview')
    expect(within(cards[1]).getByText('Template')).toBeInTheDocument()
    expect(cards[1]).toHaveAttribute('href', `/analytics/${PAGE_IDS.template}`)
  })

  it('creates a dashboard from the form — blank, or from a template config', async () => {
    const fetchMock = mount({
      'POST /api/analytics/pages': (init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body)) as { name: string }
        return jsonResponse(customPage({ name: body.name }), 201)
      },
    })
    await screen.findByRole('list', { name: 'Dashboards' })

    fireEvent.click(screen.getByRole('button', { name: /New dashboard/ }))
    const form = document.getElementById('dashboard-form') as HTMLFormElement
    // Empty name → validation error, no request
    fireEvent.submit(form)
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0)
    expect(requestBody(fetchMock, 'POST /api/analytics/pages')).toBeUndefined()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Sales  ' } })
    fireEvent.submit(form)
    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/analytics/pages')).toEqual({
        name: 'Sales',
        description: null,
      })
    )
  })

  it('copies the template config when "start from" a template is chosen', async () => {
    const [template] = listTemplates()
    const fetchMock = mount({
      'POST /api/analytics/pages': () => jsonResponse(customPage(), 201),
    })
    await screen.findByRole('list', { name: 'Dashboards' })
    fireEvent.click(screen.getByRole('button', { name: /New dashboard/ }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Overview copy' } })
    fireEvent.change(screen.getByLabelText('Start from'), { target: { value: template.key } })
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'A copy' } })
    fireEvent.submit(document.getElementById('dashboard-form') as HTMLFormElement)

    await waitFor(() => expect(requestBody(fetchMock, 'POST /api/analytics/pages')).toBeDefined())
    const body = requestBody(fetchMock, 'POST /api/analytics/pages') as {
      name: string
      description: string
      config: { portlets: unknown[] }
    }
    expect(body.name).toBe('Overview copy')
    expect(body.description).toBe('A copy')
    expect(body.config.portlets).toHaveLength(template.config.portlets.length)
  })

  it('shows fact-table freshness and "Recreate templates" to admins', async () => {
    const fetchMock = mount({
      'POST /api/analytics/templates/recreate': { created: 0, reset: 1 },
    })
    await screen.findByRole('list', { name: 'Dashboards' })
    const facts = await screen.findByRole('region', { name: 'Fact tables' })
    expect(facts).toHaveTextContent('tenant_activity_daily_facts')
    expect(facts).toHaveTextContent('empty')

    fireEvent.click(screen.getByRole('button', { name: /Recreate templates/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Recreate' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith('/api/analytics/templates/recreate') && init?.method === 'POST'
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map(t => t.message)).toContain(
        'Templates recreated: 0 created, 1 reset'
      )
    )
  })

  it('hides every admin control from a member and never asks for fact-table status', async () => {
    const fetchMock = mount({}, makeSession({ tenant: makeTenant({ role: 'member' }) }))
    await screen.findByRole('list', { name: 'Dashboards' })
    expect(screen.queryByRole('button', { name: /New dashboard/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Recreate templates/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Fact tables' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Explore/ })).toHaveAttribute(
      'href',
      '/analytics/explore'
    )
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/api/analytics/facts/status'))
    ).toBe(false)
  })
})

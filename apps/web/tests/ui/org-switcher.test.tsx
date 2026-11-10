import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrgSwitcher } from '@/ui/components/OrgSwitcher'
import {
  IDS,
  makeSession,
  makeTenant,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const beta = makeTenant({ id: IDS.otherTenant, name: 'Beta', slug: 'beta', role: 'member' })

function Where() {
  const location = useLocation()
  return <span data-testid="path">{location.pathname}</span>
}

describe('OrgSwitcher', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is hidden in single-tenant mode even with several memberships', () => {
    renderWithProviders(<OrgSwitcher />, {
      session: makeSession({ tenancyMode: 'single', tenants: [makeTenant(), beta] }),
    })
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('Acme')).not.toBeInTheDocument()
  })

  it('with no active tenant it says so instead of offering a switch', () => {
    renderWithProviders(<OrgSwitcher />, { session: makeSession({ tenant: null, tenants: [] }) })
    expect(screen.queryByText('Your organisations')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('No organisation')).toBeInTheDocument()
  })

  it('multi mode with one org still shows, offering to create another', () => {
    renderWithProviders(<OrgSwitcher />, { session: makeSession() })
    expect(screen.getByLabelText('Organisation: Acme')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Create organisation/ })).toHaveAttribute(
      'href',
      '/select-tenant?create=1'
    )
  })

  it('offers no "Create organisation" when the session says the server would refuse it', () => {
    renderWithProviders(<OrgSwitcher />, {
      session: makeSession({ canCreateTenant: false, tenants: [makeTenant(), beta] }),
    })
    expect(screen.getByLabelText('Organisation: Acme')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Create organisation/ })).not.toBeInTheDocument()
  })

  it('with one org and creation refused, there is nothing to switch to and it renders nothing', () => {
    renderWithProviders(<OrgSwitcher />, { session: makeSession({ canCreateTenant: false }) })
    expect(screen.queryByLabelText('Organisation: Acme')).not.toBeInTheDocument()
  })

  it('lists memberships and switches via POST /auth/select-tenant, landing on /', async () => {
    const next = makeSession({ tenant: beta, tenants: [makeTenant(), beta] })
    const fetchMock = stubFetch({ 'POST /auth/select-tenant': next })
    renderWithProviders(
      <Routes>
        <Route
          path="/settings"
          element={
            <>
              <OrgSwitcher />
              <Where />
            </>
          }
        />
        <Route
          path="/"
          element={
            <>
              <OrgSwitcher />
              <Where />
            </>
          }
        />
      </Routes>,
      { route: '/settings', session: makeSession({ tenants: [makeTenant(), beta] }) }
    )
    expect(screen.getByText('@beta')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Beta/ }))
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/'))
    expect(requestBody(fetchMock, 'POST /auth/select-tenant')).toEqual({
      tenantId: IDS.otherTenant,
    })
    console.log(
      'DEBUG',
      Array.from(document.querySelectorAll('summary')).map(s => s.getAttribute('aria-label')),
      document.body.textContent
    )
    // The header now names the new organisation
    await waitFor(() => expect(screen.getByLabelText('Organisation: Beta')).toBeInTheDocument())
  })
})

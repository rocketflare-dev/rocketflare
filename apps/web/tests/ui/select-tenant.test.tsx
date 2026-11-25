/**
 * `/select-tenant` offers "Create organisation" only when the session's `canCreateTenant` says the
 * server would allow it — never under IdP-managed tenancy or while access is pending, including
 * through the `?create=1` deep link the org switcher uses.
 */
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SelectTenant from '@/ui/pages/SelectTenant'
import {
  makeSession,
  makeTenant,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

describe('SelectTenant and creating an organisation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('offers to create one when the server allows it', () => {
    stubFetch()
    renderWithProviders(<SelectTenant />, { session: makeSession(), route: '/select-tenant' })
    expect(screen.getByRole('button', { name: /Create organisation/ })).toBeInTheDocument()
  })

  it('lists memberships without the create button when the server would refuse it', () => {
    stubFetch()
    renderWithProviders(<SelectTenant />, {
      session: makeSession({ canCreateTenant: false, tenants: [makeTenant()] }),
      route: '/select-tenant',
    })
    expect(screen.getByText('Choose an organisation')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create organisation/ })).not.toBeInTheDocument()
  })

  it('?create=1 does not open the form when creation is refused', () => {
    stubFetch()
    renderWithProviders(<SelectTenant />, {
      session: makeSession({ canCreateTenant: false, tenant: null, tenants: [] }),
      route: '/select-tenant?create=1',
    })
    expect(screen.queryByLabelText(/Organisation name|Name/)).not.toBeInTheDocument()
    expect(screen.getByText('Ask an administrator to add you to one.')).toBeInTheDocument()
  })
})

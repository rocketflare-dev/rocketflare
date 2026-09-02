/**
 * `/no-access` and `/pending` for a global admin with no membership: both offer "Open the admin
 * area" (→ `/admin`, the one shell path `ProtectedRoute` lets through without a tenant); a plain
 * user never sees it.
 */
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NoAccess from '@/ui/pages/NoAccess'
import Pending from '@/ui/pages/Pending'
import {
  makeSession,
  makeUser,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

const globalAdminAlone = () =>
  makeSession({ user: makeUser({ isGlobalAdmin: true }), tenant: null, tenants: [] })

describe('no-tenant holding pages', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('/no-access: a global admin gets a way into /admin', () => {
    stubFetch({ '/api/invitations/pending': { items: [] } })
    renderWithProviders(<NoAccess />, { session: globalAdminAlone(), route: '/no-access' })
    expect(screen.getByRole('link', { name: 'Open the admin area' })).toHaveAttribute(
      'href',
      '/admin'
    )
  })

  it('/no-access: a plain user does not', () => {
    stubFetch({ '/api/invitations/pending': { items: [] } })
    renderWithProviders(<NoAccess />, {
      session: makeSession({ tenant: null, tenants: [] }),
      route: '/no-access',
    })
    expect(screen.queryByRole('link', { name: 'Open the admin area' })).not.toBeInTheDocument()
  })

  it('/pending: a global admin gets the same link, above the request form', () => {
    stubFetch()
    renderWithProviders(<Pending />, {
      session: { ...globalAdminAlone(), signupMode: 'approval' },
      route: '/pending',
    })
    expect(screen.getByRole('link', { name: 'Open the admin area' })).toHaveAttribute(
      'href',
      '/admin'
    )
    expect(screen.getByRole('button', { name: /Send request/ })).toBeInTheDocument()
  })
})

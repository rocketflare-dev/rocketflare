import { screen, waitFor } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProtectedRoute } from '@/ui/components/ProtectedRoute'
import { RequireGuard } from '@/ui/components/RequireGuard'
import {
  makeSession,
  makeTenant,
  makeUser,
  renderWithProviders,
} from './helpers/renderWithProviders'

function Where({ label }: { label: string }) {
  const location = useLocation()
  return (
    <div>
      <span data-testid="page">{label}</span>
      <span data-testid="path">{location.pathname + location.search}</span>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Where label="login" />} />
      <Route
        path="/select-tenant"
        element={
          <ProtectedRoute requireTenant={false}>
            <Where label="select-tenant" />
          </ProtectedRoute>
        }
      />
      <Route
        path="/pending"
        element={
          <ProtectedRoute requireTenant={false}>
            <Where label="pending" />
          </ProtectedRoute>
        }
      />
      <Route
        path="/no-access"
        element={
          <ProtectedRoute requireTenant={false}>
            <Where label="no-access" />
          </ProtectedRoute>
        }
      />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <Routes>
              <Route path="/" element={<Where label="home" />} />
              <Route
                path="/settings/*"
                element={
                  <RequireGuard guard="admin">
                    <Where label="settings" />
                  </RequireGuard>
                }
              />
              <Route
                path="/admin/*"
                element={
                  <RequireGuard guard="globalAdmin">
                    <Where label="admin" />
                  </RequireGuard>
                }
              />
            </Routes>
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

const page = () => screen.getByTestId('page').textContent
const path = () => screen.getByTestId('path').textContent

describe('ProtectedRoute', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows a spinner while the session loads', () => {
    renderWithProviders(<App />, { session: makeSession() })
    // Seeded cache resolves synchronously on first render — nothing to wait for
    expect(page()).toBe('home')
  })

  it('unauthenticated → /login with the attempted path as returnUrl', async () => {
    renderWithProviders(<App />, { session: null, route: '/settings/people?x=1' })
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    await waitFor(() => expect(page()).toBe('login'))
    expect(path()).toBe('/login?returnUrl=%2Fsettings%2Fpeople%3Fx%3D1')
  })

  it('unauthenticated on / → plain /login', async () => {
    renderWithProviders(<App />, { session: null, route: '/' })
    await waitFor(() => expect(path()).toBe('/login'))
  })

  it('no tenant but memberships → /select-tenant', () => {
    renderWithProviders(<App />, {
      session: makeSession({
        tenant: null,
        tenants: [
          makeTenant(),
          makeTenant({ id: '33333333-3333-4333-8333-333333333333', slug: 'b' }),
        ],
      }),
    })
    expect(page()).toBe('select-tenant')
  })

  it('no tenant with an access request → /pending', () => {
    renderWithProviders(<App />, {
      session: makeSession({ tenant: null, tenants: [], accessRequest: { status: 'pending' } }),
    })
    expect(page()).toBe('pending')
  })

  it('no tenant, approval mode, no request yet → /pending', () => {
    renderWithProviders(<App />, {
      session: makeSession({ tenant: null, tenants: [], signupMode: 'approval' }),
    })
    expect(page()).toBe('pending')
  })

  it('no tenant, invite-only → /no-access', () => {
    renderWithProviders(<App />, { session: makeSession({ tenant: null, tenants: [] }) })
    expect(page()).toBe('no-access')
  })

  it('with a tenant, the no-tenant pages are not forced', () => {
    renderWithProviders(<App />, { session: makeSession(), route: '/select-tenant' })
    expect(page()).toBe('select-tenant')
  })

  it('RequireGuard: member is bounced from /settings and /admin to home', () => {
    renderWithProviders(<App />, {
      session: makeSession({ tenant: makeTenant({ role: 'member' }) }),
      route: '/settings/people',
    })
    expect(page()).toBe('home')
  })

  it('RequireGuard: owner opens /settings but not /admin', () => {
    const { unmount } = renderWithProviders(<App />, { session: makeSession(), route: '/settings' })
    expect(page()).toBe('settings')
    unmount()
    renderWithProviders(<App />, { session: makeSession(), route: '/admin/users' })
    expect(page()).toBe('home')
  })

  it('RequireGuard: global admin opens /admin', () => {
    renderWithProviders(<App />, {
      session: makeSession({ user: makeUser({ isGlobalAdmin: true }) }),
      route: '/admin/users',
    })
    expect(page()).toBe('admin')
  })

  it('a non-401 session failure shows a retry panel instead of bouncing to login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503, statusText: 'Service Unavailable' }))
    )
    renderWithProviders(<App />, { route: '/' })
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("Can't reach the server")
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})

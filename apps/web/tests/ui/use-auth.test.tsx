import { screen, waitFor } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noTenantRoute, useAuth } from '@/ui/hooks/useAuth'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'
import {
  makeSession,
  makeTenant,
  renderWithProviders,
  stubFetch,
  unauthorizedResponse,
} from './helpers/renderWithProviders'

function Probe() {
  const { status, user, tenant, tenancyMode, isGlobalAdmin } = useAuth()
  const location = useLocation()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? '-'}</span>
      <span data-testid="tenant">{tenant?.slug ?? '-'}</span>
      <span data-testid="mode">{tenancyMode}</span>
      <span data-testid="ga">{String(isGlobalAdmin)}</span>
      <span data-testid="path">{location.pathname + location.search}</span>
    </div>
  )
}

describe('useAuth', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is loading, then unauthenticated on 401', async () => {
    renderWithProviders(<Probe />, { session: null })
    expect(screen.getByTestId('status')).toHaveTextContent('loading')
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    expect(screen.getByTestId('mode')).toHaveTextContent('multi')
  })

  it('exposes the parsed session when signed in', async () => {
    renderWithProviders(<Probe />, {
      session: makeSession({
        tenancyMode: 'single',
        user: { ...makeSession().user, isGlobalAdmin: true },
      }),
    })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    expect(screen.getByTestId('user')).toHaveTextContent('owner@example.test')
    expect(screen.getByTestId('tenant')).toHaveTextContent('acme')
    expect(screen.getByTestId('mode')).toHaveTextContent('single')
    expect(screen.getByTestId('ga')).toHaveTextContent('true')
  })

  it('fetches /auth/session with credentials when nothing is seeded', async () => {
    const fetchMock = stubFetch({ '/auth/session': makeSession() })
    renderWithProviders(<Probe />)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/auth/session')
    expect(init.credentials).toBe('include')
  })

  it('a 401 from any request while signed in clears the cache and redirects to /login?returnUrl=', async () => {
    stubFetch({ '/api/things': () => unauthorizedResponse() })
    const { queryClient } = renderWithProviders(<Probe />, {
      session: makeSession(),
      route: '/settings/people?tab=invites',
    })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    queryClient.setQueryData(['things'], { stale: true })

    await api.get('/api/things', { showErrorToast: false }).catch(() => {})

    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent(
        '/login?returnUrl=%2Fsettings%2Fpeople%3Ftab%3Dinvites'
      )
    )
    expect(queryClient.getQueryData(['things'])).toBeUndefined()
  })

  it('ignores a 401 when not signed in (no redirect loop on /login)', async () => {
    renderWithProviders(<Probe />, { session: null, route: '/login' })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    await api.get('/auth/session', { showErrorToast: false }).catch(() => {})
    await new Promise(r => setTimeout(r, 10))
    expect(screen.getByTestId('path')).toHaveTextContent('/login')
  })

  it('selectTenant swaps the session and empties the rest of the cache', async () => {
    const other = makeTenant({
      id: '33333333-3333-4333-8333-333333333333',
      slug: 'beta',
      role: 'member',
    })
    const next = makeSession({ tenant: other, tenants: [makeTenant(), other] })
    stubFetch({ 'POST /auth/select-tenant': next })
    const ref: { select: ((id: string) => Promise<unknown>) | null } = { select: null }
    function Selector() {
      ref.select = useAuth().selectTenant
      return <Probe />
    }
    const { queryClient } = renderWithProviders(<Selector />, { session: makeSession() })
    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('acme'))
    queryClient.setQueryData(queryKeys.members.all, [])

    await ref.select?.(other.id)

    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('beta'))
    expect(queryClient.getQueryData(queryKeys.members.all)).toBeUndefined()
  })
})

describe('noTenantRoute', () => {
  const base = { tenants: [], signupMode: 'invite_only' as const, accessRequest: null }
  it('routes by access request, then tenants, then signup mode', () => {
    expect(noTenantRoute({ ...base, accessRequest: { status: 'pending' } })).toBe('/pending')
    expect(noTenantRoute({ ...base, accessRequest: { status: 'rejected' } })).toBe('/pending')
    expect(noTenantRoute({ ...base, tenants: [makeTenant()] })).toBe('/select-tenant')
    expect(noTenantRoute({ ...base, signupMode: 'approval' })).toBe('/pending')
    expect(noTenantRoute(base)).toBe('/no-access')
    expect(noTenantRoute({ ...base, signupMode: 'open' })).toBe('/no-access')
  })
})

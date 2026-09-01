import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InviteAccept from '@/ui/pages/InviteAccept'
import {
  errorResponse,
  makeSession,
  makeTenant,
  makeUser,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const TOKEN = 'tok_abc123'
const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString()
const details = {
  email: 'owner@example.test',
  role: 'admin',
  status: 'pending',
  tenant: { name: 'Beta Corp', slug: 'beta' },
  invitedByName: 'Bea Boss',
  expiresAt: future,
}

function Where({ label }: { label: string }) {
  const location = useLocation()
  return (
    <span data-testid="path">
      {label}:{location.pathname + location.search}
    </span>
  )
}

function render(
  session: ReturnType<typeof makeSession> | null,
  routes: Parameters<typeof stubFetch>[0]
) {
  const fetchMock = stubFetch(routes)
  renderWithProviders(
    <Routes>
      <Route path="/invite/:token" element={<InviteAccept />} />
      <Route path="/login" element={<Where label="login" />} />
      <Route path="/" element={<Where label="home" />} />
    </Routes>,
    { route: `/invite/${TOKEN}`, session }
  )
  return fetchMock
}

describe('InviteAccept', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends a logged-out reader to /login with this page as returnUrl', async () => {
    render(null, { [`/api/invite/${TOKEN}`]: details })
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent(
        `login:/login?returnUrl=%2Finvite%2F${TOKEN}`
      )
    )
  })

  it('shows the invitation and accepts it, applying the returned session', async () => {
    const beta = makeTenant({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Beta Corp',
      slug: 'beta',
      role: 'admin',
    })
    const fetchMock = render(makeSession({ tenant: null, tenants: [] }), {
      [`/api/invite/${TOKEN}`]: details,
      [`POST /api/invite/${TOKEN}/accept`]: makeSession({ tenant: beta, tenants: [beta] }),
    })
    expect(await screen.findByText('Beta Corp')).toBeInTheDocument()
    expect(screen.getByText('admin')).toBeInTheDocument()
    expect(screen.getByText('Bea Boss')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('home:/'))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    expect(requestBody(fetchMock, `POST /api/invite/${TOKEN}/accept`)).toBeUndefined()
  })

  it('explains an email mismatch and offers to switch accounts instead of accepting', async () => {
    render(makeSession({ user: makeUser({ email: 'someone.else@example.test' }) }), {
      [`/api/invite/${TOKEN}`]: details,
    })
    expect(await screen.findByText('Different account')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out and switch account' })).toBeInTheDocument()
  })

  it('surfaces the accept error from the API envelope', async () => {
    render(makeSession(), {
      [`/api/invite/${TOKEN}`]: details,
      [`POST /api/invite/${TOKEN}/accept`]: () =>
        errorResponse(409, 'Already a member', 'conflict'),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Already a member')
  })

  it('renders expired / revoked / missing states', async () => {
    const { unmount } = (() => {
      render(makeSession(), {
        [`/api/invite/${TOKEN}`]: {
          ...details,
          status: 'expired',
          expiresAt: '2020-01-01T00:00:00Z',
        },
      })
      return { unmount: () => screen.getByText('Invitation expired') }
    })()
    expect(await screen.findByText('Invitation expired')).toBeInTheDocument()
    unmount()
  })

  it('a 404 token says the invitation does not exist', async () => {
    render(makeSession(), {
      [`/api/invite/${TOKEN}`]: () => errorResponse(404, 'Not found', 'not_found'),
    })
    expect(await screen.findByText('Invitation not found')).toBeInTheDocument()
    expect(screen.getByText(/does not exist or has been withdrawn/)).toBeInTheDocument()
  })
})

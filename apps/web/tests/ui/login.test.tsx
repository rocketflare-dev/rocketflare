import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hardNavigate } from '@/ui/lib/navigation'
import Login, { LOGIN_ERROR_COPY } from '@/ui/pages/Login'
import {
  makeSession,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

vi.mock('@/ui/lib/navigation', async importOriginal => {
  const mod = await importOriginal<typeof import('@/ui/lib/navigation')>()
  return { ...mod, hardNavigate: vi.fn() }
})

const ALL_METHODS = { magicLink: true, providers: ['google'], devLogin: true }

function Where() {
  const location = useLocation()
  return <span data-testid="path">{location.pathname}</span>
}

function render(
  route: string,
  methods: unknown = ALL_METHODS,
  extra: Parameters<typeof stubFetch>[0] = {}
) {
  const fetchMock = stubFetch({ '/auth/methods': methods, ...extra })
  const utils = renderWithProviders(
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="*" element={<Where />} />
    </Routes>,
    { route, session: null }
  )
  return { fetchMock, ...utils }
}

describe('Login', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(hardNavigate).mockReset()
  })

  it('renders only what /auth/methods enables', async () => {
    render('/login')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Continue with Google/ })).toBeInTheDocument()
    )
    expect(
      screen.queryByRole('button', { name: /Continue with Microsoft/ })
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(screen.getByText('Dev quick login')).toBeInTheDocument()
    for (const label of ['Owner', 'Admin', 'Member', 'Global admin']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('hides the magic-link form and dev panel when the server disables them', async () => {
    render('/login', { magicLink: false, providers: ['microsoft'], devLogin: false })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Continue with Microsoft/ })).toBeInTheDocument()
    )
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument()
    expect(screen.queryByText('Dev quick login')).not.toBeInTheDocument()
  })

  it('shows friendly copy for each ?error= code and a generic line otherwise', async () => {
    for (const code of Object.keys(LOGIN_ERROR_COPY)) {
      const { unmount } = render(`/login?error=${code}`)
      expect(screen.getByRole('alert')).toHaveTextContent(LOGIN_ERROR_COPY[code])
      unmount()
    }
    render('/login?error=something_else')
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in failed')
  })

  it('OAuth is a full-page redirect carrying returnUrl', async () => {
    render('/login?returnUrl=%2Fsettings')
    fireEvent.click(await screen.findByRole('button', { name: /Continue with Google/ }))
    expect(hardNavigate).toHaveBeenCalledWith('/auth/google?returnUrl=%2Fsettings')
  })

  it('magic link: validates with the shared schema, posts { email, redirectTo }, then shows "check your email"', async () => {
    const { fetchMock } = render('/login?returnUrl=%2Fsettings', ALL_METHODS, {
      'POST /auth/magic-link/request': () => new Response(null, { status: 202 }),
    })
    const input = await screen.findByLabelText('Email address')

    fireEvent.change(input, { target: { value: 'not-an-email' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(await screen.findByRole('alert')).toHaveTextContent(/email/i)
    expect(requestBody(fetchMock, 'POST /auth/magic-link/request')).toBeUndefined()

    fireEvent.change(input, { target: { value: 'Someone@Example.Test' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => expect(screen.getByText('Check your email')).toBeInTheDocument())
    expect(requestBody(fetchMock, 'POST /auth/magic-link/request')).toEqual({
      email: 'someone@example.test',
      redirectTo: '/settings',
    })
    expect(screen.getByText('someone@example.test')).toBeInTheDocument()
  })

  it('dev quick login posts the seeded email and hard-navigates to returnUrl', async () => {
    const { fetchMock } = render('/login?returnUrl=%2Fadmin', ALL_METHODS, {
      'POST /auth/dev-login': makeSession(),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Global admin' }))
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/admin'))
    expect(requestBody(fetchMock, 'POST /auth/dev-login')).toEqual({
      email: 'admin@gmgo.local',
      redirectTo: '/admin',
    })
  })

  it('an already signed-in reader is sent to returnUrl', async () => {
    stubFetch({ '/auth/methods': ALL_METHODS })
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Where />} />
      </Routes>,
      { route: '/login?returnUrl=%2Fprofile', session: makeSession() }
    )
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/profile'))
  })

  it('rejects an absolute returnUrl (open redirect) and falls back to /', async () => {
    stubFetch({ '/auth/methods': ALL_METHODS })
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Where />} />
      </Routes>,
      { route: '/login?returnUrl=https%3A%2F%2Fevil.example', session: makeSession() }
    )
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/'))
  })
})

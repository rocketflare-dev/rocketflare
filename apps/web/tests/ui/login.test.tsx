import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router'
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
      email: 'admin@rocketflare.local',
      redirectTo: '/admin',
    })
  })

  it('?as=<seeded email> signs in through dev-login once, on mount', async () => {
    const { fetchMock } = render('/login?as=owner%40example.test', ALL_METHODS, {
      'POST /auth/dev-login': makeSession(),
    })
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/'))
    expect(requestBody(fetchMock, 'POST /auth/dev-login')).toEqual({ email: 'owner@example.test' })
    const devLoginCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init?.method ?? 'GET').toUpperCase() === 'POST'
    )
    expect(devLoginCalls).toHaveLength(1)
  })

  it('?as= is ignored when dev login is off or the email is not a seeded account', async () => {
    const { fetchMock } = render('/login?as=owner%40example.test', {
      ...ALL_METHODS,
      devLogin: false,
    })
    await screen.findByRole('button', { name: /Continue with Google/ })
    expect(requestBody(fetchMock, 'POST /auth/dev-login')).toBeUndefined()
    expect(hardNavigate).not.toHaveBeenCalled()

    const { fetchMock: stranger } = render('/login?as=attacker%40evil.example', ALL_METHODS, {
      'POST /auth/dev-login': makeSession(),
    })
    await screen.findByText('Dev quick login')
    expect(requestBody(stranger, 'POST /auth/dev-login')).toBeUndefined()
    expect(hardNavigate).not.toHaveBeenCalled()
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

  describe('AUTH_OIDC_ONLY', () => {
    const OIDC_ONLY = {
      magicLink: true,
      providers: ['oidc'],
      devLogin: false,
      oidc: { label: 'Acme SSO' },
      oidcOnly: true,
    }

    it.each([
      ['on a first visit', '/login?returnUrl=%2Fdocuments', '%2Fdocuments'],
      ['after sign-out', '/login?signedOut=1', '%2F'],
      ['after a failure', '/login?error=oauth_failed', '%2F'],
    ])('never auto-redirects %s — one SSO button, a click away', async (_label, route, back) => {
      render(route, OIDC_ONLY)
      const button = await screen.findByRole('button', { name: 'Continue with Acme SSO' })
      expect(hardNavigate).not.toHaveBeenCalled()
      // Every other method is hidden (not disabled: the magic-link endpoint stays live).
      expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: /Continue with/ })).toHaveLength(1)
      fireEvent.click(button)
      expect(hardNavigate).toHaveBeenCalledWith(`/auth/oidc?returnUrl=${back}`)
      expect(hardNavigate).toHaveBeenCalledTimes(1)
    })

    it('without oidcOnly the SSO button sits beside the other methods with its label', async () => {
      render('/login', {
        ...ALL_METHODS,
        providers: ['google', 'oidc'],
        oidc: { label: 'Acme SSO' },
      })
      await screen.findByRole('button', { name: 'Continue with Acme SSO' })
      expect(screen.getByRole('button', { name: /Continue with Google/ })).toBeInTheDocument()
      expect(screen.getByLabelText('Email address')).toBeInTheDocument()
      expect(hardNavigate).not.toHaveBeenCalled()
    })
  })

  describe('plugin methods', () => {
    const PLUGIN_METHODS = {
      magicLink: false,
      providers: ['oidc'],
      devLogin: false,
      oidc: { label: 'Acme SSO' },
      oidcOnly: true,
      pluginMethods: [
        { id: 'sso:saml', label: 'Sign in with SAML', startPath: '/api/hooks/sso/start' },
        {
          id: 'sso:discover',
          label: 'Find my SSO',
          startPath: '/api/hooks/sso/discover',
          askEmail: true,
        },
      ],
    }

    it('render under oidcOnly too, and navigate to startPath with returnUrl', async () => {
      render('/login?returnUrl=%2Fdocuments', PLUGIN_METHODS)
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in with SAML' }))
      expect(hardNavigate).toHaveBeenCalledWith('/api/hooks/sso/start?returnUrl=%2Fdocuments')
      expect(screen.getByRole('button', { name: 'Continue with Acme SSO' })).toBeInTheDocument()
    })

    it('askEmail validates the address, then sends it as ?email=', async () => {
      render('/login', PLUGIN_METHODS)
      const input = await screen.findByLabelText('Work email for Find my SSO')
      fireEvent.click(screen.getByRole('button', { name: 'Find my SSO' }))
      expect(hardNavigate).not.toHaveBeenCalled()
      expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
      fireEvent.change(input, { target: { value: ' Jane@Acme.test ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Find my SSO' }))
      expect(hardNavigate).toHaveBeenCalledWith(
        '/api/hooks/sso/discover?returnUrl=%2F&email=jane%40acme.test'
      )
    })
  })

  describe('sso_required', () => {
    const METHODS = {
      ...ALL_METHODS,
      pluginMethods: [
        {
          id: 'sso:discover',
          label: 'Find my SSO',
          startPath: '/api/hooks/sso/discover',
          askEmail: true,
        },
      ],
    }

    it('offers the named plugin method directly, email prefilled, label from /auth/methods', async () => {
      render(
        '/login?error=sso_required&method=sso%3Adiscover&email=jane%40acme.test&returnUrl=%2Finvite%2Fabc',
        METHODS
      )
      expect(await screen.findByText(LOGIN_ERROR_COPY.sso_required as string)).toBeInTheDocument()
      const offered = await screen.findByTestId('sso-required-method')
      expect(offered).toHaveTextContent('Find my SSO')
      expect(screen.getAllByLabelText('Work email for Find my SSO')).toHaveLength(1)
      expect(screen.getByLabelText('Work email for Find my SSO')).toHaveValue('jane@acme.test')
      fireEvent.click(screen.getByRole('button', { name: 'Find my SSO' }))
      expect(hardNavigate).toHaveBeenCalledWith(
        '/api/hooks/sso/discover?returnUrl=%2Finvite%2Fabc&email=jane%40acme.test'
      )
    })

    it('an unknown method shows the message and no direct button', async () => {
      render('/login?error=sso_required&method=evil%3Ax', METHODS)
      expect(await screen.findByText(LOGIN_ERROR_COPY.sso_required as string)).toBeInTheDocument()
      expect(screen.queryByTestId('sso-required-method')).not.toBeInTheDocument()
    })

    it('dev login refused with 403 sso_required lands on the same screen', async () => {
      const devLoginRefusal = new Response(
        JSON.stringify({
          error: 'This organisation requires single sign-on',
          statusCode: 403,
          code: 'sso_required',
          details: { method: 'sso:discover' },
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
      render('/login', METHODS, { 'POST /auth/dev-login': devLoginRefusal })
      fireEvent.click(await screen.findByRole('button', { name: 'Owner' }))
      expect(await screen.findByTestId('sso-required-method')).toHaveTextContent('Find my SSO')
      expect(hardNavigate).not.toHaveBeenCalled()
    })
  })
})

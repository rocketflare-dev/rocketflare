/**
 * Profile → sign-in methods: "Connect" is a full-page round trip in LINK mode (`?link=1`), so the
 * provider identity attaches to the signed-in user rather than signing in as whoever it matches.
 */
import { fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { overrideHardNavigateForTests } from '@/ui/lib/navigation'
import Profile from '@/ui/pages/Profile'
import {
  makeSession,
  makeUser,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

// Full-page navigations are recorded here, not made (jsdom cannot navigate).
const hardNavigate = vi.fn()
beforeAll(() => overrideHardNavigateForTests(hardNavigate))
afterAll(() => overrideHardNavigateForTests(null))

describe('Profile → sign-in methods', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(hardNavigate).mockReset()
  })

  it('Connect starts the provider flow in link mode and returns to /profile', async () => {
    stubFetch({
      '/api/me': { ...makeUser(), preferences: {} },
      '/auth/methods': {
        magicLink: true,
        providers: ['google', 'oidc'],
        devLogin: false,
        oidc: { label: 'Acme SSO' },
        oidcOnly: false,
      },
      '/auth/providers': { providers: [{ provider: 'google', createdAt: '2025-06-01T00:00:00Z' }] },
    })
    renderWithProviders(<Profile />, { session: makeSession() })
    // Google is already linked; the OIDC issuer is offered under its configured label.
    expect(await screen.findByText('Acme SSO')).toBeInTheDocument()
    expect(screen.getByText('Connected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(hardNavigate).toHaveBeenCalledWith('/auth/oidc?link=1&returnUrl=%2Fprofile')
  })
})

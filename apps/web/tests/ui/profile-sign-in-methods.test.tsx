/**
 * Profile → sign-in methods: "Connect" is a full-page round trip in LINK mode (`?link=1`), so the
 * provider identity attaches to the signed-in user rather than signing in as whoever it matches.
 */
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hardNavigate } from '@/ui/lib/navigation'
import Profile from '@/ui/pages/Profile'
import {
  makeSession,
  makeUser,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

vi.mock('@/ui/lib/navigation', async importOriginal => {
  const mod = await importOriginal<typeof import('@/ui/lib/navigation')>()
  return { ...mod, hardNavigate: vi.fn() }
})

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

/**
 * `/magic-link/confirm` (D11): the emailed link lands here without spending the token. The page
 * must NOT submit on its own (a script-running mail scanner would spend it); the button posts a
 * native form carrying the token and redirectTo to `POST /auth/magic-link/verify`.
 */
import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MagicLinkConfirm from '@/ui/pages/MagicLinkConfirm'
import { renderWithProviders, stubFetch } from './helpers/renderWithProviders'

function renderAt(route: string) {
  const fetchMock = stubFetch()
  renderWithProviders(
    <Routes>
      <Route path="/magic-link/confirm" element={<MagicLinkConfirm />} />
      <Route path="/login" element={<p>login page</p>} />
    </Routes>,
    { session: null, route }
  )
  return fetchMock
}

describe('MagicLinkConfirm', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders a form that posts the token to the verify endpoint, and sends nothing itself', () => {
    const fetchMock = renderAt('/magic-link/confirm?token=tok123&redirectTo=%2Fchat')
    const button = screen.getByRole('button', { name: 'Sign in' })
    const form = button.closest('form') as HTMLFormElement
    expect(form).toHaveAttribute('method', 'post')
    expect(form).toHaveAttribute('action', '/auth/magic-link/verify')
    expect(Object.fromEntries(new FormData(form))).toEqual({ token: 'tok123', redirectTo: '/chat' })
    const calls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(calls.some(url => url.includes('/auth/magic-link/verify'))).toBe(false)
  })

  it('omits redirectTo when the link had none', () => {
    renderAt('/magic-link/confirm?token=tok123')
    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form') as HTMLFormElement
    expect(Object.fromEntries(new FormData(form))).toEqual({ token: 'tok123' })
  })

  it('no token → the login page with invalid_token', () => {
    renderAt('/magic-link/confirm')
    expect(screen.getByText('login page')).toBeInTheDocument()
  })
})

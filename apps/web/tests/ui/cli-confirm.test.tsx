/**
 * `/cli/confirm`: nothing is created until the person presses Continue; the POST's answer is where
 * the browser goes next, and Cancel creates nothing.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as navigation from '@/ui/lib/navigation'
import CliConfirm from '@/ui/pages/CliConfirm'
import { makeSession, renderWithProviders, stubFetch } from './helpers/renderWithProviders'

const QUERY =
  'redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback&hostname=laptop&state=the-state-value-1234'

function renderPage(query = QUERY) {
  const fetchMock = stubFetch({
    'POST /auth/cli/confirm': { redirectTo: 'http://127.0.0.1:8765/callback?key=k' },
  })
  renderWithProviders(
    <Routes>
      <Route path="/cli/confirm" element={<CliConfirm />} />
    </Routes>,
    { session: makeSession(), route: `/cli/confirm?${query}` }
  )
  return fetchMock
}

const posted = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/cli/confirm'))

describe('CliConfirm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends nothing until the person continues, and shows the port and key name', () => {
    const fetchMock = renderPage()
    expect(screen.getByText(/8765/)).toBeInTheDocument()
    expect(screen.getByText(/cli:laptop/)).toBeInTheDocument()
    expect(posted(fetchMock)).toHaveLength(0)
  })

  it('Continue posts the redirect URI and state, then navigates to the answer', async () => {
    const hardNavigate = vi.spyOn(navigation, 'hardNavigate').mockImplementation(() => {})
    const fetchMock = renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(hardNavigate).toHaveBeenCalled())
    expect(hardNavigate).toHaveBeenCalledWith('http://127.0.0.1:8765/callback?key=k')
    const body = JSON.parse(String(posted(fetchMock)[0]?.[1]?.body))
    expect(body).toEqual({
      redirectUri: 'http://127.0.0.1:8765/callback',
      hostname: 'laptop',
      state: 'the-state-value-1234',
    })
  })

  it('Cancel creates nothing', async () => {
    const fetchMock = renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Sign-in cancelled')).toBeInTheDocument()
    expect(posted(fetchMock)).toHaveLength(0)
  })

  it('a non-loopback target is not offered', () => {
    renderPage('redirect_uri=https%3A%2F%2Fother.example%2Fcallback')
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})

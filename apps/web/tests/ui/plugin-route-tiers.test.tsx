/**
 * The `fullscreen` plugin route tier, through the real route table in `App.tsx`: outside `Layout`,
 * and still behind sign-in, a tenant and the route's guard.
 */

import type { SessionResponse } from '@rocketflare/shared/auth'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '@/ui/App'
import { queryClient } from '@/ui/lib/queryClient'
import { makeSession, makeTenant, stubFetch, stubSessionFetch } from './helpers/renderWithProviders'

vi.mock('@/plugins/ui', async () => {
  const { lazy } = await import('react')
  const Page = (label: string) =>
    lazy(async () => ({ default: () => <div data-testid="plugin-page">{label}</div> }))
  const uiPlugins = [
    {
      shared: { id: 'fixture' },
      nav: [],
      homeLinks: [],
      routes: [
        { path: '/fixture/editor', tier: 'fullscreen', Component: Page('editor') },
        {
          path: '/fixture/guarded',
          tier: 'fullscreen',
          guard: 'admin',
          Component: Page('guarded'),
        },
        { path: '/fixture/shell', Component: Page('shell') },
      ],
    },
  ]
  return { uiPlugins, UI_PLUGINS: uiPlugins }
})
vi.mock('@/ui/components/Layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="layout">{children}</div>
  ),
}))
vi.mock('@/ui/components/WebSocketProvider', () => ({
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/ui/pages/Home', () => ({ default: () => <div data-testid="home" /> }))

function open(path: string, session: SessionResponse | null) {
  window.history.pushState({}, '', path)
  stubFetch()
  stubSessionFetch(session)
  render(<App />)
}

describe('fullscreen plugin routes', () => {
  afterEach(() => {
    queryClient.clear()
    vi.unstubAllGlobals()
  })

  it('renders the page outside Layout', async () => {
    open('/fixture/editor', makeSession())
    expect(await screen.findByTestId('plugin-page')).toHaveTextContent('editor')
    expect(screen.queryByTestId('layout')).not.toBeInTheDocument()
  })

  it('leaves a shell route inside Layout', async () => {
    open('/fixture/shell', makeSession())
    expect(await screen.findByTestId('plugin-page')).toHaveTextContent('shell')
    expect(screen.getByTestId('layout')).toBeInTheDocument()
  })

  it('sends a signed-out reader to login', async () => {
    open('/fixture/editor', null)
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(window.location.search).toContain(encodeURIComponent('/fixture/editor'))
    expect(screen.queryByTestId('plugin-page')).not.toBeInTheDocument()
  })

  it('sends a signed-in reader with no tenant away', async () => {
    open('/fixture/editor', makeSession({ tenant: null, tenants: [] }))
    await waitFor(() => expect(window.location.pathname).not.toBe('/fixture/editor'))
    expect(screen.queryByTestId('plugin-page')).not.toBeInTheDocument()
  })

  it('honours the guard: a member is sent home', async () => {
    open('/fixture/guarded', makeSession({ tenant: makeTenant({ role: 'member' }) }))
    expect(await screen.findByTestId('home')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
    expect(screen.queryByTestId('plugin-page')).not.toBeInTheDocument()
  })

  it('honours the guard: an admin opens the page', async () => {
    open('/fixture/guarded', makeSession({ tenant: makeTenant({ role: 'admin' }) }))
    expect(await screen.findByTestId('plugin-page')).toHaveTextContent('guarded')
    expect(screen.queryByTestId('layout')).not.toBeInTheDocument()
  })
})

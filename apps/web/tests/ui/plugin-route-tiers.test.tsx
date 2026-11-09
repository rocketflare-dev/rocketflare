/**
 * The `workspace` plugin route tier, through the real route table in `App.tsx` and the real
 * `Layout`: inside the shell, nav on its icon rail without touching the saved preference, and
 * still behind sign-in, a tenant and the route's guard.
 */

import type { SessionResponse } from '@rocketflare/shared/auth'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '@/ui/App'
import { queryClient } from '@/ui/lib/queryClient'
import { makeSession, makeTenant, stubFetch, stubSessionFetch } from './helpers/renderWithProviders'

vi.mock('@/plugins/ui', async () => {
  const { lazy } = await import('react')
  const { Link } = await import('react-router')
  const Page = (label: string) =>
    lazy(async () => ({
      default: () => (
        <div data-testid="plugin-page">
          {label}
          <Link to="/fixture/shell">to shell</Link>
        </div>
      ),
    }))
  const uiPlugins = [
    {
      shared: { id: 'fixture' },
      nav: [],
      homeLinks: [],
      routes: [
        { path: '/fixture/editor', tier: 'workspace', Component: Page('editor') },
        {
          path: '/fixture/guarded',
          tier: 'workspace',
          guard: 'admin',
          Component: Page('guarded'),
        },
        { path: '/fixture/shell', Component: Page('shell') },
      ],
    },
  ]
  return { uiPlugins, UI_PLUGINS: uiPlugins }
})
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

const topBar = () => screen.getByRole('banner')
const sideNav = () => document.querySelector('aside') as HTMLElement
const collapseToggle = () => screen.queryByRole('button', { name: /(Collapse|Expand) navigation/ })

describe('workspace plugin routes', () => {
  afterEach(() => {
    queryClient.clear()
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('renders the page inside Layout, under the real top bar, with no padding', async () => {
    open('/fixture/editor', makeSession())
    const page = await screen.findByTestId('plugin-page')
    expect(page).toHaveTextContent('editor')
    expect(topBar()).toBeInTheDocument()
    expect(document.querySelector('main')).toContainElement(page)
    expect(document.querySelector('main')).not.toHaveClass('p-4')
    expect(document.querySelector('.drawer-content')).toHaveClass('h-dvh')
  })

  it('collapses the nav to its rail without touching the saved preference', async () => {
    localStorage.setItem('sideNavCollapsed', 'false')
    open('/fixture/editor', makeSession())
    await screen.findByTestId('plugin-page')
    expect(sideNav()).toHaveClass('w-16')
    expect(collapseToggle()).not.toBeInTheDocument()
    expect(localStorage.getItem('sideNavCollapsed')).toBe('false')
  })

  it('returns to the saved state on leaving', async () => {
    localStorage.setItem('sideNavCollapsed', 'false')
    open('/fixture/editor', makeSession())
    await screen.findByTestId('plugin-page')
    await userEvent.click(screen.getByRole('link', { name: 'to shell' }))
    await waitFor(() => expect(screen.getByTestId('plugin-page')).toHaveTextContent('shell'))
    expect(sideNav()).toHaveClass('w-56')
    expect(collapseToggle()).toBeInTheDocument()
    expect(localStorage.getItem('sideNavCollapsed')).toBe('false')
  })

  it('leaves the drawer on its saved state below lg', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
    try {
      open('/fixture/editor', makeSession())
      await screen.findByTestId('plugin-page')
      expect(sideNav()).toHaveClass('w-56')
    } finally {
      window.matchMedia = original
    }
  })

  it('leaves a normal shell route as it was', async () => {
    open('/fixture/shell', makeSession())
    await screen.findByTestId('plugin-page')
    expect(topBar()).toBeInTheDocument()
    expect(document.querySelector('main')).toHaveClass('p-4')
    expect(document.querySelector('.drawer-content')).toHaveClass('min-h-screen')
    expect(sideNav()).toHaveClass('w-56')
    expect(collapseToggle()).toBeInTheDocument()
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

  it('honours the guard: an admin opens the page inside Layout', async () => {
    open('/fixture/guarded', makeSession({ tenant: makeTenant({ role: 'admin' }) }))
    expect(await screen.findByTestId('plugin-page')).toHaveTextContent('guarded')
    expect(topBar()).toBeInTheDocument()
  })
})

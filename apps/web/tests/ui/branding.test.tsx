import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { BrandFavicon } from '@/ui/components/BrandFavicon'
import { queryKeys } from '@/ui/lib/query-keys'
import Login from '@/ui/pages/Login'
import { renderWithProviders, stubFetch } from './helpers/renderWithProviders'

const METHODS = { magicLink: true, providers: [], devLogin: false }
const HEALTH = { status: 'ok', version: '1.2.3', env: 'production' }

function renderSignIn(branding: Record<string, unknown> = {}) {
  stubFetch({
    '/auth/methods': METHODS,
    '/api/health': { ...HEALTH, ...branding },
  })
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<Login />} />
    </Routes>,
    { route: '/login', session: null }
  )
}

describe('the sign-in panel follows the deployment', () => {
  it("sets the deployment's name and tagline large when it asks for the type panel", async () => {
    renderSignIn({ name: 'Front Desk', tagline: 'Rooms, guests, done.', loginPanelArt: 'type' })
    await waitFor(() => expect(screen.getByText('Rooms, guests, done.')).toBeInTheDocument())
    expect(screen.getByTestId('login-panel')).toHaveAttribute('data-art', 'type')
    expect(screen.getAllByText('Front Desk')).toHaveLength(2)
  })

  it('keeps the bundled drawing when the deployment says nothing', async () => {
    renderSignIn({ name: 'Front Desk' })
    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument())
    expect(screen.getByTestId('login-panel')).toHaveAttribute('data-art', 'rocket')
  })

  it('ignores a branding value it cannot use and keeps the rest of the answer', async () => {
    renderSignIn({ name: 'Front Desk', tagline: 'Kept.', loginPanelArt: 'photo' })
    await waitFor(() => expect(screen.getByText('Front Desk')).toBeInTheDocument())
    expect(screen.getByTestId('login-panel')).toHaveAttribute('data-art', 'rocket')
  })
})

describe('the mark follows the deployment', () => {
  it("shows the deployment's logo in place of the bundled mark", async () => {
    const { container } = renderSignIn({ logoUrl: 'https://cdn.example.com/mark.svg' })
    await waitFor(() =>
      expect(container.querySelector('img[src="https://cdn.example.com/mark.svg"]')).not.toBeNull()
    )
    expect(container.querySelector('svg[viewBox="0 0 512 512"]')).toBeNull()
  })

  it('draws the bundled mark until a logo is known, and again if it fails to load', async () => {
    const { container } = renderSignIn({ logoUrl: '/brand/missing.svg' })
    expect(container.querySelector('svg[viewBox="0 0 512 512"]')).not.toBeNull()
    await waitFor(() =>
      expect(container.querySelector('img[src="/brand/missing.svg"]')).not.toBeNull()
    )
    fireEvent.error(container.querySelector('img[src="/brand/missing.svg"]') as HTMLImageElement)
    expect(container.querySelector('img[src="/brand/missing.svg"]')).toBeNull()
    expect(container.querySelector('svg[viewBox="0 0 512 512"]')).not.toBeNull()
  })
})

describe('the tab icon follows the deployment', () => {
  const icons = () => [...document.head.querySelectorAll('link[rel~="icon"]')]
  const bundle = () => {
    const link = document.createElement('link')
    link.setAttribute('rel', 'icon')
    link.setAttribute('type', 'image/svg+xml')
    link.setAttribute('href', '/favicon.svg')
    document.head.appendChild(link)
  }
  afterEach(() => {
    for (const link of icons()) link.remove()
  })

  it("points the page's one icon at the deployment's favicon, whatever its format", async () => {
    bundle()
    stubFetch({ '/api/health': { ...HEALTH, faviconUrl: 'https://cdn.example.com/icon.png' } })
    renderWithProviders(<BrandFavicon />, { session: null })
    await waitFor(() =>
      expect(icons().map(link => link.getAttribute('href'))).toEqual([
        'https://cdn.example.com/icon.png',
      ])
    )
    expect(icons()[0]).not.toHaveAttribute('type')
  })

  it('leaves the bundled icon alone when none is configured', async () => {
    bundle()
    stubFetch({ '/api/health': { ...HEALTH, name: 'Front Desk' } })
    const { queryClient } = renderWithProviders(<BrandFavicon />, { session: null })
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.appInfo.all)).toBeDefined())
    expect(icons().map(link => link.getAttribute('href'))).toEqual(['/favicon.svg'])
    expect(icons()[0]).toHaveAttribute('type', 'image/svg+xml')
  })
})

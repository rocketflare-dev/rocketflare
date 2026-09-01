import { HomeIcon } from '@heroicons/react/24/outline'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SideNav, { filterNavConfig, isPathActive, type NavConfig } from '@/ui/components/SideNav'
import type { NavGuard } from '@/ui/hooks/useNavGuard'
import { renderWithProviders, stubHealthFetch } from './helpers/renderWithProviders'

const guardMock = vi.fn<(guard: NavGuard | undefined) => boolean>(() => true)
vi.mock('@/ui/hooks/useNavGuard', async importOriginal => {
  const mod = await importOriginal<typeof import('@/ui/hooks/useNavGuard')>()
  return { ...mod, useNavGuard: () => guardMock }
})

const config: NavConfig = [
  { items: [{ to: '/', label: 'Home', icon: HomeIcon }] },
  {
    label: 'Organisation',
    items: [{ to: '/settings', label: 'Settings', icon: HomeIcon, guard: 'admin' }],
  },
  {
    label: 'Platform',
    items: [{ to: '/admin', label: 'Admin', icon: HomeIcon, guard: 'globalAdmin' }],
  },
  {
    to: '/reports',
    label: 'Reports',
    icon: HomeIcon,
    guard: { action: 'read', subject: 'Report' },
  },
]

describe('filterNavConfig', () => {
  it('drops guarded items and empties groups', () => {
    const visible = filterNavConfig(config, guard => guard === undefined || guard === 'admin')
    const labels = visible
      .flatMap(item => ('items' in item ? item.items : [item]))
      .map(i => i.label)
    expect(labels).toEqual(['Home', 'Settings'])
    // The Platform group vanished entirely rather than rendering an empty heading
    expect(visible.some(item => 'label' in item && item.label === 'Platform')).toBe(false)
  })
})

describe('isPathActive', () => {
  it('matches "/" exactly and other paths by segment', () => {
    expect(isPathActive('/', '/')).toBe(true)
    expect(isPathActive('/settings', '/')).toBe(false)
    expect(isPathActive('/settings/people', '/settings')).toBe(true)
    expect(isPathActive('/settingsx', '/settings')).toBe(false)
  })
})

describe('SideNav', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    guardMock.mockReset()
    guardMock.mockImplementation(() => true)
  })

  it('shows everything when the guard allows all (Phase 0 default)', async () => {
    vi.stubGlobal('fetch', stubHealthFetch())
    renderWithProviders(<SideNav items={config} />)

    expect(screen.getByRole('link', { name: /^Home/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Settings/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Admin/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Reports/ })).toBeInTheDocument()
    // The version footer comes from /api/health
    await waitFor(() => expect(screen.getByText('v1.2.3')).toBeInTheDocument())
  })

  it('hides items whose guard is denied', () => {
    vi.stubGlobal('fetch', stubHealthFetch())
    guardMock.mockImplementation(guard => guard === undefined)
    renderWithProviders(<SideNav items={config} />, { route: '/settings/people' })

    expect(screen.getByRole('link', { name: /^Home/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Settings/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Admin/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Reports/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Platform')).not.toBeInTheDocument()
  })

  it('marks the current section active', () => {
    vi.stubGlobal('fetch', stubHealthFetch())
    renderWithProviders(<SideNav items={config} />, { route: '/settings/people' })
    expect(screen.getByRole('link', { name: /Settings/ })).toHaveAttribute('data-active', 'true')
    expect(screen.getByRole('link', { name: /^Home/ })).toHaveAttribute('data-active', 'false')
  })

  it('persists the collapsed preference', () => {
    vi.stubGlobal('fetch', stubHealthFetch())
    renderWithProviders(<SideNav items={config} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }))
    expect(localStorage.getItem('sideNavCollapsed')).toBe('true')
  })
})

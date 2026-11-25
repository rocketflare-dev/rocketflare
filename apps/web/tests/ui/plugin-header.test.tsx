/**
 * `UiPlugin.header` — plugin items in the app's top bar. The slot through the REAL `useNavGuard`
 * (a guard that fails hides the item, a feature guard hides it from a global admin too), each item
 * isolated (a throw and a slow chunk cost only that item), the order deterministic, and the whole
 * path through `App.tsx` and the real `Layout`: a `center` item lands in the banner's middle and an
 * `end` item ahead of the kit's own widgets.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import { lazy } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHeaderItem } from '@/plugins/types'
import App from '@/ui/App'
import { PluginHeaderSlot, pluginHeaderItems } from '@/ui/components/PluginHeaderSlot'
import { queryClient } from '@/ui/lib/queryClient'
import {
  makeSession,
  makeTenant,
  makeUser,
  renderWithProviders,
  rulesFor,
  stubFetch,
  stubSessionFetch,
} from './helpers/renderWithProviders'

vi.mock('@/plugins/ui', async () => {
  const { lazy } = await import('react')
  const item = (label: string) =>
    lazy(async () => ({ default: () => <button type="button">{label}</button> }))
  const uiPlugins = [
    {
      shared: { id: 'fixture' },
      routes: [],
      header: [
        { id: 'search', placement: 'center', Component: item('Fixture search') },
        { id: 'help', Component: item('Fixture help') },
      ],
    },
  ]
  return { uiPlugins, UI_PLUGINS: uiPlugins }
})
vi.mock('@/ui/components/WebSocketProvider', () => ({
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/ui/pages/Home', () => ({ default: () => <div data-testid="home" /> }))

const button = (label: string) =>
  lazy(async () => ({ default: () => <button type="button">{label}</button> }))

const plugin = (id: string, header: PluginHeaderItem[]) => ({ shared: { id, label: id }, header })

afterEach(() => {
  queryClient.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('pluginHeaderItems', () => {
  it('orders by order, then plugin id, then item id, and filters by placement', () => {
    const C = button('x')
    const items = pluginHeaderItems(
      [
        plugin('zeta', [
          { id: 'a', Component: C },
          { id: 'centre', Component: C, placement: 'center' },
        ]),
        plugin('alpha', [
          { id: 'b', Component: C },
          { id: 'a', Component: C },
          { id: 'first', Component: C, order: -1 },
        ]),
      ],
      'end'
    )
    expect(items.map(i => i.key)).toEqual(['alpha:first', 'alpha:a', 'alpha:b', 'zeta:a'])
    expect(
      pluginHeaderItems(
        [plugin('zeta', [{ id: 'c', Component: C, placement: 'center' }])],
        'center'
      )
    ).toHaveLength(1)
  })
})

describe('PluginHeaderSlot', () => {
  it('renders an item, and hides one whose guard fails', async () => {
    const member = makeSession({ tenant: makeTenant({ role: 'member' }) })
    renderWithProviders(
      <PluginHeaderSlot
        placement="end"
        plugins={[
          plugin('fixture', [
            { id: 'open', Component: button('Open item') },
            { id: 'admin', guard: 'admin', Component: button('Admin item') },
          ]),
        ]}
      />,
      { session: member }
    )
    expect(await screen.findByRole('button', { name: 'Open item' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Admin item' })).not.toBeInTheDocument()
  })

  it('hides a feature-guarded item from a global admin while the flag is off', async () => {
    const user = makeUser({ isGlobalAdmin: true })
    renderWithProviders(
      <PluginHeaderSlot
        placement="end"
        plugins={[
          plugin('fixture', [
            { id: 'flag', guard: { feature: 'fixture' }, Component: button('Flagged item') },
            { id: 'open', Component: button('Open item') },
          ]),
        ]}
      />,
      { session: makeSession({ user, permissions: rulesFor('owner', true, []), features: [] }) }
    )
    expect(await screen.findByRole('button', { name: 'Open item' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Flagged item' })).not.toBeInTheDocument()
  })

  it('isolates an item that throws: its neighbours still render', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Broken = lazy(async () => ({
      default: () => {
        throw new Error('header item exploded')
      },
    }))
    renderWithProviders(
      <div>
        <PluginHeaderSlot
          placement="end"
          plugins={[
            plugin('broken', [{ id: 'boom', Component: Broken }]),
            plugin('fine', [{ id: 'ok', Component: button('Still here') }]),
          ]}
        />
        <p>Shell content</p>
      </div>
    )
    expect(await screen.findByRole('button', { name: 'Still here' })).toBeInTheDocument()
    expect(screen.getByText('Shell content')).toBeInTheDocument()
    await waitFor(() =>
      expect(error.mock.calls.some(c => String(c[0]).includes('broken:boom'))).toBe(true)
    )
  })

  it('isolates an item whose chunk never loads', async () => {
    const Pending = lazy(() => new Promise<{ default: () => null }>(() => {}))
    renderWithProviders(
      <PluginHeaderSlot
        placement="end"
        plugins={[
          plugin('slow', [{ id: 'never', Component: Pending }]),
          plugin('quick', [{ id: 'ok', Component: button('Loaded') }]),
        ]}
      />
    )
    expect(await screen.findByRole('button', { name: 'Loaded' })).toBeInTheDocument()
  })
})

describe('the shell', () => {
  it('renders plugin header items inside the real top bar', async () => {
    window.history.pushState({}, '', '/')
    stubFetch()
    stubSessionFetch(makeSession())
    render(<App />)
    const banner = await screen.findByRole('banner')
    const search = await within(banner).findByRole('button', { name: 'Fixture search' })
    const help = await within(banner).findByRole('button', { name: 'Fixture help' })
    expect(search.closest('[data-plugin-header="center"]')).not.toBeNull()
    expect(help.closest('[data-plugin-header="end"]')).not.toBeNull()
    // The `end` items come before the kit's own widgets.
    const menu = within(banner).getAllByRole('button').at(-1) as HTMLElement
    expect(help.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
